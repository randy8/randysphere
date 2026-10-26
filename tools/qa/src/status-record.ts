/**
 * Records one deploy's outcome in status/deploys.json, for /system. Called
 * by deploy/deploy.sh on every way a deploy can end:
 *
 *   node tools/qa/src/status-record.ts --outcome=deployed|blocked|rolled-back
 *     --stage=<where it stopped> --commit=<short> --since=<ISO start time>
 *
 * The browser-test reports (tools/qa/test-results/deploy-*.json) are read
 * only if they were written during this deploy (after --since), so an old
 * report is never attributed to a new release. The note is the commit
 * subject up to its first colon — the page is public, and the rest of a
 * subject can name paths and internals.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { append, ROOT } from './status-store.ts';

export const DEPLOYS_KEPT = 50;

export interface RunSummary {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly seconds: number;
  readonly areas: readonly string[];
  readonly risk: string | null;
  readonly tests: readonly { readonly name: string; readonly file: string; readonly ok: boolean }[];
}

export interface DeployRecord {
  readonly at: string;
  readonly commit: string;
  readonly note: string;
  readonly outcome: 'deployed' | 'blocked' | 'rolled-back';
  readonly stage: string;
  readonly gate: RunSummary | null;
  readonly production: RunSummary | null;
}

/** The commit subject's lead — the part before its first colon, at most 60 characters. */
export function publicNote(subject: string): string {
  const lead = subject.split(':')[0]?.trim() ?? '';
  return lead.length > 60 ? `${lead.slice(0, 59)}…` : lead;
}

/** A browser-run report, reduced to what the page may show, or null if missing, malformed or older than `since`. */
export function summarise(path: string, since: string): RunSummary | null {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof report['finishedAt'] !== 'string' || report['finishedAt'] < since) return null;
    const number = (key: string): number => (typeof report[key] === 'number' ? report[key] : 0);
    const tests = Array.isArray(report['tests'])
      ? (report['tests'] as Record<string, unknown>[])
      : [];
    return {
      passed: number('passed'),
      failed: number('failed'),
      skipped: number('skipped'),
      seconds: number('seconds'),
      areas: Array.isArray(report['areas']) ? report['areas'].map(String) : [],
      risk: typeof report['risk'] === 'string' ? report['risk'] : null,
      tests: tests.map((test) => ({
        name: String(test['name']),
        file: String(test['file']),
        ok: test['ok'] === true,
      })),
    };
  } catch {
    return null;
  }
}

function main(): void {
  const flag = (name: string): string =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
  const outcome = flag('outcome');
  if (outcome !== 'deployed' && outcome !== 'blocked' && outcome !== 'rolled-back') {
    throw new Error('--outcome must be deployed, blocked or rolled-back');
  }
  const commit = flag('commit').replace(/-dirty$/, '') || 'unknown';
  const since = flag('since') || new Date(0).toISOString();
  let subject = '';
  try {
    subject = execFileSync('git', ['log', '-1', '--format=%s', commit], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    // An unknown commit just has no note.
  }
  const results = join(ROOT, 'tools', 'qa', 'test-results');
  const record: DeployRecord = {
    at: new Date().toISOString(),
    commit: commit.slice(0, 12),
    note: publicNote(subject),
    outcome,
    stage: flag('stage'),
    gate: summarise(join(results, 'deploy-gate.json'), since),
    production: summarise(join(results, 'deploy-production.json'), since),
  };
  append('deploys.json', record, DEPLOYS_KEPT);
  console.log(`recorded: ${outcome} at ${record.stage || 'end'} (${record.commit})`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
