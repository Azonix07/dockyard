#Requires -RunAsAdministrator
<#
  One-time host setup so Runbase stays up on its own.

  Installs:
    * RunbaseAutostart — starts Docker Desktop + the stack at logon
    * RunbaseWatchdog  — every 2 minutes: health check, heal if needed
    * Power/network settings that stop Windows putting the "server" to sleep

  Run once on the host (PowerShell as Administrator):

    powershell -ExecutionPolicy Bypass -File .\scripts\windows-autostart-dockyard.ps1
#>

param(
  [string]$WslDistro = 'Ubuntu',
  [string]$RepoPath  = '/home/abhin/dockyard',
  [string]$RunAsUser = 'abhin',
  [int]   $ApiPort   = 8180,
  [int]   $WebPort   = 3100,
  [int]   $ProxyPort = 80
)

$ErrorActionPreference = "Stop"

$scriptDir = "C:\Users\$RunAsUser\runbase"
New-Item -ItemType Directory -Force -Path $scriptDir | Out-Null

$dockerExe = "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
if (-not (Test-Path $dockerExe)) {
  $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
}

# ------------------------------------------------------------------ startup
$startScript = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$docker = '$dockerExe'
if ((Test-Path `$docker) -and -not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath `$docker
}

# Wait until docker answers inside WSL (up to ~3 minutes)
for (`$i = 0; `$i -lt 36; `$i++) {
  wsl -d $WslDistro -- docker info 1>`$null 2>`$null
  if (`$LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 5
}

# Start the stack. No --build: boot must not depend on a successful build.
wsl -d $WslDistro -- bash -lc "cd '$RepoPath' && ./infra/up.sh"
"@

Set-Content -Path "$scriptDir\start-runbase.ps1" -Value $startScript -Encoding UTF8
Copy-Item -Path (Join-Path $PSScriptRoot 'windows-watchdog.ps1') `
          -Destination "$scriptDir\windows-watchdog.ps1" -Force

# ------------------------------------------------------------------- tasks
schtasks /Create /TN "RunbaseAutostart" `
  /TR "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptDir\start-runbase.ps1`"" `
  /SC ONLOGON /RU $RunAsUser /RL HIGHEST /IT /F | Out-Null
Write-Host "Installed task: RunbaseAutostart (at logon)" -ForegroundColor Green

$watchdogArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptDir\windows-watchdog.ps1`" -WslDistro $WslDistro -RepoPath $RepoPath -ApiPort $ApiPort -ProxyPort $ProxyPort"
schtasks /Create /TN "RunbaseWatchdog" `
  /TR "powershell.exe $watchdogArgs" `
  /SC MINUTE /MO 2 /RU $RunAsUser /RL HIGHEST /IT /F | Out-Null
Write-Host "Installed task: RunbaseWatchdog (every 2 minutes)" -ForegroundColor Green

# ------------------------------------------------------------------- power
# A laptop acting as a server must not sleep, hibernate, or park its NIC.
# Windows dropping the network adapter to save power is a very common cause of
# "the backend disappeared for a few minutes and came back".
try {
  powercfg /change standby-timeout-ac 0      | Out-Null
  powercfg /change hibernate-timeout-ac 0    | Out-Null
  powercfg /change monitor-timeout-ac 15     | Out-Null
  powercfg /change disk-timeout-ac 0         | Out-Null
  powercfg /hibernate off                    | Out-Null
  # Lid close while plugged in: do nothing (0)
  powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0 | Out-Null
  powercfg /setactive SCHEME_CURRENT | Out-Null
  Write-Host "Power plan: never sleep on AC, lid close does nothing" -ForegroundColor Green
} catch {
  Write-Host "WARNING: could not apply power settings: $_" -ForegroundColor Yellow
}

try {
  Get-NetAdapter -Physical | ForEach-Object {
    Disable-NetAdapterPowerManagement -Name $_.Name -ErrorAction SilentlyContinue
  }
  Write-Host "Disabled NIC power saving on physical adapters" -ForegroundColor Green
} catch {
  Write-Host "WARNING: could not disable NIC power management: $_" -ForegroundColor Yellow
}

# Come back automatically after a power cut.
try {
  $bios = Get-CimInstance -ClassName Win32_ComputerSystem
  Write-Host "Tip: enable 'Restore on AC Power Loss' in BIOS on $($bios.Manufacturer) $($bios.Model)" -ForegroundColor Cyan
} catch {}

Write-Host ""
Write-Host "Dashboard: http://localhost:$WebPort" -ForegroundColor Cyan
Write-Host "API:       http://localhost:$ApiPort/api/health" -ForegroundColor Cyan
Write-Host "Proxy:     http://localhost:$ProxyPort/__runbase/health" -ForegroundColor Cyan
Write-Host "Watchdog log: %LOCALAPPDATA%\Runbase\watchdog.log" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next: run scripts/tailscale-serve.ps1 to publish HTTPS endpoints." -ForegroundColor Yellow
