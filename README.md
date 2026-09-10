# Dockyard

Self-hosted PaaS (Railway/Render-style) for a Windows laptop on Tailscale.

## Features

- Connect a GitHub repo → push deploys the latest commit (signed webhooks)
- Manual deploy, stop/restart, redeploy previous image, blue/green cutover + rollback
- Edit env, port, Dockerfile path, build context, memory/CPU, auto-deploy toggle
- One-click Postgres/Redis with volumes, private networks, URL injection + redeploy
- Caddy proxy: `/p/<project>/` (Tailscale-friendly) and optional hostnames
- Deploy logs + live container logs in the dashboard
- Admin token auth

## Cafe PC URLs (current setup)

| What | URL |
|------|-----|
| Dashboard | http://abhinand:3100 |
| API | http://abhinand:8180 |
| Login token | value of `ADMIN_TOKEN` in `.env` |
| SSH from Mac | `ssh cafe` (port 2222) |

Ports **3100/8180** avoid conflict with Gamespot on 3000/8080.

## Quick start

```bash
cp .env.example .env
# set ADMIN_TOKEN, PUBLIC_HOST
./infra/up.sh
```

From Mac after cafe is set up:

```bash
./scripts/cafe.sh status
./scripts/cafe.sh up
```

## Docs

- Windows + Tailscale: [docs/setup-windows.md](docs/setup-windows.md)
- Lid-closed remote access: [docs/remote-access-setup.md](docs/remote-access-setup.md)
