# Runbase

Self-hosted PaaS (Railway/Render-style) for a Windows laptop on Tailscale.

Runbase is the product brand and `https://runbase.in` is the intended public
application domain. The existing repository path and internal package
identifiers remain unchanged for compatibility.

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

## Staying up

Runbase is built to survive a laptop host: the proxy holds requests through
container restarts instead of returning 502, a reconciler re-creates anything
Docker loses, and a Windows watchdog restarts the stack if it ever stops
answering. See **[docs/reliability.md](docs/reliability.md)** — start there when
something is unreachable.

```bash
./scripts/cafe.sh doctor    # walks the whole chain and shows the broken link
```

## Cafe PC URLs (current setup)

| What | URL |
|------|-----|
| Frontend | https://runbase.in |
| Sign up | https://runbase.in/signup |
| Apps + API (Tailscale HTTPS) | https://abhinand.tail8a4b6e.ts.net:8443 |
| API direct (OAuth callbacks) | https://abhinand.tail8a4b6e.ts.net:8444 |
| Deployed backend | https://abhinand.tail8a4b6e.ts.net:8443/p/&lt;project&gt;/ |
| Dashboard (cafe Docker, backup) | http://abhinand:3100 |
| SSH from Mac | `ssh cafe` (port 2222) |

Frontend is on Vercel; API stays on the cafe PC. Use the **HTTPS** URLs from the Vercel site — browsers block `http://abhinand:8180` (mixed content → “Failed to fetch”). Tailscale must be connected.

Port **8443** fronts the Caddy proxy and is the one your deployed apps use
(`/p/<project>/`); it also serves `/api/*`. Port **8444** goes straight to the
platform API and exists because the GitHub/Vercel OAuth callbacks are registered
against it. Run `scripts/tailscale-serve.ps1` on the host to set both up.

```bash
vercel deploy --prod
```

## Quick start

```bash
cp .env.example .env
# set ADMIN_TOKEN, PUBLIC_HOST
./infra/up.sh            # start (reuses images)
./infra/up.sh --build    # rebuild changed images first
```

From Mac after cafe is set up:

```bash
./scripts/cafe.sh status
./scripts/cafe.sh up
```

## Docs

- Uptime, 502s, self-healing: [docs/reliability.md](docs/reliability.md)
- Windows + Tailscale: [docs/setup-windows.md](docs/setup-windows.md)
- Lid-closed remote access: [docs/remote-access-setup.md](docs/remote-access-setup.md)
