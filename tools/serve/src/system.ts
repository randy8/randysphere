/**
 * /system — the site's engineering health, read-only and public (unlisted,
 * not indexed). It reports what jobs already measured and never starts any
 * work of its own: the deploy writes status/deploys.json, the watchdog
 * status/watchdog.json, `pnpm measure` status/perf.json (tools/qa). The
 * one thing computed per request is the same in-process health check
 * /healthz runs — a few stat() calls.
 *
 * Honesty rules: a missing or malformed file is "No data", never an error
 * page and never a guess; old data is labelled stale, never shown as
 * current; trends break where the measuring setup changed; uptime is "Not
 * monitored" because every check runs on this same machine. Only
 * allowlisted fields are shown — no paths, hosts, ports or log text.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Health } from './health.ts';

// --- Reading -----------------------------------------------------------------

export type FileState<T> =
  { readonly state: 'ok'; readonly value: T } | { readonly state: 'missing' | 'malformed' };

async function readJson(path: string): Promise<FileState<unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { state: 'missing' };
  }
  try {
    return { state: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    return { state: 'malformed' };
  }
}

export interface StatusFiles {
  readonly deploys: FileState<unknown>;
  readonly watchdog: FileState<unknown>;
  readonly perf: FileState<unknown>;
}

export async function readStatus(statusDir: string): Promise<StatusFiles> {
  const [deploys, watchdog, perf] = await Promise.all(
    ['deploys.json', 'watchdog.json', 'perf.json'].map((name) => readJson(join(statusDir, name))),
  );
  return { deploys: deploys!, watchdog: watchdog!, perf: perf! };
}

// --- Validating (allowlist: only these fields, only these shapes) ---------------

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, max = 80): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
// Free text that reaches the page (a deploy's note and stage, test names)
// is dropped whole if it looks like it names this machine: a path, an
// address, a port. The recorder already trims notes; this doesn't rely on it.
const REVEALING =
  /(^|[\s(])\/(home|tmp|etc|var|usr|root)\/|\b\d{1,3}(\.\d{1,3}){3}\b|localhost|:\d{2,5}\b|\.env\b/i;
const safe = (value: string | null): string | null =>
  value === null || REVEALING.test(value) ? null : value;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const time = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const commitOf = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f]{4,12}$/.test(value.replace(/-dirty$/, ''))
    ? value.replace(/-dirty$/, '').slice(0, 7)
    : null;

export interface TestResult {
  readonly name: string;
  readonly file: string;
  readonly ok: boolean;
}
export interface Run {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly seconds: number | null;
  readonly areas: readonly string[];
  readonly risk: string | null;
  readonly tests: readonly TestResult[];
}
export interface Deploy {
  readonly at: Date;
  readonly commit: string;
  readonly note: string;
  readonly outcome: 'deployed' | 'blocked' | 'rolled-back';
  readonly stage: string;
  readonly gate: Run | null;
  readonly production: Run | null;
}

function runOf(value: unknown): Run | null {
  if (!isObj(value)) return null;
  const tests = Array.isArray(value['tests']) ? value['tests'] : [];
  return {
    passed: num(value['passed']) ?? 0,
    failed: num(value['failed']) ?? 0,
    skipped: num(value['skipped']) ?? 0,
    seconds: num(value['seconds']),
    areas: Array.isArray(value['areas'])
      ? value['areas'].filter((a): a is string => typeof a === 'string' && /^[a-z]+$/.test(a))
      : [],
    risk: safe(str(value['risk'], 24)),
    tests: tests.flatMap((test) =>
      isObj(test) &&
      typeof test['name'] === 'string' &&
      typeof test['file'] === 'string' &&
      /^[a-z]+\.browser\.ts$/.test(test['file'])
        ? [
            {
              name: safe(test['name'].slice(0, 140)) ?? '(name withheld)',
              file: test['file'],
              ok: test['ok'] === true,
            },
          ]
        : [],
    ),
  };
}

export function deploysOf(file: FileState<unknown>): Deploy[] {
  if (file.state !== 'ok' || !Array.isArray(file.value)) return [];
  return file.value.flatMap((entry) => {
    if (!isObj(entry)) return [];
    const at = time(entry['at']);
    const outcome = entry['outcome'];
    if (
      at === null ||
      (outcome !== 'deployed' && outcome !== 'blocked' && outcome !== 'rolled-back')
    )
      return [];
    return [
      {
        at,
        commit: commitOf(entry['commit']) ?? 'unknown',
        note: safe(str(entry['note'], 60)) ?? '',
        outcome,
        stage: safe(str(entry['stage'], 40)) ?? '',
        gate: runOf(entry['gate']),
        production: runOf(entry['production']),
      },
    ];
  });
}

export interface Watchdog {
  readonly at: Date;
  readonly origin: boolean;
  readonly public: boolean;
}

export function watchdogOf(file: FileState<unknown>): Watchdog | null {
  if (file.state !== 'ok' || !isObj(file.value)) return null;
  const at = time(file.value['at']);
  return at === null
    ? null
    : { at, origin: file.value['origin'] === true, public: file.value['public'] === true };
}

type Metrics = Readonly<Record<string, number | null>>;
export interface PerfRun {
  readonly at: Date;
  readonly commit: string | null;
  /** version + config, as one comparable key: runs with different keys are never compared or joined in a trend. */
  readonly setup: string;
  readonly version: string;
  readonly lighthouse: { readonly mobile: Metrics | null; readonly desktop: Metrics | null };
  readonly phone: { readonly cold: Metrics | null; readonly refresh: Metrics | null };
  readonly exhibitionFirstPhotoMs: number | null;
  readonly lighthouseVersion: string | null;
  readonly runs: number | null;
}

