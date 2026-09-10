#Requires -RunAsAdministrator
<#
  Dockyard — one-time Windows setup for remote Mac access over Tailscale.
#>

$ErrorActionPreference = "Continue"

$candidates = @($env:USERNAME, "abhin", "Abhinand", "Abhinand360") | Where-Object { $_ } | Select-Object -Unique
$UserName = $null
$userProfile = $null
foreach ($c in $candidates) {
  $p = "C:\Users\$c"
  if (Test-Path $p) {
    $UserName = $c
    $userProfile = $p
    break
  }
}

if (-not $userProfile) {
  Write-Host "ERROR: Could not find a user profile under C:\Users" -ForegroundColor Red
  Get-ChildItem "C:\Users" -Directory | ForEach-Object { Write-Host "  - $($_.Name)" }
  exit 1
}

Write-Host "==> Using Windows user profile: $userProfile" -ForegroundColor Cyan

$PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOKOFZovhXOxDYDmvgg7Eoa0Rl+h6ECMwk5NvPp+rQ7v dockyard-mac-to-cafe"

Write-Host "==> Installing OpenSSH Server..." -ForegroundColor Cyan
try {
  $cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
  if ($cap -and $cap.State -ne 'Installed') {
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
  }
} catch {
  Write-Host "Capability install note: $($_.Exception.Message)" -ForegroundColor Yellow
}

# Also try Windows Optional Feature style on newer Windows
try {
  Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction SilentlyContinue | Out-Null
} catch {}

Write-Host "==> Configuring sshd service..." -ForegroundColor Cyan
$svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Host "OpenSSH Server service not found. Trying install via Add-WindowsCapability again..." -ForegroundColor Yellow
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
}

if (-not $svc) {
  Write-Host "ERROR: sshd service still missing." -ForegroundColor Red
  Write-Host "Install manually: Settings -> Apps -> Optional features -> Add -> OpenSSH Server" -ForegroundColor Yellow
  Write-Host "Then re-run this script." -ForegroundColor Yellow
  exit 1
}

Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue
try {
  Start-Service sshd -ErrorAction Stop
  Write-Host "sshd started." -ForegroundColor Green
} catch {
  Write-Host "Start-Service failed, trying sc.exe..." -ForegroundColor Yellow
  sc.exe config sshd start= auto | Out-Null
  sc.exe start sshd
  Start-Sleep -Seconds 2
  $svc2 = Get-Service sshd
  if ($svc2.Status -ne 'Running') {
    Write-Host "ERROR: Could not start sshd. Status=$($svc2.Status)" -ForegroundColor Red
    Write-Host "Run this to see why:" -ForegroundColor Yellow
    Write-Host "  Get-WinEvent -LogName Application -MaxEvents 20 | Where-Object {`$_.ProviderName -like '*OpenSSH*' -or `$_.Message -like '*ssh*'} | Format-List" -ForegroundColor Yellow
    Write-Host "Continuing to install SSH key anyway..." -ForegroundColor Yellow
  } else {
    Write-Host "sshd started via sc.exe." -ForegroundColor Green
  }
}

Write-Host "==> Firewall rule for SSH..." -ForegroundColor Cyan
if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

$sshDir = Join-Path $userProfile ".ssh"
$authKeys = Join-Path $sshDir "authorized_keys"
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null

if (Test-Path $authKeys) {
  $existing = Get-Content $authKeys -Raw
  if ($existing -notlike "*$PublicKey*") {
    Add-Content -Path $authKeys -Value "`n$PublicKey"
  }
} else {
  Set-Content -Path $authKeys -Value $PublicKey -Encoding ascii
}

icacls $sshDir /inheritance:r | Out-Null
icacls $sshDir /grant:r "${UserName}:(OI)(CI)F" | Out-Null
icacls $authKeys /inheritance:r | Out-Null
icacls $authKeys /grant:r "${UserName}:F" | Out-Null

Write-Host "==> Updating sshd_config..." -ForegroundColor Cyan
$sshdConfig = "C:\ProgramData\ssh\sshd_config"
if (Test-Path $sshdConfig) {
  $content = Get-Content $sshdConfig
  $content = $content -replace '(?m)^#?PubkeyAuthentication\s+.*', 'PubkeyAuthentication yes'
  $content = $content -replace '(?m)^#?PasswordAuthentication\s+.*', 'PasswordAuthentication yes'
  Set-Content $sshdConfig $content
  try { Restart-Service sshd -ErrorAction Stop } catch { sc.exe stop sshd; Start-Sleep 1; sc.exe start sshd }
}

Write-Host ""
Write-Host "SSH key installed for $UserName." -ForegroundColor Green
Write-Host "From your Mac later: ssh cafe" -ForegroundColor Green
Write-Host ""
Write-Host "NEXT on this PC: open Ubuntu and install Dockyard." -ForegroundColor Yellow
Write-Host "Opening power settings..." -ForegroundColor Cyan
Start-Process "ms-settings:powersleep"
