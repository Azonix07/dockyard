#!/usr/bin/env bash
# Force cafe PC onto latest main and rebuild Dockyard (fixes stale /signup 404)
set -euo pipefail

CAFE_HOST="${CAFE_HOST:-abhinand}"
WEB_PORT="${WEB_PORT:-3100}"
API_PORT="${API_PORT:-8180}"

echo "==> Resetting /home/abhin/dockyard to origin/main on cafe"
ssh cafe "wsl -d Ubuntu -- bash -lc '
set -euo pipefail
cd /home/abhin/dockyard
git remote -v
git fetch origin
git checkout -B main origin/main
git reset --hard origin/main
git clean -fd
echo \"REMOTE_SHA=\$(git rev-parse --short HEAD)\"
echo \"HAS_SIGNUP=\$(test -f apps/web/src/app/signup/page.tsx && echo yes || echo NO)\"
'"

echo "==> Force rebuilding images (no cache for web)"
ssh cafe "wsl -d Ubuntu -- bash -lc '
set -euo pipefail
cd /home/abhin/dockyard
docker compose -f infra/docker-compose.yml build --no-cache web
docker compose -f infra/docker-compose.yml up -d --build --force-recreate api worker web
docker compose -f infra/docker-compose.yml ps
'"

echo "==> Waiting for web…"
sleep 5

echo "==> Health checks"
curl -sS -m 8 "http://${CAFE_HOST}:${API_PORT}/api/health" || echo "(api down)"
echo
for path in / /signup /login /dashboard; do
  code=$(curl -sS -m 8 -o /dev/null -w "%{http_code}" "http://${CAFE_HOST}:${WEB_PORT}${path}" || echo "000")
  echo "http://${CAFE_HOST}:${WEB_PORT}${path} → ${code}"
done

echo
echo "Done. Open http://${CAFE_HOST}:${WEB_PORT}/signup"
