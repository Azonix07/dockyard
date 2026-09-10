#!/usr/bin/env bash
# Run from Mac: pipes a clean script into cafe WSL (no nested-quote hell)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/remote-force-deploy.sh"
CAFE_HOST="${CAFE_HOST:-abhinand}"
WEB_PORT="${WEB_PORT:-3100}"

if [[ ! -f "$SCRIPT" ]]; then
  echo "Missing $SCRIPT" >&2
  exit 1
fi

echo "Deploying Dockyard to cafe via SSH…"
# Heredoc / stdin avoids nested quoting bugs on macOS Terminal
ssh cafe "wsl -d Ubuntu -- bash -s" < "$SCRIPT"

echo
echo "Checking /signup…"
sleep 3
code=$(curl -sS -m 15 -o /dev/null -w "%{http_code}" "http://${CAFE_HOST}:${WEB_PORT}/signup" || echo "000")
echo "http://${CAFE_HOST}:${WEB_PORT}/signup → HTTP ${code}"
if [[ "$code" != "200" ]]; then
  echo "Still not 200 — open cafe logs: ./scripts/cafe.sh logs" >&2
  exit 1
fi
echo "OK — open http://${CAFE_HOST}:${WEB_PORT}/signup"
