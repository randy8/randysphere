import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Health } from './health.ts';
import { judge, deploysOf, readStatus, renderSystem, watchdogOf } from './system.ts';
import type { StatusFiles } from './system.ts';

const NOW = new Date('2026-10-26T18:00:00Z');
const HEALTHY: Health = {
  ok: true,
  checks: { page: true, manifest: true, image: true },
  release: { commit: 'bbbbbbb', builtAt: '2026-10-26T17:00:00Z' },
};
const ok = (value: unknown) => ({ state: 'ok' as const, value });
const MISSING = { state: 'missing' as const };

const run = (passed: number, tests: { name: string; file: string; ok: boolean }[] = []) => ({
  passed,
  failed: tests.filter((t) => !t.ok).length,
  skipped: 0,
  seconds: 100,
  areas: ['gallery', 'exhibition'],
  risk: 'medium',
  tests,
});
const deploy = (commit: string, at: string, outcome = 'deployed', extra: object = {}) => ({
  at,
  commit,
  note: `Release ${commit}`,
  outcome,
  stage: outcome === 'deployed' ? 'deployed' : 'candidate browser checks',
  gate: run(50, [
    {
      name: 'rapid stepping never leaves two frames on the wall',
      file: 'exhibition.browser.ts',
      ok: true,
    },
  ]),
  production: run(15),
  ...extra,
});
const perfRun = (
  commit: string,
  at: string,
  performance: number,
  lcpMs: number,
  config: object = { runs: 3, lighthouse: '12.6.0' },
) => ({
  at,
  commit,
  version: 'measure-1',
  config,
  lighthouse: {
    mobile: {
      performance,
      accessibility: 100,
      bestPractices: 100,
      seo: 92,
      lcpMs: 3400,
      cls: 0.018,
      tbtMs: 0,
      totalKB: 540,
      requests: 33,
    },
    desktop: {
      performance: 98,
      accessibility: 100,
      bestPractices: 100,
      seo: 92,
      lcpMs: 1000,
      cls: 0.009,
      tbtMs: 0,
      totalKB: 700,
      requests: 42,
    },
  },
  phone: {
    cold: { fcpMs: 900, lcpMs, cls: 0.017, firstScreenMs: 9000, jsKB: 6.6, requests: 31 },
    refresh: { fcpMs: 280, lcpMs: 620, cls: 0, firstScreenMs: 400 },
  },
  exhibition: { firstPhotoMs: 2600 },
});

const COMPLETE: StatusFiles = {
  deploys: ok([
    deploy('aaaaaaa', '2026-10-26T12:00:00Z'),
    deploy('bbbbbbb', '2026-10-26T17:00:00Z'),
  ]),
  watchdog: ok({ at: '2026-10-26T17:59:00Z', origin: true, public: true }),
  perf: ok([
    perfRun('aaaaaaa', '2026-10-26T12:30:00Z', 88, 6000),
    perfRun('bbbbbbb', '2026-10-26T17:30:00Z', 95, 4000),
  ]),
};

