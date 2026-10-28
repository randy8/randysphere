/**
 * pnpm measure — the lab measurements behind /system's performance
 * section, taken against production and appended to status/perf.json
 * (last 90 runs). Run weekly by photography-measure.timer and by hand;
 * never by viewing the page, never in a deploy (it takes ~10 minutes).
 *
 * Each metric is the median of RUNS runs:
 * - Lighthouse 12.6.0, mobile and desktop presets, on /exposures/;
 * - a real throttled phone (the configuration the 2026-10-26 performance
 *   work was measured in): /exposures/ cold and on refresh — FCP, LCP, CLS,
 *   the first screen's photographs loaded — plus JavaScript bytes and
 *   requests on the cold load;
 * - Exhibition's time to its first photograph on that phone.
 *
 * Every run carries its `config` and a `version`; /system never draws a
 * trend across a change in either. Bump VERSION when any of it changes.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { append, ROOT } from './status-store.ts';

const run = promisify(execFile);
const BASE = (process.env['MEASURE_BASE'] ?? 'https://randyliang.net').replace(/\/$/, '');
const RUNS = 3;
export const VERSION = 'measure-1';
export const PERF_KEPT = 90;

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  network: { latencyMs: 150, downloadKbps: 1600, uploadKbps: 750 },
  cpuSlowdown: 4,
};

const median = (values: readonly (number | null)[]): number | null => {
  const sorted = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  return sorted.length === 0 ? null : (sorted[Math.floor(sorted.length / 2)] ?? null);
};

const medians = <T extends Record<string, number | null>>(
  samples: readonly T[],
): Record<keyof T, number | null> | null => {
  const first = samples[0];
  if (first === undefined) return null;
  return Object.fromEntries(
    Object.keys(first).map((key) => [key, median(samples.map((s) => s[key] ?? null))]),
  ) as Record<keyof T, number | null>;
};

async function lighthouse(
  preset: 'mobile' | 'desktop',
): Promise<Record<string, number | null> | null> {
  const cli = join(ROOT, 'tools', 'qa', 'node_modules', 'lighthouse', 'cli', 'index.js');
  const samples: Record<string, number | null>[] = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const { stdout } = await run(
        process.execPath,
        [
          cli,
          `${BASE}/exposures/`,
          '--output=json',
          '--output-path=stdout',
          '--quiet',
          '--only-categories=performance,accessibility,best-practices,seo',
          '--chrome-flags=--headless=new --no-sandbox',
          ...(preset === 'desktop' ? ['--preset=desktop'] : []),
        ],
        {
          env: { ...process.env, CHROME_PATH: chromium.executablePath() },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      const report = JSON.parse(stdout) as {
        categories: Record<string, { score: number | null }>;
        audits: Record<string, { numericValue?: number; details?: { items?: unknown[] } }>;
      };
      const score = (id: string): number | null => {
        const value = report.categories[id]?.score;
        return typeof value === 'number' ? Math.round(value * 100) : null;
      };
      const audit = (id: string): number | null => report.audits[id]?.numericValue ?? null;
      samples.push({
        performance: score('performance'),
        accessibility: score('accessibility'),
        bestPractices: score('best-practices'),
        seo: score('seo'),
        lcpMs: audit('largest-contentful-paint'),
        cls: audit('cumulative-layout-shift'),
        tbtMs: audit('total-blocking-time'),
        totalKB: (audit('total-byte-weight') ?? NaN) / 1024,
        requests: report.audits['network-requests']?.details?.items?.length ?? null,
      });
    } catch (error) {
      console.error(
        `lighthouse ${preset} run ${String(i + 1)} failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    }
  }
  return medians(samples);
}

function observe(): void {
  const w = window as unknown as {
    __m: { lcp: number; cls: number; fcp: number; firstPhoto: number | null };
  };
  w.__m = { lcp: 0, cls: 0, fcp: 0, firstPhoto: null };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__m.lcp = e.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
    })[]) {
      if (!e.hadRecentInput) w.__m.cls += e.value;
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      if (e.name === 'first-contentful-paint') w.__m.fcp = e.startTime;
  }).observe({ type: 'paint', buffered: true });
  // Exhibition: the first frame a photograph layer is visible at all.
  const watch = (t: number): void => {
    if (w.__m.firstPhoto !== null) return;
    const layer = Array.from(document.querySelectorAll<HTMLElement>('[data-layer]')).find(
      (l) => Number(getComputedStyle(l).opacity) > 0.01,
    );
    if (layer) w.__m.firstPhoto = t;
    else requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

async function phonePage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: PHONE.viewport,
    deviceScaleFactor: PHONE.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(observe);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: PHONE.network.latencyMs,
    downloadThroughput: (PHONE.network.downloadKbps * 1000) / 8,
    uploadThroughput: (PHONE.network.uploadKbps * 1000) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: PHONE.cpuSlowdown });
  return { page, close: () => browser.close() };
}

const readPage = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as { __m: { lcp: number; cls: number; fcp: number } }).__m;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const firstScreen = Array.from(document.querySelectorAll<HTMLImageElement>('[data-grid] img'))
      .filter((img) => img.loading === 'eager')
      .map(
        (img) =>
          (performance.getEntriesByName(img.currentSrc)[0] as PerformanceResourceTiming | undefined)
            ?.responseEnd ?? NaN,
      );
    return {
      fcpMs: m.fcp,
      lcpMs: m.lcp,
      cls: m.cls,
      firstScreenMs: firstScreen.length > 0 ? Math.max(...firstScreen) : null,
      jsKB:
        resources
          .filter((r) => /\.m?js(\?|$)/.test(r.name))
          .reduce((sum, r) => sum + r.transferSize, 0) / 1024,
      requests: resources.length + 1,
    };
  });

async function phone() {
  const cold: Record<string, number | null>[] = [];
  const refresh: Record<string, number | null>[] = [];
  for (let i = 0; i < RUNS; i++) {
    const { page, close } = await phonePage();
    try {
      await page.goto(`${BASE}/exposures/`, { waitUntil: 'load', timeout: 120_000 });
      await page.waitForTimeout(2500); // let LCP and late shifts settle
      cold.push(await readPage(page));
      await page.reload({ waitUntil: 'load', timeout: 120_000 });
      await page.waitForTimeout(2500);
      const { jsKB: _js, requests: _requests, ...rest } = await readPage(page);
      refresh.push(rest);
    } catch (error) {
      console.error(
        `phone run ${String(i + 1)} failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    } finally {
      await close();
    }
  }
  return { cold: medians(cold), refresh: medians(refresh) };
}

async function exhibition(): Promise<number | null> {
  const samples: (number | null)[] = [];
  for (let i = 0; i < RUNS; i++) {
    const { page, close } = await phonePage();
    try {
      await page.goto(`${BASE}/exposures/gallery/`, { waitUntil: 'commit', timeout: 120_000 });
      await page.waitForFunction(
        () => (window as unknown as { __m: { firstPhoto: number | null } }).__m.firstPhoto !== null,
        null,
        { timeout: 60_000 },
      );
      samples.push(
        await page.evaluate(
          () => (window as unknown as { __m: { firstPhoto: number } }).__m.firstPhoto,
        ),
      );
    } catch (error) {
      console.error(
        `exhibition run ${String(i + 1)} failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    } finally {
      await close();
    }
  }
  return median(samples);
}

async function productionCommit(): Promise<string | null> {
  try {
    const health = (await (await fetch(`${BASE}/healthz`)).json()) as {
      release?: { commit?: string };
    };
    return health.release?.commit?.replace(/-dirty$/, '') ?? null;
  } catch {
    return null;
  }
}

const browser = await chromium.launch();
const chromiumVersion = browser.version();
await browser.close();
const commit = await productionCommit();
console.log(`measuring ${BASE} (${commit ?? 'unknown commit'}), ${String(RUNS)} runs each…`);
const entry = {
  at: new Date().toISOString(),
  commit,
  version: VERSION,
  config: {
    page: '/exposures/',
    runs: RUNS,
    lighthouse: '12.6.0',
    chromium: chromiumVersion,
    phone: PHONE,
  },
  lighthouse: { mobile: await lighthouse('mobile'), desktop: await lighthouse('desktop') },
  phone: await phone(),
  exhibition: { firstPhotoMs: await exhibition() },
};
append('perf.json', entry, PERF_KEPT);
console.log(JSON.stringify(entry, null, 2));
