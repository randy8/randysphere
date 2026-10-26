/**
 * pnpm check — the fast, every-change check: formatting, lint, types and
 * the unit tests, run side by side, each with its tool's own cache, so a
 * second run with little changed takes seconds rather than the ~97 s the
 * same steps took in sequence and uncached (2026-10-26). Prints each
 * step's time; on a failure, that step's own output.
 *
 * Everything still runs on every change: the unit suite is ~7 s, too
 * cheap to be worth selecting from.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CACHE = 'node_modules/.cache';

/** Every package `tsc` checks; each keeps its own incremental build info. */
const TYPED = ['tools/pipeline', 'tools/films', 'tools/serve', 'tools/qa', 'site'];

interface Step {
  readonly name: string;
  readonly command: string;
}

export const STEPS: readonly Step[] = [
  { name: 'format', command: `prettier --check --cache --log-level warn .` },
  { name: 'lint', command: `eslint --cache --cache-location ${CACHE}/eslint/ .` },
  ...TYPED.map((project) => ({
    name: `types ${project}`,
    command: `tsc --noEmit --incremental --tsBuildInfoFile ${CACHE}/tsc/${project.replace('/', '-')}.tsbuildinfo -p ${project}`,
  })),
  { name: 'unit tests', command: 'pnpm -s test' },
];

interface Result {
  readonly step: Step;
  readonly ok: boolean;
  readonly seconds: number;
  readonly output: string;
}

function run(step: Step): Promise<Result> {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(step.command, {
      cwd: ROOT,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => {
      done({ step, ok: code === 0, seconds: (performance.now() - started) / 1000, output });
    });
  });
}

const started = performance.now();
const results = await Promise.all(STEPS.map(run));
for (const result of results) {
  const mark = result.ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${result.step.name.padEnd(22)} ${result.seconds.toFixed(1).padStart(5)} s`);
}
const failed = results.filter((result) => !result.ok);
for (const result of failed) {
  console.log(`\n--- ${result.step.name}: ${result.step.command}\n${result.output.trim()}`);
}
console.log(
  `\n${failed.length === 0 ? 'passed' : `${String(failed.length)} failed`} in ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
