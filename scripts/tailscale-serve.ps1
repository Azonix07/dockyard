<#
  Publish Runbase over Tailscale HTTPS, with one canonical mapping.

    https://<host>:8443   ->  Caddy (:80)
                              /                 dashboard
                              /api/*            platform API
                              /p/<project>/*    your deployed backends
                              /__runbase/health proxy liveness

    https://<host>:8444   ->  platform API directly (:8180)
                              kept because the GitHub / Vercel OAuth callbacks
                              are registered against it.

  Anything a browser on the public internet calls (a Vercel frontend hitting
  your backend) must use an https:// URL — a page served over HTTPS cannot
  fetch http://, the browser blocks it as mixed content and the app reports it
  as a network failure.

  Run on the host:
    powershell -ExecutionPolicy Bypass -File .\scripts\tailscale-serve.ps1
#>

param(
  [int]$ProxyPort  = 80,
  [int]$ApiPort    = 8180,
  [int]$PublicApps = 8443,
  [int]$PublicApi  = 8444,
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'

$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { $ts = $cmd.Source } else { throw "tailscale.exe not found — install Tailscale first." }
}

$status = & $ts status 2>&1 | Out-String
if ($status -match 'Logged out') { throw "Tailscale is logged out. Run: tailscale up" }

if ($Reset) {
  Write-Host "Clearing existing serve config…" -ForegroundColor Yellow
  & $ts serve reset
}

Write-Host "Mapping https://<host>:$PublicApps -> http://127.0.0.1:$ProxyPort (Caddy)" -ForegroundColor Cyan
& $ts serve --bg --https=$PublicApps "http://127.0.0.1:$ProxyPort"

Write-Host "Mapping https://<host>:$PublicApi -> http://127.0.0.1:$ApiPort (API)" -ForegroundColor Cyan
& $ts serve --bg --https=$PublicApi "http://127.0.0.1:$ApiPort"

Write-Host ""
& $ts serve status

$dns = (& $ts status --json | ConvertFrom-Json).Self.DNSName
if ($dns) { $dns = $dns.TrimEnd('.') }

Write-Host ""
Write-Host "Put these in .env on the host, then restart the stack:" -ForegroundColor Green
Write-Host "  PUBLIC_APP_BASE=https://$dns`:$PublicApps"
Write-Host "  GITHUB_OAUTH_CALLBACK_BASE=https://$dns`:$PublicApi"
Write-Host "  VERCEL_OAUTH_CALLBACK_BASE=https://$dns`:$PublicApi"
Write-Host ""
Write-Host "Deployed backends are then reachable at:" -ForegroundColor Green
Write-Host "  https://$dns`:$PublicApps/p/<project>/"
