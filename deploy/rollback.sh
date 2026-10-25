#!/usr/bin/env bash
# pnpm rollback — swap the live release with the previous one. Run it again
# to swap back: nothing is deleted, so a rollback is itself reversible.
# Rolls back the built site (site/release); server code (tools/serve) comes
# from the repository, so undoing a server change is `git revert` + deploy.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

if [[ ! -d "$PREV" ]]; then
  fail "there is no previous release ($PREV) to roll back to"
  exit 1
fi

from="$(release_field "$LIVE" commit)"
to="$(release_field "$PREV" commit)"
step "Rolling back: ${from:-unknown} → ${to:-unknown}"
rm -rf "$NEXT"
mv "$LIVE" "$NEXT"
mv "$PREV" "$LIVE"
mv "$NEXT" "$PREV"
# No restart: the server reads site/release from disk on every request, and
# its own code isn't part of a release. A pure swap — no downtime.

step "Production check"
check_site "$ORIGIN"
echo "Serving ${to:-the previous release}. \`pnpm rollback\` again returns to ${from:-the one before}."
