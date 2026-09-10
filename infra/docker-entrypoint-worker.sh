#!/bin/sh
set -e
mkdir -p /etc/caddy/dynamic
if [ ! -f /etc/caddy/dynamic/Caddyfile ]; then
  cp /tmp/Caddyfile.initial /etc/caddy/dynamic/Caddyfile
fi
exec node /app/apps/worker/dist/index.js
