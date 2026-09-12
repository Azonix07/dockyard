#!/usr/bin/env bash
# Bring the Runbase stack up.
#
#   ./infra/up.sh            # start (reuses existing images — fast, boot-safe)
#   ./infra/up.sh --build    # rebuild changed images first
#   ./infra/up.sh --rebuild  # full no-cache rebuild
#
# Boot must not depend on a successful build: the autostart task calls this on
# every login, and a transient npm/registry failure used to leave the whole
# platform down until someone noticed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f infra/docker-compose.yml)

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — set ADMIN_TOKEN before sharing the dashboard."
fi

BUILD_ARGS=()
case "${1:-}" in
  --rebuild)
    echo "Full rebuild (no cache)…"
    "${COMPOSE[@]}" build --no-cache
    BUILD_ARGS=(--force-recreate)
    shift
    ;;
  --build)
    echo "Rebuilding changed images…"
    "${COMPOSE[@]}" build
    shift
    ;;
esac

# Start anything missing, but never tear down healthy services.
"${COMPOSE[@]}" up -d --remove-orphans "${BUILD_ARGS[@]}" "$@"

API_PORT="${API_PORT:-8180}"
WEB_PORT="${WEB_PORT:-3100}"
PROXY_PORT="${PROXY_PORT:-80}"

echo
echo -n "Waiting for the API to answer"
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then
    echo " — up."
    break
  fi
  echo -n "."
  sleep 2
done

echo
"${COMPOSE[@]}" ps
echo
echo "Dashboard:  http://localhost:${WEB_PORT}   (or http://<tailscale-host>:${WEB_PORT})"
echo "API health: http://localhost:${API_PORT}/api/health"
echo "API ready:  http://localhost:${API_PORT}/api/ready"
echo "Proxy:      http://localhost:${PROXY_PORT}/__runbase/health"
