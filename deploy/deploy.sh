#!/usr/bin/env bash
# pnpm deploy — build the next release beside the live one, prove it on a
# spare port, then switch to it with two renames. Visitors never see a
# half-built site, and the server is restarted only when its own code
# changed (it reads site/release from disk on every request). If production
# then fails its checks, the previous release is put back automatically.
# See docs/deployment.md.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO"
CANDIDATE_PORT=4398

# Every way this can end is recorded in status/deploys.json for /system
# (tools/qa/src/status-record.ts): a step failing (blocked, recorded by the
# ERR trap below with the step it stopped at), the candidate's browser
# checks failing (blocked), production failing after the switch (rolled
# back), or the switch holding (deployed). Recording never fails a deploy.
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stage="start"
commit=""
record() {
  node tools/qa/src/status-record.ts --outcome="$1" --stage="$2" \
    --commit="${commit:-$(git rev-parse --short HEAD)}" --since="$STARTED" ||
    echo "(could not record this deploy in status/)" >&2
}
trap 'record blocked "$stage"' ERR

step "originals/ is mounted"
stage="originals"
# pnpm ingest deletes a batch's manifest and captions when its originals
# directory is missing (CLAUDE.md, Sharp edges) — never sync against an
# unmounted drive.
batches=$(find originals -mindepth 1 -maxdepth 1 -type d | wc -l)
manifests=$(find generated/albums -name '*.json' | wc -l)
if ((batches < manifests)); then
  fail "originals/ has $batches batches but there are $manifests manifests. Is the drive mounted? Nothing changed."
  record blocked "$stage"
  exit 1
fi

step "Dependencies match the lockfile, and load"
stage="dependencies"
pnpm install --frozen-lockfile --silent
# pnpm can report "up to date" with packages missing from disk (2026-10-26:
# 113 of them, which broke Lighthouse inside the weekly measurement). This
# imports every declared dependency and starts the tools the jobs use.
node tools/qa/src/deps-check.ts

step "Format, lint, types, tests, trial build"
stage="verify"
pnpm verify >/dev/null

step "Sync (new photographs, new films)"
stage="sync"
pnpm sync

step "Building the next release beside the live one"
stage="build"
rm -rf "$NEXT"
pnpm --filter @photo/site exec astro build --outDir release.next >/dev/null
commit="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!filebrowser' || echo '-dirty')"
printf '{"commit":"%s","builtAt":"%s","serve":"%s"}\n' \
  "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(serve_hash)" >"$NEXT/build-info.json"

step "Candidate: the next release, served on :$CANDIDATE_PORT"
stage="candidate"
node tools/serve/src/cli.ts --port="$CANDIDATE_PORT" --dist="$NEXT" >/dev/null &
candidate=$!
trap 'kill "$candidate" 2>/dev/null || true' EXIT
wait_for "http://127.0.0.1:$CANDIDATE_PORT/healthz"
check_site "http://127.0.0.1:$CANDIDATE_PORT"

step "Browser checks on the candidate: smoke + what this change touches"
stage="candidate browser checks"
# tools/qa: the smoke suite always; risk.ts adds areas from what changed
# since the release now live (everything, on a first deploy). A failure
# here stops the deploy with production untouched.
live_commit="$(release_field "$LIVE" commit)"
if [[ -n $live_commit ]]; then scope="--changed=${live_commit%-dirty}"; else scope="--all"; fi
if ! node tools/qa/src/browser-run.ts --base="http://127.0.0.1:$CANDIDATE_PORT" "$scope" \
  --report="$REPO/tools/qa/test-results/deploy-gate.json"; then
  fail "the candidate failed its browser checks; production is untouched"
  record blocked "$stage"
  exit 1
fi
kill "$candidate"
trap - EXIT

step "Switching to $commit"
stage="switch"
rm -rf "$PREV"
# The first deploy into site/release has nothing there to keep yet.
if [[ -d "$LIVE" ]]; then mv "$LIVE" "$PREV"; fi
mv "$NEXT" "$LIVE"
if [[ "$(release_field "$PREV" serve)" != "$(serve_hash)" ]]; then restart_server; fi

step "Production check"
stage="production check"
if ! check_site "$ORIGIN"; then
  fail "production failed its checks after the switch; rolling back"
  "$REPO/deploy/rollback.sh"
  record rolled-back "$stage"
  exit 1
fi
# The same smoke suite, against what visitors are now served (the origin,
# so a Cloudflare hiccup isn't mistaken for a bad release). Read-only:
# saving happens in the test browser's own localStorage.
if ! node tools/qa/src/browser-run.ts --base="$ORIGIN" --smoke \
  --report="$REPO/tools/qa/test-results/deploy-production.json"; then
  fail "production failed its browser smoke checks after the switch; rolling back"
  "$REPO/deploy/rollback.sh"
  record rolled-back "production browser checks"
  exit 1
fi
trap - ERR
record deployed "deployed"
public=$(curl -fsS --max-time 10 "$PUBLIC/exposures/" || true)
if [[ $public == *'<h1>Exposures</h1>'* ]]; then
  echo "$PUBLIC is serving $commit."
else
  # The origin is fine (checked above); a public failure here is the
  # tunnel or Cloudflare, which a rollback wouldn't fix.
  echo "WARNING: the origin is healthy but $PUBLIC did not answer as expected — check the tunnel (pnpm status)." >&2
fi
