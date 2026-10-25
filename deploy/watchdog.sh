#!/usr/bin/env bash
# Run every minute by photography-watchdog.timer, as randy. systemd already
# restarts the server when it crashes; this catches the other failure — a
# process that is running but no longer serves. It restarts the server only
# after three consecutive failed local checks (a transient blip never
# triggers it), records diagnostics first, and is bounded by the server
# unit's own StartLimitBurst. The public check only reports: a Cloudflare
# or network problem is never a reason to restart a healthy origin.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

STATE="${STATE_DIRECTORY:-/tmp}"
THRESHOLD=3

count() { cat "$STATE/$1" 2>/dev/null || echo 0; }

if check_site "$ORIGIN" 2>"$STATE/last-error"; then
  echo 0 >"$STATE/origin-failures"
else
  failures=$(($(count origin-failures) + 1))
  echo "$failures" >"$STATE/origin-failures"
  echo "origin check failed ($failures/$THRESHOLD): $(cat "$STATE/last-error")"
  if ((failures >= THRESHOLD)); then
    echo "--- diagnostics before restarting photography-serve ---"
    systemctl status photography-serve --no-pager -n 0 2>&1 | head -12
    ss -ltnp 'sport = :4322' 2>&1
    free -h 2>&1 | head -2
    df -h "$REPO" 2>&1 | tail -1
    journalctl -u photography-serve -n 30 --no-pager -q 2>&1
    echo "--- restarting ---"
    sudo -n systemctl restart photography-serve && echo 0 >"$STATE/origin-failures"
  fi
fi

if curl -fsS --max-time 10 "$PUBLIC/healthz" -o /dev/null; then
  echo 0 >"$STATE/public-failures"
else
  failures=$(($(count public-failures) + 1))
  echo "$failures" >"$STATE/public-failures"
  echo "public check failed ($failures in a row) — not restarting anything; see \`pnpm status\`"
fi
