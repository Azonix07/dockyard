<#
  Runbase watchdog — keeps the platform reachable on a Windows host.

  Runs every couple of minutes from Task Scheduler (see
  scripts/windows-autostart-dockyard.ps1). It is deliberately boring: check,
  heal, log, exit. Nothing here rebuilds images, so a watchdog run can never
  take the stack down.

  Manual run:
    powershell -ExecutionPolicy Bypass -File .\scripts\windows-watchdog.ps1
#>

param(
  [string]$WslDistro   = $env:RUNBASE_WSL_DISTRO,
  [string]$RepoPath    = $env:RUNBASE_REPO_PATH,
  [int]   $ApiPort     = 0,
  [int]   $ProxyPort   = 0,
  [string]$LogPath     = "$env:LOCALAPPDATA\Runbase\watchdog.log"
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not $WslDistro) { $WslDistro = 'Ubuntu' }
if (-not $RepoPath)  { $RepoPath  = '/home/abhin/dockyard' }
if ($ApiPort   -le 0) { $ApiPort   = if ($env:RUNBASE_API_PORT)   { [int]$env:RUNBASE_API_PORT }   else { 8180 } }
if ($ProxyPort -le 0) { $ProxyPort = if ($env:RUNBASE_PROXY_PORT) { [int]$env:RUNBASE_PROXY_PORT } else { 80 } }

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Write-Log([string]$Message) {
  $line = "{0}  {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -Path $LogPath -Value $line
  Write-Host $line
  # Keep the log small enough to never matter.
  $item = Get-Item $LogPath -ErrorAction SilentlyContinue
  if ($item -and $item.Length -gt 2MB) {
    $tail = Get-Content $LogPath -Tail 2000
    Set-Content -Path $LogPath -Value $tail
  }
}

function Test-Endpoint([string]$Url, [int]$TimeoutSec = 5) {
  try {
    $res = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing
    return $res.StatusCode -ge 200 -and $res.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Invoke-Wsl([string]$BashCommand, [int]$TimeoutSec = 240) {
  $job = Start-Job -ScriptBlock {
    param($distro, $cmd)
    wsl -d $distro -- bash -lc $cmd 2>&1
  } -ArgumentList $WslDistro, $BashCommand

  if (Wait-Job $job -Timeout $TimeoutSec) {
    $out = Receive-Job $job
    Remove-Job $job -Force
    return ($out -join "`n")
  }
  Stop-Job $job -Force
  Remove-Job $job -Force
  return "TIMEOUT after ${TimeoutSec}s"
}

# ---------------------------------------------------------------- 1. Docker
$dockerExe = "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
if (-not (Test-Path $dockerExe)) {
  $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
}

if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) {
  if (Test-Path $dockerExe) {
    Write-Log "Docker Desktop is not running — starting it"
    Start-Process -FilePath $dockerExe
    Start-Sleep -Seconds 45
  } else {
    Write-Log "ERROR: Docker Desktop not found at $dockerExe"
    exit 1
  }
}

$dockerReady = $false
for ($i = 0; $i -lt 12; $i++) {
  $out = Invoke-Wsl 'docker info >/dev/null 2>&1 && echo READY || echo NOTREADY' 30
  if ($out -match 'READY') { $dockerReady = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $dockerReady) {
  Write-Log "ERROR: docker is not responding inside WSL ($WslDistro)"
  exit 1
}

# ---------------------------------------------------------------- 2. Health
$apiUrl   = "http://127.0.0.1:$ApiPort/api/health"
$proxyUrl = "http://127.0.0.1:$ProxyPort/__runbase/health"

$apiOk   = Test-Endpoint $apiUrl
$proxyOk = Test-Endpoint $proxyUrl

if ($apiOk -and $proxyOk) {
  # Quiet success: only log occasionally so the file stays readable.
  if ((Get-Date).Minute % 30 -lt 3) { Write-Log "healthy (api + proxy)" }
  exit 0
}

Write-Log "UNHEALTHY — api=$apiOk proxy=$proxyOk. Restarting the stack."

# ---------------------------------------------------------------- 3. Heal
$result = Invoke-Wsl "cd '$RepoPath' && ./infra/up.sh 2>&1 | tail -25" 300
Write-Log "up.sh output: $result"

Start-Sleep -Seconds 10
$apiOk   = Test-Endpoint $apiUrl 10
$proxyOk = Test-Endpoint $proxyUrl 10
Write-Log "after heal: api=$apiOk proxy=$proxyOk"

# ---------------------------------------------------------------- 4. Tailscale
# `tailscale serve` mappings live in the node's state; they survive reboots, but
# a Tailscale reinstall or a logout silently drops them.
$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (Test-Path $ts) {
  $status = & $ts status 2>&1 | Out-String
  if ($status -match 'Logged out|stopped') {
    Write-Log "WARNING: Tailscale is not connected — the host is unreachable from outside the LAN"
  }
}

if (-not ($apiOk -and $proxyOk)) { exit 1 }
exit 0
