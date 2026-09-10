#!/bin/sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — set ADMIN_TOKEN before sharing the dashboard."
fi
docker compose -f infra/docker-compose.yml up -d --build "$@"
echo "Dashboard: http://localhost:3100  (or http://<tailscale-host>:3100)"
echo "API health: http://localhost:8180/api/health"