const metricsOf = (value: unknown): Metrics | null =>
  isObj(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, num(v)])) : null;

export function perfOf(file: FileState<unknown>): PerfRun[] {
  if (file.state !== 'ok' || !Array.isArray(file.value)) return [];
  return file.value.flatMap((entry) => {
    if (!isObj(entry)) return [];
    const at = time(entry['at']);
    const version = str(entry['version'], 24);
    if (at === null || version === null) return [];
    const config = isObj(entry['config']) ? entry['config'] : {};
    const lighthouse = isObj(entry['lighthouse']) ? entry['lighthouse'] : {};
    const phone = isObj(entry['phone']) ? entry['phone'] : {};
    const exhibition = isObj(entry['exhibition']) ? entry['exhibition'] : {};
    return [
      {
        at,
        commit: commitOf(entry['commit']),
        setup: `${version} ${JSON.stringify(config)}`,
        version,
        lighthouse: {
          mobile: metricsOf(lighthouse['mobile']),
          desktop: metricsOf(lighthouse['desktop']),
        },
        phone: { cold: metricsOf(phone['cold']), refresh: metricsOf(phone['refresh']) },
        exhibitionFirstPhotoMs: num(exhibition['firstPhotoMs']),
        lighthouseVersion: str(config['lighthouse'], 12),
        runs: num(config['runs']),
      },
    ];
  });
}

// --- Judging -----------------------------------------------------------------

export const WATCHDOG_STALE_MS = 10 * 60 * 1000;
export const PERF_STALE_MS = 8 * 24 * 60 * 60 * 1000;

export type Overall = 'Operational' | 'Degraded' | 'Incident' | 'Unknown';

export interface Verdict {
  readonly overall: Overall;
  readonly reasons: readonly string[];
}

