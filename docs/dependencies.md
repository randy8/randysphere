# Dependencies

Every dependency in this repository is listed here with the reason it exists,
what it would cost to remove, and how much of it we actually use. Nothing gets
added without an entry. If you cannot write the justification, that is the
answer.

Dependencies are ranged with `^` and pinned by `pnpm-lock.yaml`. The lockfile is
what makes builds reproducible; the ranges are what make `pnpm update` a
five-minute job instead of a project.

---

## Workspace root

These are development tools. None of them ship anything to a browser or run in
production.

### `typescript` — `^6.0.3`

The language. Also the only type checker: `tsc --noEmit` validates, and Node
executes the source directly.

**Deliberately not TypeScript 7.** The Go-native compiler went stable on
8 July 2026 and is roughly ten times faster, but it shipped without a stable
programmatic API, which is what Astro's editor and `astro check` tooling is
built on. Running 7 for the pipeline and 6 for the site would be two compilers,
two configurations, and two sets of behaviour in one repository, in exchange
for saving a few seconds on a type check that already takes under a second.
Revisit when TypeScript 7.1 ships its new programmatic API and Astro's language
tools adopt it — expected around October 2026.

**Removal cost:** total. Everything is written in it.

### `eslint` — `^10.8.0` and `@eslint/js` — `^10.0.1`

Catches a narrow set of things neither the type checker nor the formatter can:
unhandled promise rejections, unreachable code, and — importantly here — the
`tools/` import boundary that keeps the pipeline independent of Astro.

v10 removed the legacy `eslintrc` system entirely, so `eslint.config.js` is the
only configuration format and there is no compatibility layer to reason about.

We use a small fraction of it. No stylistic rules (Prettier owns formatting),
no plugin ecosystem beyond TypeScript support.

**Removal cost:** low but real. We would lose `no-floating-promises` and the
architectural boundary check, both of which protect things that matter.

### `typescript-eslint` — `^8.65.0`

The parser and rules that let ESLint understand TypeScript. Installed as the
single meta-package rather than `@typescript-eslint/parser` plus
`@typescript-eslint/eslint-plugin` separately: same code, one entry to keep in
sync instead of two that must match exactly.

Type-aware linting (`recommendedTypeChecked`) is enabled because the pipeline is
async I/O from top to bottom and `no-floating-promises` alone justifies the
setup cost.

**Removal cost:** we would keep ESLint for JavaScript and lose the type-aware
rules, which are most of the value.

### `prettier` — `^3.6.0`

Formatting, so that formatting is never discussed again. No plugins.

**Removal cost:** none functionally. It buys reviewer attention.

---

## `tools/pipeline`

Five runtime dependencies. Each one does something that would be irresponsible
to write by hand.

### `@anthropic-ai/sdk` — `^0.70.0`

Calls the Claude API from `pnpm describe`, the optional command that drafts
alt text and captions for photographs missing one. Used only by that command:
`pnpm ingest` never imports it and has no network dependency of its own.

Chosen over hand-rolling the HTTP call (the way `storage/r2.ts` hand-rolls S3
signing with `aws4fetch`) because that pattern is for a signing scheme with no
official client, not a reason to avoid an official SDK when one exists.
Anthropic publishes and maintains this one; there is no equivalent argument
for reimplementing it.

**Removal cost:** `pnpm describe` stops working. Nothing else changes — the
provider it wraps is one implementation of `describe/provider.ts`'s
`DescriptionProvider` interface, and `pnpm ingest` was never able to reach it.

### `sharp` — `^0.35.3`

Decoding, resizing, and encoding. It wraps libvips, which is the reason a
collection of a few thousand photographs encodes in minutes rather than hours,
and it ships prebuilt binaries with AVIF support so no contributor needs a
compiler.

The alternative is not "write it ourselves"; it is ImageMagick over a
subprocess, which is slower, harder to error-handle, and an external system
dependency.

**Removal cost:** total. There is no second image encoder in this project.

### `yaml` — `^2.8.0`

Reading and writing `albums/<slug>/photos.yaml`.

Chosen over `js-yaml` for one specific reason: its document API preserves
comments and formatting through a parse-and-serialise cycle. That file contains
the photographer's own writing, and a parser that round-trips it as plain data
would silently strip their comments the first time ingest added a photograph.

