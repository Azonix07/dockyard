# Dockyard

Self-hosted PaaS (Railway/Render-style) for a Windows laptop on Tailscale.

## Features

- Connect a GitHub repo → **push deploys** the latest commit (signed webhooks)
- Manual deploy, stop/restart, redeploy previous image, blue/green cutover + rollback
- Edit env, port, Dockerfile path, build context, memory/CPU, auto-deploy toggle
- One-click **Postgres** / **Redis** with volumes, private networks, URL injection + redeploy
- Caddy proxy: `/p/<project>/` (Tailscale-friendly) and optional hostnames
- Deploy logs + live container logs in the dashboard
- Admin token auth (timing-safe)

## Quick start (WSL2 / Linux)

```bash
cp .env.example .env
# set ADMIN_TOKEN, PUBLIC_HOST, GITHUB_WEBHOOK_SECRET
./infra/up.sh
```

- Dashboard: http://localhost:3000  
- API: http://localhost:8080/api/health  
- Apps: http://localhost/p/&lt;project&gt;/

Full Windows + Tailscale + Funnel setup: [docs/setup-windows.md](docs/setup-windows.md)

## Sample app

[examples/hello-api](examples/hello-api) — tiny Node HTTP server with a Dockerfile.
