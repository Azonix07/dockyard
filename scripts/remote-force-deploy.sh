#!/usr/bin/env bash
# Run ON the cafe WSL box (or via: ssh cafe 'wsl -d Ubuntu -- bash -s' < this file)
set -euo pipefail
cd /home/abhin/dockyard
git fetch origin
git checkout -B main origin/main
git reset --hard origin/main
git clean -fd
echo "SHA=$(git rev-parse --short HEAD)"
if test -f apps/web/src/app/signup/page.tsx; then
  echo "HAS_SIGNUP=yes"
else
  echo "HAS_SIGNUP=NO"
  exit 1
fi
docker compose -f infra/docker-compose.yml build --no-cache web
docker compose -f infra/docker-compose.yml up -d --build --force-recreate
docker compose -f infra/docker-compose.yml ps
echo "Deploy finished. Check http://abhinand:3100/signup"