**Removal cost:** we would have to stop maintaining the entries in that file
and require it to be written entirely by hand.

### `exif-reader` — `^2.0.2`

Parsing the EXIF block sharp hands back. EXIF is a TIFF container with
endianness, IFD offsets, and vendor extensions; hand-parsing it would be a
genuine source of bugs for no benefit.

Its surface here is one function in `exif.ts`. The allow-list that decides what
may reach a published page is in `camera-metadata.ts` and imports nothing, so
the security-relevant behaviour is tested without it.

**Removal cost:** camera metadata disappears from the manifest. Nothing else
changes; it is a caption, not a photograph.

### `aws4fetch` — `^1.0.20`

Signing S3 requests to R2. AWS SigV4 is fiddly enough that hand-rolling it is a
bad idea, and this is a small, zero-dependency signer built on the platform's
own `fetch` and Web Crypto.

Chosen over `@aws-sdk/client-s3`, which pulls in dozens of transitive packages
to do the same three HTTP requests. We use PUT and ListObjectsV2 and nothing
else, and the list response is read by `storage/s3-list.ts` rather than an XML
parser — safe only because every key we write matches a pattern containing no
character XML escapes.

**Removal cost:** publishing to R2 stops. `--local` still works.

### `@types/node` — `^24.3.0`

Type definitions for the standard library. Development only.

---

## Rejected

Things that would be reasonable to add and were considered. Recorded so the
same argument does not have to be had twice.

### `eslint-config-prettier`

Turns off ESLint rules that conflict with Prettier. Unnecessary: modern ESLint
and typescript-eslint ship no formatting rules enabled by default, and we
enable none. It would be a dependency guarding against a conflict that cannot
occur in this configuration.

### `tsx`, `ts-node`, `tsup`, `esbuild`

TypeScript execution and bundling for the pipeline. Node 24 runs `.ts` files
natively via type stripping, which covers everything we need. See
[`decisions.md`](decisions.md).

### `globals`

Supplies global variable names to ESLint's `no-undef`. Not needed: `no-undef`
is disabled for TypeScript files (the type checker does that job better), and
the only JavaScript file in the repository is `eslint.config.js`, which uses no
Node globals.

### `husky`, `lefthook`, `simple-git-hooks`

Git hooks that run the linter before a commit. Rejected because hooks are
installed per-clone, are silently skipped with `--no-verify`, and slow down
every commit to catch what CI catches reliably. CI is the enforcement point.

### `turbo`, `nx`

Monorepo task orchestration. Two packages and a handful of scripts do not need
a task graph. `pnpm --filter` is sufficient and requires no explanation.

### `oxlint`, `biome`

Rust-based linters and formatters, considerably faster than ESLint and
Prettier. Rejected because linting a repository this size takes about a second
either way, and because ESLint's rule coverage and stability over a decade
matter more here than its speed today.

### `vitest`, `jest`

Test runners. Node's built-in `node:test` covers what the pipeline needs.
Revisit only if we need something it genuinely lacks.

### `zod`

Schema validation for the config, the manifest, and `photos.yaml`. Rejected
because the error messages are the entire point here, and a schema library
produces "Expected number, received string at photos.3.variants.7.width" where
a hand-written check produces the setting name, the range, what was actually
there, and the command that fixes it. The validators are about 150 lines and
they are the part of the pipeline a user is most likely to meet.

### `p-limit`, `p-map`

Bounded concurrency. `concurrency.ts` is twelve lines, has no configuration,
and is directly tested. This is the one place the original brief's "prefer
mature libraries over custom implementations" was not followed, deliberately.

### `dotenv`

Loading `.env`. Node has `process.loadEnvFile()`.

### `commander`, `yargs`

Argument parsing. Node has `node:util`'s `parseArgs`, and this CLI has three
commands and four flags.

### `fast-xml-parser`

Reading S3 list responses. Not needed: the response has three element names we
care about, and the key alphabet is constrained by KEY_PATTERN such that
nothing can arrive XML-escaped. `storage/s3-list.test.ts` covers the cases,
including foreign keys, which are ignored rather than trusted.
