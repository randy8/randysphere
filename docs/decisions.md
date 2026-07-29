# Decisions

An append-only log of choices that a reader would otherwise have to reverse
engineer. Entries are dated and never edited; if a decision is reversed, a new
entry supersedes it and says so.

This is not the architecture document. `architecture.md` describes how the
system works today; this file explains why it ended up that way, including the
options that were rejected.

---

## 2026-07-28 — No build step for the pipeline

**Decision.** `tools/` is executed by Node directly from its TypeScript source.
There is no `dist/`, no bundler, and no transpiler dependency. `tsc` runs with
`noEmit` purely as a type checker.

**Why.** Node's type stripping became stable in v24.3.0 and no longer emits an
experimental warning. It removes type annotations and runs what is left, which
is exactly what a CLI needs. Adopting it deletes an entire category of things
that go wrong: stale build output, source maps that disagree with reality, a
`dist/` that is committed by accident, and a bundler configuration nobody
remembers writing. Stack traces point at real line numbers because inline types
are replaced with whitespace rather than removed.

**Cost.** Only erasable syntax is allowed — no `enum`, no parameter properties,
no namespaces. This is not a real constraint; all three are things worth
avoiding anyway. `erasableSyntaxOnly` in `tsconfig.base.json` turns a violation
into a type error instead of a runtime crash.

**Rejected alternatives.** `tsx` or `ts-node` (a dependency to do what the
runtime already does); compiling with `tsc` to `dist/` (no new dependency, but
reintroduces every stale-artifact problem for no benefit).

**Revisit if.** Node changes the feature's stability, or the pipeline develops a
genuine need for non-erasable syntax — which would more likely mean the code is
wrong than that the constraint is.

---

## 2026-07-28 — TypeScript 6, not 7

**Decision.** The whole workspace stays on TypeScript 6 for now.

**Why.** TypeScript 7 went stable on 8 July 2026 with an 8–12× speedup, but it
ships without a stable programmatic API. Astro's language tooling and
`astro check` depend on that API, so the site cannot use it yet. Splitting the
workspace — 7 for `tools/`, 6 for `site/` — would put two compilers with two
configurations and two behaviours in one repository to save a few seconds on a
type check that is already fast.

**Revisit if.** TypeScript 7.1 ships the new programmatic API (expected around
October 2026) and Astro's language tools adopt it. Then upgrade everything at
once, which is a single lockfile change.

---

## 2026-07-28 — The pipeline↔site boundary is type-only

**Decision.** `site/` may import *types* from `tools/pipeline` and must not
import any value from it. Runtime validation of the manifest is written
explicitly in the site rather than sharing a schema object across the boundary.

**Why.** Two reasons that point the same way. Architecturally, a type-only
dependency cannot drift into shared runtime behaviour, which is what keeps the
pipeline genuinely independent. Practically, `import type` is erased before
anything executes, which sidesteps a real hazard: Node refuses to strip types
from files under `node_modules`, and a workspace package is a symlink into
`node_modules`. A shared value import would work under Vite and break the
moment it was externalised to Node.

**Cost.** The manifest's shape is asserted in two places — the pipeline's schema
and the site's loader. That duplication is deliberate and small, and it is the
duplication that makes the boundary real.

**Revisit if.** The two validators drift in practice rather than in theory.

---

## 2026-07-28 — ESLint enforces the architecture, not the formatting

**Decision.** No stylistic rules. The most important rule in the configuration
is `no-restricted-imports` scoped to `tools/**`, which fails the build if the
pipeline imports Astro, Vite, or Tailwind.

**Why.** "The pipeline does not depend on the website framework" is the load
bearing claim of this whole design, and claims that are not enforced stop being
true. It is one config block and it costs nothing to keep.

---

## 2026-07-28 — The manifest carries no timestamp

**Decision.** Generated files record a schema version and content, and nothing
about when they were written.

**Why.** A `generatedAt` field would make every ingest produce a diff even when
nothing changed, which destroys the property that makes the manifest worth
committing: it is a pure function of `originals/` and `pipeline.config.ts`. Run
ingest twice and `git status` is clean. When something did change, the diff is
exactly what changed. Git already records when.

---

## 2026-07-28 — Publish lists the target instead of keeping a ledger

**Decision.** Every publish lists the destination prefix and diffs against the
manifest. There is no local record of what was uploaded last time.

**Why.** A ledger is a cache of remote state, and it is wrong the moment
anybody deletes an object from the Cloudflare dashboard — after which the
pipeline reports success forever while the site serves broken images. Listing
is authoritative. Thirty requests for thirty thousand objects is a fine price
for never having to reason about staleness.

`generated/published.json` survives, but only as the committed gate that lets
CI refuse to deploy a site whose manifests are ahead of what was published. It
is written last, after every key is confirmed, so a failed run leaves the
previous record intact rather than claiming derivatives exist that do not.

**Revisit if.** A collection grows large enough that listing is slow. The fix
is an early-out when nothing changed locally, not a ledger.

---

## 2026-07-28 — The source digest covers file bytes, not pixels

**Decision.** `sourceId` is the SHA-256 of the original file's bytes.

**Why.** The alternative — hashing normalised pixels — is more semantically
appealing, because re-exporting with different metadata would then not churn
any URLs. It is also unusable: identifying a photograph by its pixels means
decoding all of them on every run, just to discover that nothing changed. That
directly breaks the requirement that a repeat ingest does no unnecessary work.

Orientation is still normalised before encoding; it is simply not part of the
identity. The consequence is documented rather than hidden: a metadata-only
re-export produces a new identity and a new set of URLs, and ingest reports how
many photographs that affected so a large publish is never a surprise.

---

## 2026-07-28 — Dependencies are quarantined into thin modules

**Decision.** Where a dependency is needed, the code that touches it is
separated from the logic worth testing. `exif.ts` is the EXIF parser and
nothing else; the allow-list lives in `camera-metadata.ts`. `storage/r2.ts` is
the HTTP client; the response reader lives in `storage/s3-list.ts`.

**Why.** It started as a testing convenience and turned out to be the better
design. The three behaviours that could damage or expose a collection — GPS
exclusion, key determinism, publish integrity — are now testable with nothing
installed, which means they are covered on any machine and in any CI job
regardless of whether a native binary built. It also makes each dependency
genuinely replaceable, because its surface is one file.
