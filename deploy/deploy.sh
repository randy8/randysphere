#!/usr/bin/env bash
# pnpm deploy — build the next release beside the live one, prove it on a
# spare port, then switch to it with two renames. Visitors never see a
# half-built site, and the server is restarted only when its own code
# changed (it reads site/dist from disk on every request). If production
# then fails its checks, the previous release is put back automatically.
# See docs/deployment.md.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO"
CANDIDATE_PORT=4398

step "originals/ is mounted"
# pnpm ingest deletes a batch's manifest and captions when its originals
# directory is missing (CLAUDE.md, Sharp edges) — never sync against an
# unmounted drive.
batches=$(find originals -mindepth 1 -maxdepth 1 -type d | wc -l)
manifests=$(find generated/albums -name '*.json' | wc -l)
if ((batches < manifests)); then
  fail "originals/ has $batches batches but there are $manifests manifests. Is the drive mounted? Nothing changed."
  exit 1
fi

step "Dependencies match the lockfile"
pnpm install --frozen-lockfile --silent

step "Format, lint, types, tests, trial build"
pnpm verify >/dev/null

step "Sync (new photographs, new films)"
pnpm sync

step "Building the next release beside the live one"
rm -rf "$NEXT"
pnpm --filter @photo/site exec astro build --outDir dist.next >/dev/null
commit="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!filebrowser' || echo '-dirty')"
printf '{"commit":"%s","builtAt":"%s","serve":"%s"}\n' \
  "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(serve_hash)" >"$NEXT/build-info.json"

step "Candidate: the next release, served on :$CANDIDATE_PORT"
node tools/serve/src/cli.ts --port="$CANDIDATE_PORT" --dist="$NEXT" >/dev/null &
candidate=$!
trap 'kill "$candidate" 2>/dev/null || true' EXIT
wait_for "http://127.0.0.1:$CANDIDATE_PORT/healthz"
check_site "http://127.0.0.1:$CANDIDATE_PORT"
kill "$candidate"
trap - EXIT

step "Switching to $commit"
rm -rf "$PREV"
mv "$LIVE" "$PREV"
mv "$NEXT" "$LIVE"
if [[ "$(release_field "$PREV" serve)" != "$(serve_hash)" ]]; then restart_server; fi

step "Production check"
if ! check_site "$ORIGIN"; then
  fail "production failed its checks after the switch; rolling back"
  "$REPO/deploy/rollback.sh"
  exit 1
fi
public=$(curl -fsS --max-time 10 "$PUBLIC/exposures/" || true)
if [[ $public == *'<h1>Exposures</h1>'* ]]; then
  echo "$PUBLIC is serving $commit."
else
  # The origin is fine (checked above); a public failure here is the
  # tunnel or Cloudflare, which a rollback wouldn't fix.
  echo "WARNING: the origin is healthy but $PUBLIC did not answer as expected — check the tunnel (pnpm status)." >&2
fi
