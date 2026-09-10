# Remote cafe PC from your Mac (lid closed)

## The rule

| Mode | What works |
|------|------------|
| **PIN `1122`** | Unlock screen only — **not** remote login |
| **SSH key** (recommended) | Mac → Windows anytime over Tailscale, lid closed |

You need **one physical unlock** of the Windows laptop to install the SSH key. After that, leave it closed and control everything from your Mac.

---

## One-time setup (next time you open the cafe laptop)

### 1. Unlock with PIN, keep lid open for ~5 minutes

### 2. Power (so it stays on when closed)
- Settings → System → Power  
- **When plugged in, lid closed: Do nothing**  
- Sleep: **Never** (plugged in)

### 3. Open PowerShell **as Administrator** and run:

```powershell
irm https://raw.githubusercontent.com/Azonix07/dockyard/main/scripts/windows-one-time-setup.ps1 | iex
```

Or if the repo is already cloned:

```powershell
cd path\to\dockyard
powershell -ExecutionPolicy Bypass -File .\scripts\windows-one-time-setup.ps1
```

That script will:
- Enable OpenSSH Server
- Install your Mac’s SSH public key for user `Abhinand`
- Set firewall rule
- Remind you about WSL + Docker
- Optionally start Dockyard

### 4. On your Mac, test:

```bash
ssh cafe
```

If you see a Windows/PowerShell prompt → **done forever**.

---

## Everyday use (from Mac only)

```bash
# connect
ssh cafe

# or one-shot commands
ssh cafe "wsl -e bash -lc 'cd ~/dockyard && ./infra/up.sh'"
```

From Cursor on Mac you can also open a remote terminal once `ssh cafe` works and tell the agent:  
“SSH to cafe and run …”

### Install / update Dockyard over SSH

```bash
ssh cafe "wsl -e bash -lc '
  set -e
  cd ~
  if [ ! -d dockyard ]; then git clone https://github.com/Azonix07/dockyard.git; fi
  cd dockyard
  git pull
  cp -n .env.example .env || true
  grep -q ADMIN_TOKEN= .env && sed -i \"s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=Xpulse@1142|\" .env
  sed -i \"s|^PUBLIC_HOST=.*|PUBLIC_HOST=abhinand|\" .env
  ./infra/up.sh
'"
```

Dashboard from Mac browser: `http://abhinand:3000`  
(Login token: your `ADMIN_TOKEN`)

---

## Why password SSH failed

Windows Hello **PIN ≠ password**. OpenSSH needs either:
- the real account **password**, or  
- an **SSH key** (what we set up above)

---

## Checklist after one-time setup

- [ ] `ssh cafe` works from Mac  
- [ ] Lid closed + plugged in = stays awake  
- [ ] Tailscale connected on Windows  
- [ ] Docker Desktop set to start with Windows / WSL  
- [ ] Dockyard running (`http://abhinand:3000`)
