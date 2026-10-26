/**
 * pnpm test:browser — runs the browser tests (src/browser/*.browser.ts).
 *
 *   pnpm test:browser                  smoke + the areas this change needs (risk.ts)
 *   pnpm test:browser exhibition       smoke + named areas
 *   pnpm test:browser --all            everything
 *   pnpm test:browser --smoke          the smoke suite alone
 *   --changed=<ref>                    diff against <ref> (default: the live release's commit)
 *   --base=<url>                       test that site instead of a local build
 *   --browser=firefox|webkit           another engine (default chromium)
 *   --report=<file.json>               also write the outcome, for /system
 *
 * Without --base it builds the site (unless the last build is newer than
 * every source) and serves it with tools/serve on :4399 — the same server
 * production runs. The smoke suite always runs: risk selection only ever
 * adds to it.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import { AREAS, classify, type Area } from './risk.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BROWSER_DIR = join(ROOT, 'tools', 'qa', 'src', 'browser');
const LOCAL_DIST = join(ROOT, 'site', 'node_modules', '.cache', 'verify-dist');
const LOCAL_PORT = 4399;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const named = args.filter((arg) => !arg.startsWith('--'));
for (const area of named) {
  if (!(AREAS as readonly string[]).includes(area)) {
    console.error(`unknown area "${area}" — one of: ${AREAS.join(', ')}`);
    process.exit(2);
  }
}

function git(...gitArgs: string[]): string {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** The commit production is serving, from the release's own build-info.json. */
function liveCommit(): string | null {
  try {
    const info = JSON.parse(
      readFileSync(join(ROOT, 'site', 'release', 'build-info.json'), 'utf8'),
    ) as { commit?: string };
    return info.commit?.replace(/-dirty$/, '') ?? null;
  } catch {
    return null;
  }
}

function changedPaths(ref: string): string[] {
  const committed = git('diff', '--name-only', `${ref}...HEAD`).split('\n');
  const working = git('status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .map((line) => line.slice(3).replace(/^.* -> /, ''));
  return [...new Set([...committed, ...working])].filter(
    (path) => path !== '' && !path.startsWith('filebrowser/'),
  );
}

let areas: readonly Area[];
if (args.includes('--smoke')) {
  areas = [];
  console.log('areas: none beyond smoke (--smoke)');
} else if (args.includes('--all')) {
  areas = AREAS;
  console.log('areas: all (--all)');
} else if (named.length > 0) {
  areas = named as Area[];
  console.log(`areas: ${areas.join(', ')} (named)`);
} else {
  const ref = flag('changed') ?? liveCommit() ?? 'origin/main';
  const paths = changedPaths(ref);
  const result = classify(paths);
  areas = result.areas;
  console.log(`changes since ${ref}: ${String(paths.length)} path(s), risk ${result.risk}`);
  for (const reason of result.reasons) console.log(`  ${reason}`);
  console.log(`areas: ${areas.length > 0 ? areas.join(', ') : 'none beyond smoke'}`);
}

const files = ['smoke', ...areas]
  .map((name) => join(BROWSER_DIR, `${name}.browser.ts`))
  .filter((file) => {
    if (existsSync(file)) return true;
    console.log(`  (no ${file.split('/').pop() ?? ''} yet — smoke covers that area)`);
    return false;
  });

/** Newest modification time under a directory, ignoring caches and build output. */
function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name.startsWith('.') ||
      entry.name.startsWith('release') ||
      entry.name.startsWith('dist')
    )
      continue;
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${url} never answered`);
}

let server: ReturnType<typeof spawn> | null = null;
let base = flag('base');
if (base === undefined) {
  const built = existsSync(join(LOCAL_DIST, 'index.html'))
    ? statSync(join(LOCAL_DIST, 'index.html')).mtimeMs
    : 0;
  const sources = Math.max(
    ...['site', 'albums', join('generated', 'albums')].map((dir) => newest(join(ROOT, dir))),
  );
  if (built < sources) {
    console.log('building the site…');
    execFileSync(
      'pnpm',
      ['--filter', '@photo/site', 'exec', 'astro', 'build', '--outDir', LOCAL_DIST],
      {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
  }
  server = spawn(
    'node',
    ['tools/serve/src/cli.ts', '--preview', `--port=${String(LOCAL_PORT)}`, `--dist=${LOCAL_DIST}`],
    {
      cwd: ROOT,
      stdio: 'ignore',
    },
  );
  base = `http://127.0.0.1:${String(LOCAL_PORT)}`;
  await waitFor(`${base}/healthz`);
}

const browser = flag('browser') ?? 'chromium';
process.env['QA_BASE_URL'] = base;
process.env['QA_BROWSER'] = browser;
console.log(
  `testing ${base} in ${browser}: ${files.map((file) => file.split('/').pop() ?? '').join(', ')}\n`,
);

const started = Date.now();
const outcome = { passed: 0, failed: 0, skipped: 0, failures: [] as string[] };
const stream = run({ files, concurrency: Math.min(files.length, 3) });
stream.on('test:pass', (event) => {
  if (event.details.type === 'suite' || event.nesting > 0) return;
  if (event.skip) outcome.skipped++;
  else outcome.passed++;
});
stream.on('test:fail', (event) => {
  // A file that crashes outside any test is reported as a failure named
  // after the file — counted like any other, so it can never pass quietly.
  if (event.details.type === 'suite' || event.nesting > 0) return;
  outcome.failed++;
  outcome.failures.push(event.name);
});
stream.compose(spec).pipe(process.stdout);
await new Promise((done) => stream.on('end', done));
server?.kill();

const seconds = (Date.now() - started) / 1000;
// Zero tests passing is a failure too: a gate that ran nothing proved nothing.
const ok = outcome.failed === 0 && outcome.passed > 0;
console.log(
  `\n${ok ? 'passed' : 'FAILED'}: ${String(outcome.passed)} passed, ${String(outcome.failed)} failed in ${seconds.toFixed(1)} s`,
);

const reportPath = flag('report');
if (reportPath !== undefined) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    finishedAt: new Date().toISOString(),
    browser,
    areas,
    files: files.map((file) => file.split('/').pop()),
    passed: outcome.passed,
    failed: outcome.failed,
    skipped: outcome.skipped,
    failures: outcome.failures,
    seconds: Math.round(seconds * 10) / 10,
    ok,
  };
  writeFileSync(`${reportPath}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(`${reportPath}.tmp`, reportPath);
}
process.exitCode = ok ? 0 : 1;
