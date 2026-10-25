#!/usr/bin/env bash
# pnpm status — everything worth knowing during an outage, on one screen.
source "$(dirname "$0")/lib.sh"

step "Services"
for unit in photography-serve cloudflared-tunnel photography-watchdog.timer; do
  printf '%-28s %-10s since %s, %s restarts\n' "$unit" \
    "$(systemctl is-active "$unit" 2>/dev/null)" \
    "$(systemctl show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null)" \
    "$(systemctl show "$unit" -p NRestarts --value 2>/dev/null)"
done
printf 'port 4322: %s\n' "$(ss -ltnpH 'sport = :4322' 2>/dev/null | awk '{print $NF}' | head -1)"

step "Origin ($ORIGIN)"
curl -fsS --max-time 5 "$ORIGIN/healthz" && echo || echo "NOT ANSWERING"

step "Public ($PUBLIC)"
curl -s -o /dev/null --max-time 10 -w 'HTTP %{http_code} in %{time_total}s\n' "$PUBLIC/exposures/"

step "Releases"
printf 'live:     %s built %s\n' "$(release_field "$LIVE" commit)" "$(release_field "$LIVE" builtAt)"
printf 'previous: %s built %s\n' "$(release_field "$PREV" commit)" "$(release_field "$PREV" builtAt)"

step "Machine"
df -h "$REPO" | tail -1 | awk '{print "disk: " $4 " free of " $2 " (" $5 " used)"}'
free -h | awk '/^Mem:/ {print "memory: " $7 " available of " $2}'

step "Errors in the last 24h"
journalctl -u photography-serve -u cloudflared-tunnel -u photography-watchdog --since -24h -p warning --no-pager -q 2>/dev/null |
  grep -v 'canceled by remote' | tail -10 || true