/** The overall status, by the rules printed on the page. */
export function judge(
  now: Date,
  health: Health | null,
  deploys: readonly Deploy[],
  watchdog: Watchdog | null,
): Verdict {
  if (health === null)
    return { overall: 'Unknown', reasons: ['The live health check could not run.'] };
  if (!health.ok) {
    const failed = Object.entries(health.checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    return {
      overall: 'Incident',
      reasons: [`The live health check is failing (${failed.join(', ')}).`],
    };
  }
  if (deploys.length === 0)
    return { overall: 'Unknown', reasons: ['No deploys have been recorded yet.'] };
  const reasons: string[] = [];
  if (watchdog === null) reasons.push('The watchdog has not reported.');
  else if (now.getTime() - watchdog.at.getTime() > WATCHDOG_STALE_MS)
    reasons.push('The watchdog has not reported for over 10 minutes.');
  else {
    if (!watchdog.origin) reasons.push('The watchdog’s last check of the server failed.');
    if (!watchdog.public)
      reasons.push('The watchdog’s last check through the public address failed.');
  }
  const latest = deploys.at(-1);
  const builtAt = health.release ? new Date(health.release.builtAt) : null;
  if (latest && latest.outcome !== 'deployed' && (builtAt === null || latest.at > builtAt)) {
    reasons.push(
      latest.outcome === 'rolled-back'
        ? 'The latest deploy was rolled back; the previous release is serving.'
        : `The latest deploy was stopped (${latest.stage || 'a check failed'}); the previous release is serving.`,
    );
  }
  return reasons.length > 0
    ? { overall: 'Degraded', reasons }
    : { overall: 'Operational', reasons: [] };
}

interface Compared {
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly change: 'better' | 'worse' | 'unchanged';
}

interface MetricSpec {
  readonly label: string;
  readonly pick: (run: PerfRun) => number | null;
  readonly format: (value: number) => string;
  readonly higherIsBetter: boolean;
  /** Changes within this are measurement noise: absolute, or a fraction of the earlier value when `relative`. */
  readonly noise: number;
  readonly relative?: boolean;
}

const ms = (value: number): string => `${(value / 1000).toFixed(2)} s`;
const score = (value: number): string => String(Math.round(value));
const kb = (value: number): string => `${Math.round(value)} KB`;
const cls = (value: number): string => value.toFixed(3);

const COMPARED: readonly MetricSpec[] = [
  {
    label: 'Lighthouse mobile performance',
    pick: (r) => r.lighthouse.mobile?.['performance'] ?? null,
    format: score,
    higherIsBetter: true,
    noise: 5,
  },
  {
    label: 'Lighthouse desktop performance',
    pick: (r) => r.lighthouse.desktop?.['performance'] ?? null,
    format: score,
    higherIsBetter: true,
    noise: 5,
  },
  {
    label: 'Phone LCP, cold',
    pick: (r) => r.phone.cold?.['lcpMs'] ?? null,
    format: ms,
    higherIsBetter: false,
    noise: 0.1,
    relative: true,
  },
  {
    label: 'Phone LCP, refresh',
    pick: (r) => r.phone.refresh?.['lcpMs'] ?? null,
    format: ms,
    higherIsBetter: false,
    noise: 0.1,
    relative: true,
  },
  {
    label: 'Phone CLS, cold',
    pick: (r) => r.phone.cold?.['cls'] ?? null,
    format: cls,
    higherIsBetter: false,
    noise: 0.02,
  },
  {
    label: 'JavaScript on Exposures',
    pick: (r) => r.phone.cold?.['jsKB'] ?? null,
    format: kb,
    higherIsBetter: false,
    noise: 0.05,
    relative: true,
  },
  {
    label: 'Exhibition, first photograph',
    pick: (r) => r.exhibitionFirstPhotoMs,
    format: ms,
    higherIsBetter: false,
    noise: 0.1,
    relative: true,
  },
];

function compare(before: PerfRun, after: PerfRun): Compared[] {
  return COMPARED.flatMap((spec) => {
    const a = spec.pick(before);
    const b = spec.pick(after);
    if (a === null || b === null) return [];
    const delta = b - a;
    const noise = spec.relative ? Math.abs(a) * spec.noise : spec.noise;
    const change =
      Math.abs(delta) <= noise
        ? 'unchanged'
        : delta > 0 === spec.higherIsBetter
          ? 'better'
          : 'worse';
    return [{ label: spec.label, before: spec.format(a), after: spec.format(b), change }];
  });
}

const sameCommit = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && (a.startsWith(b) || b.startsWith(a));

// --- Rendering -----------------------------------------------------------------

const escape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCFullYear())}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
function ago(now: Date, date: Date): string {
  const minutes = Math.round((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} h ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}
const timeTag = (now: Date, date: Date): string =>
  `<time datetime="${date.toISOString()}">${escape(when(date))}</time> <span class="ago">(${ago(now, date)})</span>`;

const noData = (what: string, file: FileState<unknown>): string =>
  `<p class="none">${escape(what)}: ${file.state === 'malformed' ? 'the record could not be read' : 'no data yet'}.</p>`;

/** A small trend line: one segment per measuring setup, so a change of setup shows as a break, never a slope. */
function sparkline(
  runs: readonly PerfRun[],
  pick: (run: PerfRun) => number | null,
  label: string,
): string {
  const points = runs
    .map((run) => ({ run, value: pick(run) }))
    .filter((p): p is { run: PerfRun; value: number } => p.value !== null);
  if (points.length < 2) return '<span class="none">Too few measurements for a trend.</span>';
  const width = 160;
  const height = 36;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (i: number): number => 4 + (i * (width - 8)) / (points.length - 1);
  const y = (v: number): number =>
    max === min ? height / 2 : 4 + ((max - v) * (height - 8)) / (max - min);
  const segments: string[] = [];
  const breaks: number[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (i > 0 && p.run.setup !== points[i - 1]!.run.setup) {
      segments.push(current.join(' '));
      current = [];
      breaks.push(x(i) - (x(i) - x(i - 1)) / 2);
    }
    current.push(`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  });
  segments.push(current.join(' '));
  const last = points.at(-1)!;
  return `<svg class="spark" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}" role="img" aria-label="${escape(label)}: ${String(points.length)} measurements${breaks.length > 0 ? ', with a change in how it is measured' : ''}">${segments
    .map((s) => (s.includes(' ') ? `<polyline points="${s}"/>` : ''))
    .join(
      '',
    )}${breaks.map((bx) => `<line class="break" x1="${bx.toFixed(1)}" x2="${bx.toFixed(1)}" y1="2" y2="${String(height - 2)}"/>`).join('')}<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="2.5"/></svg>`;
}

function runLine(run: Run): string {
  const parts = [`${String(run.passed)} passed`, `${String(run.failed)} failed`];
  if (run.skipped > 0) parts.push(`${String(run.skipped)} skipped`);
  return parts.join(' · ');
}

export interface SystemInput {
  readonly now: Date;
  readonly health: Health | null;
  readonly files: StatusFiles;
}

export function renderSystem({ now, health, files }: SystemInput): string {
  const deploys = deploysOf(files.deploys);
  const watchdog = watchdogOf(files.watchdog);
  const perf = perfOf(files.perf);
  const verdict = judge(now, health, deploys, watchdog);
  const lastDeployed = [...deploys].reverse().find((d) => d.outcome === 'deployed');
  const latestGate = [...deploys].reverse().find((d) => d.gate !== null);
  const latestPerf = perf.at(-1);

  // Overview
  const release = health?.release ?? null;
  const overview = `
  <section aria-labelledby="overview">
    <h2 id="overview" class="label">Overview</h2>
    <p class="verdict verdict-${verdict.overall.toLowerCase()}">${verdict.overall}</p>
    ${verdict.reasons.length > 0 ? `<ul class="reasons">${verdict.reasons.map((r) => `<li>${escape(r)}</li>`).join('')}</ul>` : ''}
    <dl class="facts">
      <div><dt>Serving</dt><dd>${release ? `${escape(commitOf(release.commit) ?? 'unknown')} · built ${timeTag(now, new Date(release.builtAt))}` : 'Unknown'}</dd></div>
      <div><dt>Last successful deploy</dt><dd>${lastDeployed ? `${escape(lastDeployed.commit)} · ${timeTag(now, lastDeployed.at)}` : 'None recorded'}</dd></div>
      <div><dt>Last health check</dt><dd>${
        watchdog
          ? `${timeTag(now, watchdog.at)} · server ${watchdog.origin ? 'answering' : 'failing'} · public address ${watchdog.public ? 'answering' : 'failing'}${now.getTime() - watchdog.at.getTime() > WATCHDOG_STALE_MS ? ' · <strong>stale</strong>' : ''}`
          : 'No data yet'
      }</dd></div>
      <div><dt>Latest required tests</dt><dd>${latestGate?.gate ? `${runLine(latestGate.gate)} · ${timeTag(now, latestGate.at)}` : 'No data yet'}</dd></div>
      <div><dt>Uptime</dt><dd>Not monitored. Every check here runs on the same machine as the site, so none of them can see an outage from outside.</dd></div>
    </dl>
    <details class="rules"><summary>How the status is decided</summary>
      <p><b>Incident</b>: the live health check (run as this page loads) fails. <b>Unknown</b>: it can’t run, or no deploy has been recorded. <b>Degraded</b>: the watchdog (every minute) hasn’t reported for 10 minutes or its last check failed, or the latest deploy was stopped or rolled back after the release now serving. <b>Operational</b>: none of these.</p>
    </details>
  </section>`;

  // Since last deployment
  const deployed = deploys.filter((d) => d.outcome === 'deployed');
  const current = deployed.at(-1);
  const previous = deployed.at(-2);
  let since = '<p class="none">Nothing to compare yet: fewer than two deploys recorded.</p>';
  if (current && previous) {
    const gateCompare =
      current.gate && previous.gate
        ? `<p>Required tests: ${runLine(previous.gate)} → ${runLine(current.gate)}${
            current.gate.areas.join() !== previous.gate.areas.join()
              ? ' <span class="none">(different areas were tested, so the counts aren’t like for like)</span>'
              : ''
          }.</p>`
        : '<p class="none">Required tests: not recorded for both deploys.</p>';
    const after = [...perf].reverse().find((r) => sameCommit(r.commit, current.commit));
    const before = [...perf].reverse().find((r) => sameCommit(r.commit, previous.commit));
    let perfCompare =
      '<p class="none">No comparable measurements: performance wasn’t measured on both releases.</p>';
    if (after && before && after.setup !== before.setup) {
      perfCompare =
        '<p class="none">No comparable measurements: the measuring setup changed between the two releases.</p>';
    } else if (after && before) {
      const rows = compare(before, after);
      perfCompare =
        rows.length === 0
          ? '<p class="none">No comparable measurements.</p>'
          : `<div class="scroll"><table><thead><tr><th>Measure</th><th>${escape(previous.commit)}</th><th>${escape(current.commit)}</th><th>Change</th></tr></thead><tbody>${rows
              .map(
                (r) =>
                  `<tr><td>${escape(r.label)}</td><td class="n">${r.before}</td><td class="n">${r.after}</td><td class="change-${r.change}">${
                    r.change === 'unchanged'
                      ? 'within noise'
                      : r.change === 'better'
                        ? '↑ better'
                        : '↓ worse'
                  }</td></tr>`,
              )
              .join('')}</tbody></table></div>`;
    }
    since = `<p>${escape(previous.commit)} → ${escape(current.commit)}${current.note ? ` · ${escape(current.note)}` : ''}</p>${gateCompare}${perfCompare}`;
  }
  const sinceSection = `
  <section aria-labelledby="since">
    <h2 id="since" class="label">Since last deployment</h2>
    ${since}
  </section>`;

  // Performance
  let perfBody = noData('Performance', files.perf);
  if (latestPerf) {
    const stale = now.getTime() - latestPerf.at.getTime() > PERF_STALE_MS;
    const m = latestPerf.lighthouse.mobile;
    const d = latestPerf.lighthouse.desktop;
    const v = (metrics: Metrics | null, key: string, format: (n: number) => string): string => {
      const value = metrics?.[key];
      return value === null || value === undefined ? '—' : format(value);
    };
    const cold = latestPerf.phone.cold;
    const refresh = latestPerf.phone.refresh;
    const history = perf.slice(-30);
    perfBody = `
    <p class="source">Lab measurements of /exposures/ on production, ${timeTag(now, latestPerf.at)}${latestPerf.commit ? ` · release ${escape(latestPerf.commit)}` : ''} · median of ${String(latestPerf.runs ?? '?')} runs${stale ? ' · <strong>stale: older than 8 days</strong>' : ''}.</p>
    <div class="scroll"><table>
      <caption>Lighthouse ${escape(latestPerf.lighthouseVersion ?? '')} (simulated throttling)</caption>
      <thead><tr><th></th><th>Performance</th><th>Accessibility</th><th>Best practices</th><th>SEO</th><th>LCP</th><th>CLS</th><th>TBT</th><th>Transferred</th><th>Requests</th></tr></thead>
      <tbody>
        <tr><th>Mobile</th><td class="n">${v(m, 'performance', score)}</td><td class="n">${v(m, 'accessibility', score)}</td><td class="n">${v(m, 'bestPractices', score)}</td><td class="n">${v(m, 'seo', score)}</td><td class="n">${v(m, 'lcpMs', ms)}</td><td class="n">${v(m, 'cls', cls)}</td><td class="n">${v(m, 'tbtMs', (n) => `${String(Math.round(n))} ms`)}</td><td class="n">${v(m, 'totalKB', kb)}</td><td class="n">${v(m, 'requests', score)}</td></tr>
        <tr><th>Desktop</th><td class="n">${v(d, 'performance', score)}</td><td class="n">${v(d, 'accessibility', score)}</td><td class="n">${v(d, 'bestPractices', score)}</td><td class="n">${v(d, 'seo', score)}</td><td class="n">${v(d, 'lcpMs', ms)}</td><td class="n">${v(d, 'cls', cls)}</td><td class="n">${v(d, 'tbtMs', (n) => `${String(Math.round(n))} ms`)}</td><td class="n">${v(d, 'totalKB', kb)}</td><td class="n">${v(d, 'requests', score)}</td></tr>
      </tbody>
    </table></div>
    <div class="scroll"><table>
      <caption>A real throttled phone (Chromium, 390 × 844 at 3×, 1.6 Mbps, 150 ms latency, 4× CPU slowdown)</caption>
      <thead><tr><th></th><th>FCP</th><th>LCP</th><th>CLS</th><th>First screen loaded</th></tr></thead>
      <tbody>
        <tr><th>First visit</th><td class="n">${v(cold, 'fcpMs', ms)}</td><td class="n">${v(cold, 'lcpMs', ms)}</td><td class="n">${v(cold, 'cls', cls)}</td><td class="n">${v(cold, 'firstScreenMs', ms)}</td></tr>
        <tr><th>Refresh</th><td class="n">${v(refresh, 'fcpMs', ms)}</td><td class="n">${v(refresh, 'lcpMs', ms)}</td><td class="n">${v(refresh, 'cls', cls)}</td><td class="n">${v(refresh, 'firstScreenMs', ms)}</td></tr>
      </tbody>
    </table></div>
    <p class="source">On that phone: ${v(cold, 'jsKB', kb)} of JavaScript and ${v(cold, 'requests', score)} requests on a first visit; Exhibition shows its first photograph after ${latestPerf.exhibitionFirstPhotoMs === null ? '—' : ms(latestPerf.exhibitionFirstPhotoMs)}. Real-visitor measurements (field data, INP): not collected.</p>
    <h3 class="label">Trends</h3>
    ${
      history.length < 2
        ? `<p class="none">Trends appear once there are two measurements (one so far; they run weekly).</p>`
        : `<p class="source">The last ${String(history.length)} measurements.</p><ul class="trends">
      ${[
        [
          'Lighthouse mobile performance',
          (r: PerfRun) => r.lighthouse.mobile?.['performance'] ?? null,
        ],
        [
          'Lighthouse desktop performance',
          (r: PerfRun) => r.lighthouse.desktop?.['performance'] ?? null,
        ],
        ['Phone LCP, first visit', (r: PerfRun) => r.phone.cold?.['lcpMs'] ?? null],
        ['Phone LCP, refresh', (r: PerfRun) => r.phone.refresh?.['lcpMs'] ?? null],
        ['Phone CLS', (r: PerfRun) => r.phone.cold?.['cls'] ?? null],
        ['JavaScript bytes', (r: PerfRun) => r.phone.cold?.['jsKB'] ?? null],
        [
          'Bytes transferred (Lighthouse mobile)',
          (r: PerfRun) => r.lighthouse.mobile?.['totalKB'] ?? null,
        ],
      ]
        .map(
          ([label, pick]) =>
            `<li><span>${escape(label as string)}</span>${sparkline(history, pick as (r: PerfRun) => number | null, label as string)}</li>`,
        )
        .join(
          '',
        )}</ul><p class="source">A vertical mark is a change in how something is measured; the line never joins across one.</p>`
    }`;
  }
  const perfSection = `
  <section aria-labelledby="performance">
    <h2 id="performance" class="label">Performance</h2>
    ${perfBody}
  </section>`;

  // Quality
  const g = latestGate?.gate ?? null;
  const qualitySection = `
  <section aria-labelledby="quality">
    <h2 id="quality" class="label">Quality</h2>
    ${
      latestGate && g
        ? `<p>Latest deploy gate, ${timeTag(now, latestGate.at)}: <b>${runLine(g)}</b>${g.seconds !== null ? ` in ${String(Math.round(g.seconds))} s` : ''}. Risk: ${escape(g.risk ?? 'not recorded')}. Areas: smoke${g.areas.length > 0 ? `, ${g.areas.map(escape).join(', ')}` : ''}.</p>
           ${
             g.tests.some((t) => !t.ok)
               ? `<ul class="fails">${g.tests
                   .filter((t) => !t.ok)
                   .map((t) => `<li>✗ ${escape(t.name)}</li>`)
                   .join('')}</ul>`
               : ''
           }`
        : noData('Required tests', files.deploys)
    }
    <dl class="facts">
      <div><dt>Browsers</dt><dd>Chromium: ${g ? 'run on every deploy' : 'not yet'}. Firefox: not run. WebKit (Safari): not run.</dd></div>
      <div><dt>Accessibility</dt><dd>${
        latestPerf?.lighthouse.mobile?.['accessibility'] != null
          ? `Lighthouse ${score(latestPerf.lighthouse.mobile['accessibility'])} (mobile), automated, ${escape(when(latestPerf.at))}.`
          : 'No automated score yet.'
      } Manual review: not done.</dd></div>
      <div><dt>Visual regression</dt><dd>No screenshot comparisons. Layout is checked by geometry instead: proportions, overlaps, controls never over a photograph.</dd></div>
      <div><dt>Coverage</dt><dd>Not measured.</dd></div>
    </dl>
  </section>`;

  // Exhibition
  const exhibitionRun = [...deploys]
    .reverse()
    .map((d) => ({
      d,
      tests: [...(d.gate?.tests ?? []), ...(d.production?.tests ?? [])].filter(
        (t) => t.file === 'exhibition.browser.ts',
      ),
    }))
    .find((x) => x.tests.length > 0);
  const exhibitionSection = `
  <section aria-labelledby="exhibition">
    <h2 id="exhibition" class="label">Exhibition</h2>
    ${
      exhibitionRun
        ? `<p>Its own tests, last run ${timeTag(now, exhibitionRun.d.at)}:</p><ul class="tests">${exhibitionRun.tests
            .map(
              (t) =>
                `<li><span class="${t.ok ? 'ok' : 'bad'}">${t.ok ? '✓' : '✗'}</span> ${escape(t.name)}</li>`,
            )
            .join('')}</ul>`
        : '<p class="none">Its tests haven’t run in a recorded deploy yet (they run when Exhibition’s code changes).</p>'
    }
    <dl class="facts">
      <div><dt>First photograph</dt><dd>${latestPerf?.exhibitionFirstPhotoMs != null ? `${ms(latestPerf.exhibitionFirstPhotoMs)} on the throttled phone, ${escape(when(latestPerf.at))}` : 'Not measured yet'}</dd></div>
      <div><dt>Endurance (hours of autoplay)</dt><dd>Not run.</dd></div>
    </dl>
  </section>`;

  // Timeline
  const timeline = deploys.slice(-15).reverse();
  const timelineSection = `
  <section aria-labelledby="timeline">
    <h2 id="timeline" class="label">Deployments</h2>
    ${
      timeline.length === 0
        ? noData('Deployments', files.deploys)
        : `<ol class="timeline">${timeline
            .map(
              (d) => `<li class="outcome-${d.outcome}">
          <p class="when">${timeTag(now, d.at)}</p>
          <p><b>${escape(d.commit)}</b>${d.note ? ` · ${escape(d.note)}` : ''}</p>
          <p class="meta">${
            d.outcome === 'deployed'
              ? 'Deployed'
              : d.outcome === 'rolled-back'
                ? 'Rolled back'
                : `Stopped at ${escape(d.stage || 'a check')}`
          }${d.gate ? ` · gate ${runLine(d.gate)}` : ''}${d.production ? ` · production ${runLine(d.production)}` : ''}</p>
        </li>`,
            )
            .join('')}</ol>`
    }
  </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>System — randyliang.net</title>
<style>
@font-face { font-family: 'Newsreader'; src: url('/fonts/newsreader-variable.woff2') format('woff2'); font-weight: 200 800; font-display: swap; }
:root { --paper: #f6f1e6; --ink: #16130f; --muted: #6f675a; --rule: #ddd3c0; --accent: #7a2420; --ok: #3d5a3a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 400 1rem/1.6 'Newsreader', 'Iowan Old Style', Palatino, Georgia, serif; -webkit-font-smoothing: antialiased; }
main { max-width: 52rem; margin: 0 auto; padding: 3rem max(1.5rem, env(safe-area-inset-right)) 5rem max(1.5rem, env(safe-area-inset-left)); }
header { border-bottom: 2px solid var(--ink); padding-bottom: 1rem; margin-bottom: 2.5rem; }
h1 { font-size: clamp(2.25rem, 1.5rem + 3vw, 3.25rem); font-weight: 300; letter-spacing: -0.02em; line-height: 1; margin: 0.5rem 0 0; }
.label { font-size: 0.71875rem; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 1rem; }
section { padding: 2rem 0; border-top: 1px solid var(--rule); }
section:first-of-type { border-top: 0; padding-top: 0; }
p { margin: 0 0 0.75rem; }
.verdict { font-size: 2rem; font-weight: 340; letter-spacing: -0.01em; margin: 0 0 0.5rem; }
.verdict::before { content: ''; display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; margin-right: 0.6rem; vertical-align: 0.25rem; background: var(--muted); }
.verdict-operational::before { background: var(--ok); }
.verdict-degraded::before { background: #a8792e; }
.verdict-incident::before { background: var(--accent); }
.reasons { margin: 0 0 1rem; padding-left: 1.1rem; color: var(--muted); }
.facts { display: grid; gap: 0.6rem; margin: 1rem 0 0; }
.facts div { display: grid; grid-template-columns: minmax(9rem, 12rem) 1fr; gap: 0 1.25rem; }
@media (max-width: 34rem) { .facts div { grid-template-columns: 1fr; } }
dt { font-size: 0.71875rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); padding-top: 0.2rem; }
dd { margin: 0; }
.ago, .none, .source, .meta, .when { color: var(--muted); }
.none, .source { font-style: italic; }
.source { font-size: 0.9375rem; }
details.rules { margin-top: 1.25rem; font-size: 0.9375rem; color: var(--muted); }
details.rules summary { cursor: pointer; font-size: 0.71875rem; letter-spacing: 0.08em; text-transform: uppercase; }
details.rules summary:focus-visible, a:focus-visible { outline: 1px solid var(--accent); outline-offset: 3px; }
.scroll { overflow-x: auto; margin: 0 0 1.25rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9375rem; }
caption { text-align: left; font-size: 0.9375rem; font-style: italic; color: var(--muted); padding-bottom: 0.4rem; }
th, td { text-align: left; padding: 0.4rem 0.75rem 0.4rem 0; border-bottom: 1px solid var(--rule); white-space: nowrap; }
thead th { font-size: 0.6875rem; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); border-bottom-color: var(--ink); }
td.n { font-variant-numeric: tabular-nums lining-nums; }
.change-better { color: var(--ok); } .change-worse { color: var(--accent); } .change-unchanged { color: var(--muted); }
h3.label { margin-top: 1.5rem; }
.trends { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem 2rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
.trends li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; font-size: 0.9375rem; border-bottom: 1px solid var(--rule); padding: 0.3rem 0; }
.trends .none { font-size: 0.8125rem; }
.spark { flex: none; overflow: visible; }
.spark polyline { fill: none; stroke: var(--ink); stroke-width: 1.25; }
.spark circle { fill: var(--accent); }
.spark .break { stroke: var(--muted); stroke-dasharray: 2 2; }
.tests, .fails { list-style: none; margin: 0 0 1rem; padding: 0; }
.tests li, .fails li { padding: 0.15rem 0; }
.ok { color: var(--ok); } .bad, .fails li { color: var(--accent); }
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { padding: 0.75rem 0 0.75rem 1rem; border-left: 2px solid var(--ok); margin-bottom: 0.5rem; }
.timeline li.outcome-blocked { border-left-color: #a8792e; }
.timeline li.outcome-rolled-back { border-left-color: var(--accent); }
.timeline p { margin: 0; }
.when, .meta { font-size: 0.875rem; }
footer { margin-top: 2rem; font-size: 0.875rem; color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<main>
  <header>
    <p class="label">randyliang.net</p>
    <h1>System</h1>
  </header>
  ${overview}
  ${sinceSection}
  ${perfSection}
  ${qualitySection}
  ${exhibitionSection}
  ${timelineSection}
  <footer>Read-only. This page reports what the deploys, the watchdog and the weekly measurements recorded; opening it runs nothing. Rendered ${escape(when(now))}.</footer>
</main>
</body>
</html>
`;
}
