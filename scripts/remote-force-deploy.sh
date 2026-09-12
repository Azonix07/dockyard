#!/usr/bin/env bash
# Run ON the cafe WSL box (piped via ssh). Safe — no nested quotes needed from Mac.
set -euo pipefail

echo "==> Runbase force deploy starting"
cd /home/abhin/dockyard

git fetch origin
git checkout -B main origin/main
git reset --hard origin/main
git clean -fd

SHA="$(git rev-parse --short HEAD)"
echo "SHA=${SHA}"

if ! test -f apps/web/src/app/signup/page.tsx; then
  echo "HAS_SIGNUP=NO — wrong repo or old commit" >&2
  exit 1
fi
echo "HAS_SIGNUP=yes"

# Ensure Docker is reachable from WSL
if ! docker info >/dev/null 2>&1; then
  echo "Docker not reachable from WSL. Start Docker Desktop on Windows, then retry." >&2
  exit 1
fi

echo "==> Rebuilding web image (no cache)"
docker compose -f infra/docker-compose.yml build --no-cache web

echo "==> Recreating stack"
docker compose -f infra/docker-compose.yml up -d --build --force-recreate

echo "==> Waiting for web"
sleep 5
docker compose -f infra/docker-compose.yml ps

# In-container route check if possible
if docker compose -f infra/docker-compose.yml exec -T web wget -qO- http://127.0.0.1:3000/signup >/dev/null 2>&1 \
  || docker compose -f infra/docker-compose.yml exec -T web node -e "fetch('http://127.0.0.1:3000/signup').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "IN_CONTAINER_SIGNUP=200"
else
  echo "IN_CONTAINER_SIGNUP=check-failed (container may still be starting)"
fi

echo "==> Deploy finished SHA=${SHA}"
echo "Open http://abhinand:3100/signup"
