#Requires -RunAsAdministrator
<#
  Installs a Windows startup task so Dockyard comes back after reboot.
  Run once on the cafe PC (PowerShell Admin):

    powershell -ExecutionPolicy Bypass -File .\scripts\windows-autostart-dockyard.ps1
#>

$ErrorActionPreference = "Stop"

$dockerExe = "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
if (-not (Test-Path $dockerExe)) {
  $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
}

$scriptDir = "C:\Users\abhin\dockyard-autostart"
New-Item -ItemType Directory -Force -Path $scriptDir | Out-Null

$ps1 = @"
`$ErrorActionPreference = 'SilentlyContinue'
# Start Docker Desktop if needed
`$docker = '$dockerExe'
if (Test-Path `$docker) {
  `$running = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
  if (-not `$running) {
    Start-Process -FilePath `$docker
  }
}

# Wait until docker works in WSL (up to ~3 minutes)
for (`$i = 0; `$i -lt 36; `$i++) {
  `$ok = wsl -d Ubuntu -- docker info 1>`$null 2>`$null
  if (`$LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 5
}

# Start Dockyard stack
wsl -d Ubuntu -- bash /home/abhin/dockyard/infra/up.sh
"@

Set-Content -Path "$scriptDir\start-dockyard.ps1" -Value $ps1 -Encoding UTF8

# Run at logon for user abhin, interactive session
schtasks /Create /TN "DockyardAutostart" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptDir\start-dockyard.ps1`"" /SC ONLOGON /RU abhin /RL HIGHEST /IT /F | Out-Null

Write-Host "Installed scheduled task: DockyardAutostart" -ForegroundColor Green
Write-Host "It starts Docker + Dockyard when user abhin logs in." -ForegroundColor Green
Write-Host "Dashboard: http://abhinand:3100" -ForegroundColor Cyan
Write-Host "API:       http://abhinand:8180" -ForegroundColor Cyan
