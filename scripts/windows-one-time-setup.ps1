#Requires -RunAsAdministrator
<#
  Dockyard — one-time Windows setup for remote Mac access over Tailscale.
  Run once while the cafe laptop is unlocked.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\scripts\windows-one-time-setup.ps1
#>

$ErrorActionPreference = "Stop"
$UserName = "Abhinand"

# Mac public key (generated on owner's MacBook for Host cafe)
$PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOKOFZovhXOxDYDmvgg7Eoa0Rl+h6ECMwk5NvPp+rQ7v dockyard-mac-to-cafe"

Write-Host "==> Installing OpenSSH Server (if needed)..." -ForegroundColor Cyan
$cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
if ($cap.State -ne 'Installed') {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
}

Write-Host "==> Starting sshd..." -ForegroundColor Cyan
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

Write-Host "==> Firewall rule for SSH..." -ForegroundColor Cyan
if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

# Per-user authorized_keys (works for passwordless key login)
$userProfile = "C:\Users\$UserName"
if (-not (Test-Path $userProfile)) {
  Write-Host "ERROR: Profile not found: $userProfile" -ForegroundColor Red
  Write-Host "Edit `$UserName in this script to match the real Windows account folder name." -ForegroundColor Yellow
  exit 1
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

# Permissions: only that user should read authorized_keys
icacls $sshDir /inheritance:r | Out-Null
icacls $sshDir /grant:r "$UserName:(OI)(CI)F" | Out-Null
icacls $authKeys /inheritance:r | Out-Null
icacls $authKeys /grant:r "$UserName:F" | Out-Null

# Administrators_authorized_keys fallback (some Windows OpenSSH builds)
$adminKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
# Only write admin keys if user is admin — skip by default to avoid locking others out

Write-Host "==> Enabling password + publickey auth in sshd_config..." -ForegroundColor Cyan
$sshdConfig = "C:\ProgramData\ssh\sshd_config"
if (Test-Path $sshdConfig) {
  (Get-Content $sshdConfig) `
    -replace '(?m)^#?PubkeyAuthentication\s+.*', 'PubkeyAuthentication yes' `
    -replace '(?m)^#?PasswordAuthentication\s+.*', 'PasswordAuthentication yes' `
    | Set-Content $sshdConfig
  Restart-Service sshd
}

Write-Host ""
Write-Host "SSH key installed for $UserName." -ForegroundColor Green
Write-Host "From your Mac, run:  ssh cafe" -ForegroundColor Green
Write-Host ""
Write-Host "Next checks on this PC:" -ForegroundColor Yellow
Write-Host "  1) Power: lid closed + plugged in = Do nothing / Never sleep"
Write-Host "  2) Install Docker Desktop + WSL2 Ubuntu if missing"
Write-Host "  3) Tailscale connected"
Write-Host "  4) In WSL: clone dockyard and run ./infra/up.sh"
Write-Host ""

# Offer to open power settings
Write-Host "Opening power settings..." -ForegroundColor Cyan
Start-Process "ms-settings:powersleep"
