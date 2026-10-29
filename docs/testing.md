# Testing

How changes are checked, and when. The rule: every change gets the checks
its risk calls for, the deploy gate is never skipped, and a failure says
what happened and how to rerun it.

## Levels

| Level            | Command                       | What                                                                                                                                                                      | Time (measured 2026-10-26)           |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1 — every change | `pnpm check`                  | format, lint, types (each package), unit tests — in parallel, each tool cached                                                                                            | ~10 s warm, ~40 s cold               |
| — before push    | `pnpm verify` (pre-push hook) | `pnpm check` + a trial build                                                                                                                                              | ~25 s warm                           |
| 2 — every deploy | inside `pnpm deploy`          | `verify`, then the browser smoke suite + risk-selected areas against the candidate on :4398, then smoke again against production after the switch (rolls back on failure) | ~45 s (smoke) to ~100 s (everything) |
| 3 — by risk      | `pnpm test:browser`           | smoke + the areas `tools/qa/src/risk.ts` picks for what changed since the live release                                                                                    | 25–100 s                             |
| 4 — deep audit   | (stage E, not yet built)      | other engines, endurance, throttled performance, accessibility, dependency scan                                                                                           | —                                    |

`pnpm test:browser` builds the site (only if a source is newer than the last
build) and serves it with `tools/serve` on :4399 — the production server, not
Astro's preview. Options: name areas (`pnpm test:browser exhibition`),
`--all`, `--smoke`, `--changed=<ref>`, `--base=<url>` (test another site),
`--browser=firefox|webkit`, `--report=<file.json>`.

## Browser tests

`tools/qa/src/browser/*.browser.ts`, on `node:test` driving `playwright-core`
(the repository's one test runner; the library, not `@playwright/test`).

- **smoke** — the deploy gate: grid geometry and first-screen loading,
  the lightbox lifecycle and deep links, an Exhibition step, save → share →
  open, every collection page, the no-JavaScript fallback, the security
  headers and the `/private` boundary.
- **gallery**, **lightbox**, **exhibition**, **share** — the areas `risk.ts`
  selects, each built around a failure that has actually happened (see each
  file's header).
- **family** — the chats at `/family/` and `/disc/`. Unlike every other area it starts its
  own chat servers in-process, on a throwaway data directory with test
  accounts: the harness's server has no accounts, and a deploy's candidate
  server opens the real conversation, which no test may write to.

Correctness is asserted as geometry and state — aspect ratios within 1%,
no overlapping boxes, nothing outside its container, exactly one
photograph on Exhibition's wall at rest, no two different frames on it at
any sampled frame — not pixel diffs, so a new photograph or a shuffle never
trips a test. Photo pages shuffle; tests that need a stable arrangement pass
`seed`, which replaces `Math.random` in the page.

Every wait is for a state (an image loaded, a fade finished, a counter
changed). The only fixed delay is the pace of simulated key presses in the
rapid-stepping tests, which _is_ the behaviour under test.

## Choosing tests by risk

`tools/qa/src/risk.ts` is one ordered table: path pattern → risk → areas →
why. The first match wins per path; a change's risk is its highest path's.
Documentation and content are low (smoke only); the lightbox, grid and
Saved/Share are medium (their areas); Exhibition, the server, deployment,
dependencies, build configuration and shared photo data are high (all areas,
or Exhibition's own). A path no rule recognises is high and runs everything.
The smoke suite — including the security checks — runs whatever the table
says. `pnpm test:browser` prints each path's classification and reason.

## When a test fails

Nothing retries. The failure prints its assertion and an `artifacts:` path
under `tools/qa/test-results/` (git-ignored) holding `screenshot.png`,
`trace.zip` (`npx playwright-core show-trace <path>`) and `report.txt`: the
URL, the page's errors and failed requests, and the command that reruns that
one test. A test also fails if the page threw or logged an error it didn't
expect.

**Flakes found so far.** 2026-10-26: Pictures tests failed twice on
`ERR_NETWORK_CHANGED` loading TMDB posters (this machine's network
changing mid-run, not the site). Fixed at the cause: the harness serves a
stub for every image from another host. The same error then hit a request
to 127.0.0.1 during a deploy's production check (Tailscale rebinding on this
host) and rolled back a good release; the harness now treats
`net::ERR_NETWORK_CHANGED` as environmental — not a page error, still in
the report.

A test may be quarantined only with a comment at the test naming the
reason, who owns it and the follow-up — and it is then skipped visibly
(`t.skip('quarantined: …')`), never deleted.

## Adding a test

When a bug is fixed, the test that would have caught it goes in the area
file it belongs to, and the file's header names the failure.
