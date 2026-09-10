#!/usr/bin/env bash
# Easy helper from Mac → cafe Windows PC over Tailscale
set -euo pipefail

CMD="${1:-}"
CAFE_HOST="${CAFE_HOST:-abhinand}"
WEB_PORT="${WEB_PORT:-3100}"
API_PORT="${API_PORT:-8180}"

usage() {
  cat <<EOF
Usage:
  ./scripts/cafe.sh              # open interactive SSH shell
  ./scripts/cafe.sh status       # ping + check Dockyard ports
  ./scripts/cafe.sh wsl          # open WSL Ubuntu shell on cafe PC
  ./scripts/cafe.sh up           # git pull + start/restart Dockyard
  ./scripts/cafe.sh logs         # show api/web/worker logs
  ./scripts/cafe.sh 'dir'        # run arbitrary remote command
EOF
}

case "$CMD" in
  "" )
    exec ssh cafe
    ;;
  status )
    echo "Tailscale / ping:"
    ping -c 1 -t 3 "$CAFE_HOST" 2>&1 | tail -3 || true
    echo
    echo "Ports:"
    for p in 2222 "$WEB_PORT" "$API_PORT" 80; do
      if nc -z -G 2 "$CAFE_HOST" "$p" 2>/dev/null; then echo "  OPEN  $p"; else echo "  closed $p"; fi
    done
    echo
    echo "API health:"
    curl -sS -m 5 "http://${CAFE_HOST}:${API_PORT}/api/health" || echo "(API not up)"
    echo
    echo "Dashboard: http://${CAFE_HOST}:${WEB_PORT}"
    curl -sS -m 5 -o /dev/null -w "dashboard HTTP %{http_code}\n" "http://${CAFE_HOST}:${WEB_PORT}/" || true
    ;;
  wsl )
    exec ssh cafe "wsl -d Ubuntu -e bash -l"
    ;;
  up )
    ssh cafe "wsl -d Ubuntu -- bash /home/abhin/dockyard/infra/up.sh"
    ;;
  logs )
    ssh cafe "wsl -d Ubuntu -- docker compose -f /home/abhin/dockyard/infra/docker-compose.yml logs --tail=80 api web worker"
    ;;
  -h|--help|help )
    usage
    ;;
  * )
    ssh cafe "$@"
    ;;
esac
