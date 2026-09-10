# Dockyard

Self-hosted PaaS (Railway/Render-style) for a Windows laptop on Tailscale.

## Features

- Railway-style UX: email signup/login → choose a plan → create projects
- Usage & performance dashboard (plan quotas, deploy activity, live Docker CPU/RAM)
- Project canvas tabs: Overview · Metrics · Deployments · Variables · Settings
- Datastore presets: PostgreSQL, MySQL, MariaDB, Redis, MongoDB, MinIO (S3)
- Prefilled version / memory / CPU per engine; injects connection env on link
- Connect a GitHub repo → push deploys the latest commit (signed webhooks)
- New Project wizard (Deploy from GitHub / Empty project)
- Manual deploy, stop/restart, redeploy previous image, blue/green cutover + rollback
- Caddy proxy: `/p/<project>/` (Tailscale-friendly) and optional hostnames
- Per-user sessions + Hobby/Pro plan limits (self-hosted)
- Legacy `ADMIN_TOKEN` still works via Login → Admin token

## Cafe PC URLs (current setup)

| What | URL |
|------|-----|
| Dashboard | http://abhinand:3100 |
| API | http://abhinand:8180 |
| Sign up | http://abhinand:3100/signup |
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
