/**
 * The shared frame for every browser test (`*.browser.ts`): one browser per
 * file, a fresh context per test, and on failure everything needed to see
 * what happened — a screenshot, a Playwright trace, the page's errors and
 * failed requests, and the command that reruns just that file — under
 * tools/qa/test-results/. Nothing retries: a failure is reported once, as
 * it happened.
 *
 * QA_BASE_URL names the site under test (browser-run.ts sets it: a local
 * build, the deploy's candidate, or production for read-only smoke checks).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright-core';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';

export const BASE = (process.env['QA_BASE_URL'] ?? 'http://127.0.0.1:4399').replace(/\/$/, '');
const ENGINE = process.env['QA_BROWSER'] ?? 'chromium';
const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-results');

export const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
};
export const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: ENGINE !== 'firefox',
  hasTouch: true,
};

let browser: Browser | null = null;
before(async () => {
  const engine = ENGINE === 'firefox' ? firefox : ENGINE === 'webkit' ? webkit : chromium;
  browser = await engine.launch();
});
after(async () => {
  await browser?.close();
});

export interface Session {
  readonly page: Page;
  readonly context: BrowserContext;
  /** Uncaught exceptions and console errors so far. */
  readonly errors: string[];
}

interface Options extends BrowserContextOptions {
  /**
   * Replaces Math.random with a seeded generator, so a page that shuffles
   * (every photo page does) lays out the same way on every run.
   */
  readonly seed?: number;
  /** Errors a test expects (a deliberately failed request, say), matched by substring. */
  readonly allowErrors?: readonly string[];
}

/**
 * A browser test: `fn` gets a fresh page. The test also fails if the page
 * threw or logged an error, unless that error is listed in `allowErrors`.
 */
export function browserTest(
  name: string,
  fn: (session: Session, t: TestContext) => Promise<void>,
  options: Options = {},
): void {
  void test(name, async (t) => {
    if (browser === null) throw new Error('browser did not start');
    const { seed, allowErrors = [], ...contextOptions } = options;
    const context = await browser.newContext({ ...DESKTOP, ...contextOptions });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const errors: string[] = [];
    const failedRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
    });
    if (seed !== undefined) await page.addInitScript(seedRandom, seed);
    try {
      await fn({ page, context, errors }, t);
      const unexpected = errors.filter(
        (error) => !allowErrors.some((allowed) => error.includes(allowed)),
      );
      if (unexpected.length > 0)
        throw new Error(`the page reported errors:\n${unexpected.join('\n')}`);
      await context.tracing.stop();
    } catch (error) {
      const file = basename(process.argv[1] ?? 'unknown');
      const dir = join(RESULTS, `${file.replace(/\.browser\.ts$/, '')}--${slug(name)}`);
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, 'screenshot.png') }).catch(() => {});
      await context.tracing.stop({ path: join(dir, 'trace.zip') }).catch(() => {});
      writeFileSync(
        join(dir, 'report.txt'),
        [
          `test: ${name}`,
          `url: ${page.url()}`,
          `base: ${BASE} (${ENGINE})`,
          `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          `page errors:\n${errors.join('\n') || '(none)'}`,
          `failed requests:\n${failedRequests.join('\n') || '(none)'}`,
          `rerun: QA_BASE_URL=${BASE} QA_BROWSER=${ENGINE} node --test --test-name-pattern=${JSON.stringify(name)} tools/qa/src/browser/${file}`,
          `trace: npx playwright-core show-trace ${join(dir, 'trace.zip')}`,
        ].join('\n\n'),
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n  artifacts: ${dir}`,
        {
          cause: error,
        },
      );
    } finally {
      await context.close();
    }
  });
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Runs in the page: mulberry32, a tiny seeded PRNG. */
function seedRandom(seed: number): void {
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Photo {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly tags: readonly string[];
}

/**
 * The public photographs, as the Exhibition page carries them. Tests choose
 * their subjects from this rather than hard-coding ids, so they keep
 * working as the archive changes.
 */
export async function publicPhotos(): Promise<readonly Photo[]> {
  const html = await (await fetch(`${BASE}/exposures/exhibition/`)).text();
  const json = /data-exhibition-photos[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (json === undefined) throw new Error('no exhibition payload on /exposures/exhibition/');
  return (JSON.parse(json) as { photos: Photo[] }).photos;
}

/** The tag with the most orientation changes in sequence — the hardest case for Exhibition. */
export async function mixedTag(): Promise<string> {
  const photos = await publicPhotos();
  const byTag = new Map<string, Photo[]>();
  for (const photo of photos)
    for (const tag of photo.tags) byTag.set(tag, [...(byTag.get(tag) ?? []), photo]);
  let best: [string, number] = ['', -1];
  for (const [tag, list] of byTag) {
    let changes = 0;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      if (a.width >= a.height !== b.width >= b.height) changes++;
    }
    if (changes > best[1]) best = [tag, changes];
  }
  if (best[1] < 1) throw new Error('no tag mixes portrait and landscape photographs');
  return best[0];
}
