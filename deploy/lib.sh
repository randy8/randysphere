# Shared by deploy.sh, rollback.sh, status.sh and watchdog.sh — sourced, not
# run. One definition of "the site is up", so the deploy, the rollback and
# the watchdog can never disagree about it.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE="$REPO/site/dist"
NEXT="$REPO/site/dist.next"
PREV="$REPO/site/dist.prev"
ORIGIN="http://127.0.0.1:4322"
PUBLIC="https://randyliang.net"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; }

# check_site <base-url>: the origin answers, is healthy, and serves real
# pages and a real image — not merely HTTP 200 from something on the port.
# Each page is fetched whole before it's searched: `curl | grep -q` under
# pipefail fails on a large page when grep stops reading early.
check_site() {
  local base="$1" body page image
  body=$(curl -fsS --max-time 5 "$base/healthz") || { fail "$base/healthz did not answer 200"; return 1; }
  [[ $body == *'"ok":true'* ]] || { fail "$base/healthz: $body"; return 1; }
  page=$(curl -fsS --max-time 5 "$base/exposures/") && [[ $page == *'<h1>Exposures</h1>'* ]] ||
    { fail "$base/exposures/ is not the Exposures page"; return 1; }
  image=''
  [[ $page =~ (/p/[0-9a-f]+/[^\"\ ]+\.avif) ]] && image="${BASH_REMATCH[1]}"
  [[ -n $image ]] && curl -fsS --max-time 5 -o /dev/null "$base$image" ||
    { fail "$base could not serve a photograph (${image:-none found})"; return 1; }
  page=$(curl -fsS --max-time 10 "$base/pictures/") && [[ $page == *'class="film-card"'* ]] ||
    { fail "$base/pictures/ has no films"; return 1; }
}

# wait_for <url>: up to 10s for a freshly started server to listen.
wait_for() {
  for _ in $(seq 50); do curl -fsS --max-time 1 -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.2; done
  fail "$1 never answered"
  return 1
}

# The server's own code, hashed: a deploy that doesn't change it needs no
# restart, because the server reads site/dist from disk on every request.
serve_hash() {
  find "$REPO/tools/serve/src" -name '*.ts' ! -name '*.test.ts' -print0 | sort -z |
    xargs -0 sha256sum | sha256sum | cut -c1-16
}

# release_field <dist-dir> <field>: empty for a release built without
# build-info.json (a hand-run `pnpm build`), never a failure.
release_field() {
  sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p" "$1/build-info.json" 2>/dev/null || true
}

restart_server() {
  step "Restarting photography-serve (server code changed)"
  sudo -n systemctl restart photography-serve
  wait_for "$ORIGIN/healthz"
}
