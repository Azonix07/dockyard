# Keeping Runbase up

Runbase runs on a Windows laptop, so "always on" is not something the
environment gives you for free — it has to be engineered at four layers. This
page describes each layer, what used to fail there, and how to check it.

## The request path

```
browser (Vercel frontend)
   │  https
   ▼
Tailscale serve         :8443 → 127.0.0.1:80     (apps + platform)
   │                    :8444 → 127.0.0.1:8180   (API direct, OAuth callbacks)
   ▼
Caddy  :80              /p/<project>/*  → paas-app-<project>:<port>
   │                    /api/*          → api:8080
   │                    /               → web:3000
   ▼
your container          paas-app-<project>
```

A 502 can be produced by any hop. `./scripts/cafe.sh doctor` walks the whole
chain and tells you which one is broken.

## Layer 1 — the proxy

**Symptom:** an app returns 502 for a few seconds after every deploy, or
randomly during the day.

The generated Caddyfile now holds a request for up to `PROXY_TRY_DURATION_SEC`
(25s by default) while an upstream is unreachable, retrying every 250ms, rather
than answering 502 on the first failed dial. A container restart therefore
surfaces as one slow request instead of a wall of errors.

If the upstream really is gone, you get a **503** with `Retry-After: 3` and an
`X-Runbase-Error` header — and CORS headers, so a browser app can read the
status instead of reporting an opaque network failure.

Check it:

```bash
curl -i http://<host>/__runbase/health
```

## Layer 2 — the route table

**Symptom:** an app that was working suddenly returns the proxy's landing page,
or 404, with no deploy in between.

The worker regenerates the whole Caddyfile whenever anything changes. It used to
only include projects whose status was exactly `running`, so any refresh that
happened while a project was mid-deploy silently deleted that project's route.
Routes now persist for every project that has built at least one image and has
not been explicitly stopped.

Check the live table:

```bash
./scripts/cafe.sh doctor      # section 7
```

## Layer 3 — the containers

**Symptom:** everything is gone after a reboot, a Docker Desktop update, or the
laptop running out of memory.

Two things cover this:

* every compose service is `restart: unless-stopped`, so Docker brings the
  platform back by itself;
* the worker runs a **reconciler** every `WORKER_RECONCILE_MS` (20s) that
  compares Postgres (desired state) against Docker (actual state). It recreates
  missing app containers from their last image, restarts stopped ones,
  reattaches containers that lost the `laptop-paas` network, and re-publishes
  the route table.

Watch it work:

```bash
./scripts/cafe.sh logs | grep reconcile
```

## Layer 4 — the host

**Symptom:** the whole host disappears for minutes at a time, usually when
nobody is touching it.

Run once, as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-autostart-dockyard.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\tailscale-serve.ps1
```

That installs:

| Task | Schedule | Does |
|------|----------|------|
| `RunbaseAutostart` | at logon | starts Docker Desktop, waits for it, runs `infra/up.sh` |
| `RunbaseWatchdog` | every 2 min | health-checks the API and proxy, restarts the stack if either is down |

and applies the host settings that matter:

* never sleep or hibernate on AC, lid close does nothing
* **NIC power management off** — Windows parking the network adapter to save
  power is a classic cause of "it was unreachable for four minutes and then
  came back"
* a reminder to turn on *Restore on AC Power Loss* in the BIOS

Watchdog log: `%LOCALAPPDATA%\Runbase\watchdog.log`

## Deploys

A deploy no longer cuts traffic over on a fixed 2-second sleep. The candidate
container must actually accept a TCP connection on its port first
(`DEPLOY_READINESS_TIMEOUT_MS`, 90s), and the cutover renames the old container
out of the way and the new one in back-to-back, draining the old one afterwards.

If your app never becomes ready, the deploy fails with the container's logs
attached instead of going live and serving 502s. The most common cause is
binding `127.0.0.1` instead of `0.0.0.0` — inside a container only `0.0.0.0`
is reachable.

## Health endpoints

| URL | Meaning |
|-----|---------|
| `:8180/api/health` | the API process is alive (no dependencies touched) |
| `:8180/api/ready` | Postgres, Docker and Caddy are all reachable |
| `:80/__runbase/health` | the proxy is alive and how many routes it publishes |

Point any uptime monitor at `/api/health` for liveness and `/api/ready` for a
real check.

## Tuning knobs

All in `.env`; see `.env.example` for the full list.

| Variable | Default | Effect |
|----------|---------|--------|
| `PROXY_TRY_DURATION_SEC` | 25 | how long a request waits for a restarting backend |
| `DEPLOY_READINESS_TIMEOUT_MS` | 90000 | how long a new container gets to bind its port |
| `WORKER_RECONCILE_MS` | 20000 | self-heal sweep interval (0 disables) |
| `PG_POOL_MAX` | 16 | Postgres connections held by the API |
