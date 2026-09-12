#!/usr/bin/env bash
# Easy helper from Mac → cafe Windows PC over Tailscale
set -euo pipefail

CMD="${1:-}"
CAFE_HOST="${CAFE_HOST:-abhinand}"
WEB_PORT="${WEB_PORT:-3100}"
API_PORT="${API_PORT:-8180}"
PROXY_PORT="${PROXY_PORT:-80}"

usage() {
  cat <<EOF
Usage:
  ./scripts/cafe.sh              # open interactive SSH shell
  ./scripts/cafe.sh status       # ping + check Runbase ports
  ./scripts/cafe.sh doctor       # full chain check: host → docker → api → proxy → apps
  ./scripts/cafe.sh wsl          # open WSL Ubuntu shell on cafe PC
  ./scripts/cafe.sh up           # git pull + rebuild changed images + restart
  ./scripts/cafe.sh force-deploy # nuclear: clean pull + no-cache web rebuild
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
  doctor )
    echo "=== 1. Host reachable over Tailscale ==="
    ping -c 2 -t 3 "$CAFE_HOST" 2>&1 | tail -2 || echo "  ping FAILED — Tailscale down or laptop off"
    echo
    echo "=== 2. Ports ==="
    for p in 2222 "$WEB_PORT" "$API_PORT" "$PROXY_PORT"; do
      if nc -z -G 2 "$CAFE_HOST" "$p" 2>/dev/null; then echo "  OPEN   $p"; else echo "  CLOSED $p"; fi
    done
    echo
    echo "=== 3. API ==="
    curl -sS -m 5 "http://${CAFE_HOST}:${API_PORT}/api/health" || echo "  (no response)"
    echo
    echo "=== 4. API readiness (db / docker / proxy) ==="
    curl -sS -m 8 "http://${CAFE_HOST}:${API_PORT}/api/ready" || echo "  (no response)"
    echo
    echo "=== 5. Proxy ==="
    curl -sS -m 5 "http://${CAFE_HOST}:${PROXY_PORT}/__runbase/health" || echo "  (no response)"
    echo
    echo "=== 6. Containers ==="
    ssh cafe "wsl -d Ubuntu -- docker ps --format '  {{.Names}}\t{{.Status}}' --filter label=laptop-paas.managed=true" 2>/dev/null || true
    ssh cafe "wsl -d Ubuntu -- docker compose -f /home/abhin/dockyard/infra/docker-compose.yml ps --format '  {{.Service}}\t{{.Status}}'" 2>/dev/null || true
    echo
    echo "=== 7. Published routes ==="
    ssh cafe "wsl -d Ubuntu -- docker exec \$(wsl -d Ubuntu -- docker ps -q -f name=caddy | head -1) cat /etc/caddy/dynamic/Caddyfile" 2>/dev/null | grep -E '^\s*@|reverse_proxy' | head -30 || echo "  (could not read Caddyfile)"
    echo
    echo "=== 8. Recent worker log ==="
    ssh cafe "wsl -d Ubuntu -- docker compose -f /home/abhin/dockyard/infra/docker-compose.yml logs --tail=20 worker" 2>/dev/null || true
    ;;
  wsl )
    exec ssh cafe "wsl -d Ubuntu -e bash -l"
    ;;
  up )
    echo "Syncing cafe Runbase to origin/main…"
    ssh cafe "wsl -d Ubuntu -- bash -lc 'cd /home/abhin/dockyard && git fetch origin && git checkout -B main origin/main && git reset --hard origin/main && git clean -fd && echo SHA=\$(git rev-parse --short HEAD) && test -f apps/web/src/app/signup/page.tsx && echo HAS_SIGNUP=yes'"
    echo "Rebuilding changed images + restarting stack…"
    # Incremental build: a --no-cache rebuild of web took the platform down for
    # minutes on every deploy. Use `force-deploy` when you actually need that.
    ssh cafe "wsl -d Ubuntu -- bash -lc 'cd /home/abhin/dockyard && ./infra/up.sh --build'"
    echo
    echo "Checking routes…"
    sleep 4
    for path in / /signup /login; do
      code=$(curl -sS -m 8 -o /dev/null -w "%{http_code}" "http://${CAFE_HOST}:${WEB_PORT}${path}" || echo "000")
      echo "http://${CAFE_HOST}:${WEB_PORT}${path} → HTTP ${code}"
    done
    ;;
  force-deploy )
    exec "$(cd "$(dirname "$0")" && pwd)/cafe-force-deploy.sh"
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
