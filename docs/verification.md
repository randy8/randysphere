# Verification checklist

The repository was authored in an environment with no network access and no
package manager. The test suite runs there and passes, because the tests that
matter deliberately avoid the dependencies. Everything that needs resolved
packages — installing, linting, type checking, and any code path through sharp,
yaml, exif-reader, or aws4fetch — has not been executed.

Run this once on a real machine. It takes under a minute.

```sh
corepack enable
pnpm install
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

## What each one proves

| Command | Proves |
| --- | --- |
| `pnpm install` | Every version range in `package.json` resolves, and the peer dependencies between ESLint 10, typescript-eslint 8, and TypeScript 6 are compatible. |
| `pnpm lint` | The flat config loads, `projectService` finds the tsconfigs, and the `tools/` import boundary rule is active. |
| `pnpm format:check` | Prettier agrees with the checked-in formatting, including the `jsonc` override for `tsconfig*.json`. |
| `pnpm typecheck` | `erasableSyntaxOnly` accepts the source, meaning Node can run it without a build step. |
| `pnpm test` | The pipeline's behaviour is what the tests say it is. Already passing (63 tests); this confirms it still does with real packages present. |

## Then, once, with real photographs

The tests cover everything reachable without a native image library. These are
the paths they cannot reach, in the order worth checking:

```sh
cp ~/some-photos/*.jpg originals/test-album/
pnpm ingest          # encodes, writes generated/albums/test-album.json
pnpm doctor          # should report only that nothing is published yet
pnpm ingest          # second run must encode nothing at all
pnpm run publish --local
pnpm doctor          # should now be silent
```

Worth looking at by hand the first time:

- A **portrait photograph shot on a rotated sensor** appears portrait in the
  manifest's `width` and `height`. This is the orientation path through sharp.
- `exiftool generated/derivatives/p/*/2400-*.jpg` shows **no GPS and no camera
  tags**. The allow-list is tested; that sharp writes nothing extra is not.
- A photograph in **Adobe RGB or Display P3** does not come out desaturated.
  This exercises `withIccProfile('srgb', { attach: false })`, which is the one
  sharp call whose exact option shape is unverified.
- `albums/test-album/photos.yaml` gains entries when you add a photograph, and
  **keeps your comments and your alt text** when you run ingest again.

## Known risks, and what to do

**`pnpm install` reports a peer dependency conflict on `typescript`.**
`typescript-eslint` has previously carried a `<6.0.0` cap. If 8.65 still does,
add a single `pnpm.overrides` entry to the root `package.json` naming the exact
package and version — and record it in `docs/dependencies.md` with the error it
resolved. Do not add overrides speculatively; an override that fixes nothing is
a trap for whoever reads it next.

**`pnpm install` refuses to run because of the Node version.**
That is `engine-strict=true` doing its job. Install the version in
`.node-version` (`fnm use`, `nodenv install`, or equivalent) and try again.

**`pnpm install` warns about ignored build scripts.**
A dependency wants to run code at install time. Do not add it to
`onlyBuiltDependencies` in `pnpm-workspace.yaml` reflexively: check whether the
package works without it first. Most do.

**`pnpm lint` reports that a file is not included in any project.**
`projectService` could not find a tsconfig covering it. Either the file belongs
in a package's `include`, or it is a stray file that should not exist.
