#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit ADMIN_TOKEN and PUBLIC_HOST before production use."
fi
docker compose -f infra/docker-compose.yml up -d --build "$@"
echo "Dashboard: http://localhost:3000"
echo "API health: http://localhost:8080/api/health"