test('complete data: operational, with every section filled from the records', () => {
  const html = renderSystem({ now: NOW, health: HEALTHY, files: COMPLETE });
  assert.match(html, /verdict-operational">Operational/);
  assert.match(html, /Serving<\/dt><dd>bbbbbbb/);
  assert.match(html, /aaaaaaa → bbbbbbb/);
  assert.match(
    html,
    /Lighthouse mobile performance<\/td><td class="n">88<\/td><td class="n">95<\/td><td class="change-better">↑ better/,
  );
  assert.match(
    html,
    /Phone LCP, cold<\/td><td class="n">6.00 s<\/td><td class="n">4.00 s<\/td><td class="change-better">/,
  );
  assert.match(
    html,
    /Lighthouse desktop performance<\/td><td class="n">98<\/td><td class="n">98<\/td><td class="change-unchanged">within noise/,
  );
  assert.match(html, /<svg class="spark"/);
  assert.match(html, /✓<\/span> rapid stepping never leaves two frames on the wall/);
  assert.match(html, /Firefox: not run\. WebKit \(Safari\): not run\./);
  assert.match(html, /Uptime<\/dt><dd>Not monitored/);
  assert.doesNotMatch(html, /stale/);
});

test('missing files: no data, an Unknown verdict, never an error', () => {
  const html = renderSystem({
    now: NOW,
    health: HEALTHY,
    files: { deploys: MISSING, watchdog: MISSING, perf: MISSING },
  });
  assert.match(html, /verdict-unknown">Unknown/);
  assert.match(html, /No deploys have been recorded yet/);
  assert.match(html, /Performance: no data yet/);
  assert.match(html, /Deployments: no data yet/);
});

test('malformed files are named as unreadable, and the rest still renders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'system-'));
  await writeFile(join(dir, 'perf.json'), '{ not json');
  await writeFile(
    join(dir, 'deploys.json'),
    JSON.stringify([deploy('aaaaaaa', '2026-10-26T12:00:00Z'), { junk: true }, 'nonsense']),
  );
  const files = await readStatus(dir);
  assert.equal(files.perf.state, 'malformed');
  assert.equal(files.watchdog.state, 'missing');
  assert.equal(
    deploysOf(files.deploys).length,
    1,
    'malformed entries are skipped, valid ones kept',
  );
  const html = renderSystem({ now: NOW, health: HEALTHY, files });
  assert.match(html, /Performance: the record could not be read/);
});

test('stale data is labelled stale and degrades the verdict', () => {
  const files: StatusFiles = {
    ...COMPLETE,
    watchdog: ok({ at: '2026-10-26T17:30:00Z', origin: true, public: true }),
    perf: ok([perfRun('bbbbbbb', '2026-10-10T12:00:00Z', 90, 5000)]),
  };
  const html = renderSystem({ now: NOW, health: HEALTHY, files });
  assert.match(html, /verdict-degraded">Degraded/);
  assert.match(html, /hasn’t reported for over 10 minutes|has not reported for over 10 minutes/);
  assert.match(html, /stale: older than 8 days/);
});

test('a failing live health check is an incident; a failed last deploy after the release is degraded', () => {
  assert.equal(
    judge(
      NOW,
      { ...HEALTHY, ok: false, checks: { page: true, manifest: true, image: false } },
      [],
      null,
    ).overall,
    'Incident',
  );
  const deploys = deploysOf(
    ok([
      deploy('bbbbbbb', '2026-10-26T17:00:00Z'),
      deploy('ccccccc', '2026-10-26T17:40:00Z', 'rolled-back'),
    ]),
  );
  const watchdog = watchdogOf(ok({ at: '2026-10-26T17:59:00Z', origin: true, public: true }));
  const verdict = judge(NOW, HEALTHY, deploys, watchdog);
  assert.equal(verdict.overall, 'Degraded');
  assert.match(verdict.reasons.join(), /rolled back/);
});

test('empty history: nothing to compare, nothing invented', () => {
  const html = renderSystem({
    now: NOW,
    health: HEALTHY,
    files: { deploys: ok([]), watchdog: MISSING, perf: ok([]) },
  });
  assert.match(html, /fewer than two deploys recorded/);
  assert.match(html, /Performance: no data yet/);
  assert.doesNotMatch(html, /<svg class="spark"/);
});

test('measurements from different setups are never compared, and trends break between them', () => {
  const files: StatusFiles = {
    ...COMPLETE,
    perf: ok([
      perfRun('aaaaaaa', '2026-10-26T12:30:00Z', 88, 6000, { runs: 3, lighthouse: '12.6.0' }),
      perfRun('bbbbbbb', '2026-10-26T17:30:00Z', 95, 4000, { runs: 5, lighthouse: '12.6.0' }),
    ]),
  };
  const html = renderSystem({ now: NOW, health: HEALTHY, files });
  assert.match(html, /the measuring setup changed between the two releases/);
  assert.match(html, /<line class="break"/);
  assert.doesNotMatch(html, /↑ better/);
});

test('nothing on the page names this machine, even if a record tries to', () => {
  const files: StatusFiles = {
    deploys: ok([
      deploy('aaaaaaa', '2026-10-26T12:00:00Z', 'deployed', {
        note: 'served from /home/randy/Development',
      }),
      deploy('bbbbbbb', '2026-10-26T17:00:00Z', 'deployed', {
        note: 'candidate on 127.0.0.1:4398',
        stage: 'localhost check',
        gate: run(1, [{ name: 'reads /etc/passwd', file: 'exhibition.browser.ts', ok: true }]),
      }),
    ]),
    watchdog: ok({
      at: '2026-10-26T17:59:00Z',
      origin: true,
      public: true,
      error: 'connect to 127.0.0.1:4322 failed',
    }),
    perf: COMPLETE.perf,
  };
  const html = renderSystem({ now: NOW, health: HEALTHY, files });
  for (const leak of [
    /\/home\//,
    /\/etc\//,
    /127\.0\.0\.1/,
    /:43\d\d/,
    /localhost/i,
    /Development/,
  ]) {
    assert.doesNotMatch(html, leak);
  }
});
