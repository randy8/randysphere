#!/usr/bin/env bash
# Installs (or updates) the systemd units in deploy/ and restarts what they
# run. Needs root: `sudo bash deploy/install-units.sh` from a terminal.
# Expected effect on the site: about a second of 502s while the web server
# restarts, then two or three while the tunnel reconnects. Undo steps are in
# docs/deployment.md ("Installing or updating the units").
set -euo pipefail
cd "$(dirname "$0")"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install-units.sh" >&2
  exit 1
fi

for unit in photography-serve.service cloudflared-tunnel.service \
  photography-watchdog.service photography-watchdog.timer; do
  systemd-analyze verify "$unit" 2>&1 | grep -v 'not found' || true
  install -m 644 "$unit" /etc/systemd/system/
  echo "installed $unit"
done

systemctl daemon-reload
systemctl restart photography-serve
echo "restarted photography-serve"
systemctl restart cloudflared-tunnel
echo "restarted cloudflared-tunnel"
systemctl enable --now photography-watchdog.timer
systemctl is-active photography-serve cloudflared-tunnel photography-watchdog.timer
