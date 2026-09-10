#!/bin/sh
set -e
cd /app
if [ -f ./apps/web/server.js ]; then
  exec node apps/web/server.js
fi
if [ -f ./server.js ]; then
  exec node server.js
fi
echo "No Next standalone server.js found" >&2
ls -la /app >&2
exit 1
