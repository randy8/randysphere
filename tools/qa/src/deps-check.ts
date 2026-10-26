/**
 * Proves the installed dependencies actually load — what `pnpm install
 * --frozen-lockfile` can't: on 2026-10-26 pnpm reported "Already up to
 * date" while 113 packages (tslib among them) were missing from disk, and
 * Lighthouse failed only later, inside the weekly measurement. Run by
 * deploy/deploy.sh right after the install; exits non-zero, naming each
 * failure, if anything can't be loaded.
 *
 * For every workspace package, each dependency it declares is imported
 * from that package's own directory in a fresh Node process (so a package
 * missing deep in a dependency's own tree fails here, as it would in use).
 * Plus the two things the jobs reach by path rather than import:
 * Lighthouse's CLI entry point, and Playwright's browser.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES = ['.', 'site', 'tools/films', 'tools/pipeline', 'tools/qa', 'tools/serve'];

const failures: string[] = [];
const started = performance.now();

await Promise.all(
  PACKAGES.map(async (dir) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Type-only packages have nothing to load.
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
      (name) => !name.startsWith('@types/'),
    );
    const script = `
      const failed = [];
      for (const name of ${JSON.stringify(names)}) {
        try { await import(name); } catch (error) { failed.push(name + ': ' + String(error.message).split('\\n')[0]); }
      }
      if (failed.length > 0) { console.log(failed.join('\\n')); process.exitCode = 1; }`;
    try {
      await run(process.execPath, ['--input-type=module', '-e', script], { cwd: join(ROOT, dir) });
    } catch (error) {
      const out = (error as { stdout?: string }).stdout?.trim() ?? String(error);
      for (const line of out.split('\n')) failures.push(`${dir}: ${line}`);
    }
  }),
);

const qa = join(ROOT, 'tools', 'qa');
try {
  await run(process.execPath, [
    join(qa, 'node_modules', 'lighthouse', 'cli', 'index.js'),
    '--version',
  ]);
} catch (error) {
  failures.push(
    `lighthouse CLI: ${
      String((error as { stderr?: string }).stderr ?? error)
        .trim()
        .split('\n')
        .find((line) => /^(\w*Error\b|Cannot find)/.test(line.trim()))
        ?.trim() ?? 'failed to start'
    }`,
  );
}
try {
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { chromium } from 'playwright-core'; console.log(chromium.executablePath())",
    ],
    { cwd: qa },
  );
  if (!existsSync(stdout.trim())) failures.push(`playwright: no browser at ${stdout.trim()}`);
} catch (error) {
  failures.push(`playwright: ${String(error).split('\n')[0]}`);
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(
    `Dependencies don't load (${String(failures.length)}):\n  ${failures.join('\n  ')}`,
  );
  console.error('Fix: pnpm install --frozen-lockfile --force');
  process.exitCode = 1;
} else {
  console.log(`every dependency loads (${seconds} s)`);
}
