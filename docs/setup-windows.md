# Windows laptop host setup (Tailscale + Docker)

Run these steps on the Windows machine that will host Dockyard.

## 1. Keep the laptop awake

Settings → System → Power → while plugged in: **Never sleep**. Disable lid-close sleep if this box is your always-on server.

## 2. Tailscale

1. Install [Tailscale for Windows](https://tailscale.com/download/windows) and sign in.
2. Open a terminal and run:

```powershell
tailscale status
tailscale ip -4
```

Note the MagicDNS name (e.g. `windows-laptop.tailnet-name.ts.net`).

3. From your Mac (on the same tailnet), verify:

```bash
tailscale ping <windows-hostname>
curl http://<windows-hostname>:8080/api/health
```

## 3. WSL2 + Docker

1. Install WSL2 (Ubuntu):

```powershell
wsl --install -d Ubuntu
```

2. Prefer **Docker Desktop** with the WSL2 backend, or Docker Engine inside Ubuntu.
3. Confirm:

```bash
docker run --rm hello-world
docker info
```

Dockyard expects the Docker socket at `/var/run/docker.sock` (WSL/Linux path).

## 4. GitHub → laptop (push-to-deploy)

GitHub cannot reach a Tailscale-only private IP. Choose one:

### Option A — Tailscale Funnel (recommended)

```powershell
tailscale funnel --bg 8080
```

Point the GitHub webhook / GitHub App at:

`https://<your-funnel-hostname>/api/webhooks/github`

Set a strong `GITHUB_WEBHOOK_SECRET` in `.env`. Unsigned webhooks are rejected unless `ALLOW_INSECURE_WEBHOOKS=true` (local only).

Keep app traffic on Tailscale (ports 3000 / 80) for private access.

### Option B — Self-hosted GitHub Actions runner

Install a runner on the laptop and call the local API or `docker` directly. No inbound webhook required.

### Option C — Cloudflare Tunnel

Public HTTPS to `/api/webhooks/github` only.

## 5. Run Dockyard

From this repo (inside WSL):

```bash
cp .env.example .env
# edit ADMIN_TOKEN, PUBLIC_HOST=<tailscale MagicDNS>, GITHUB_WEBHOOK_SECRET
./infra/up.sh
```

| Service | URL |
|---------|-----|
| Dashboard | `http://<tailscale-host>:3000` |
| API health | `http://<tailscale-host>:8080/api/health` |
| App (path) | `http://<tailscale-host>/p/<project>/` |
| App (host) | `http://<project>.<PUBLIC_HOST>` (needs DNS; path route is easier on Tailscale) |

On the login screen, set **API URL** to `http://<tailscale-host>:8080` if you open the dashboard from another device.

## 6. GitHub App (recommended)

1. Create a GitHub App with permissions: Contents (read), Metadata (read).
2. Subscribe to **Push** events.
3. Webhook URL: Funnel/tunnel URL + `/api/webhooks/github`.
4. Put App ID, private key, webhook secret, and installation ID into `.env`.

Or use a repo webhook + `GITHUB_TOKEN` (PAT) for clone access.

## 7. First deploy checklist

1. Push a repo with a `Dockerfile` (see `examples/hello-api`).
2. Create a project in the dashboard (enable auto-deploy).
3. Click **Deploy** (or push to the tracked branch).
4. Open `http://<host>/p/<project>/`.
5. Optionally create Postgres/Redis linked to the project (auto-redeploys with `DATABASE_URL`).
