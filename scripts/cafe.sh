#!/usr/bin/env bash
# Easy helper from Mac → cafe Windows PC over Tailscale
set -euo pipefail

CMD="${1:-}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/cafe.sh              # open interactive SSH shell
  ./scripts/cafe.sh status       # ping + check ports
  ./scripts/cafe.sh wsl          # open WSL Ubuntu shell on cafe PC
  ./scripts/cafe.sh up           # git pull + start Dockyard in WSL
  ./scripts/cafe.sh 'dir'        # run arbitrary remote command
EOF
}

case "$CMD" in
  "" )
    exec ssh cafe
    ;;
  status )
    echo "Tailscale / ping:"
    ping -c 1 -t 3 abhinand 2>&1 | tail -3 || true
    echo
    echo "Ports:"
    for p in 22 3000 8080 80; do
      if nc -z -G 2 abhinand $p 2>/dev/null; then echo "  OPEN  $p"; else echo "  closed $p"; fi
    done
    echo
    echo "API health:"
    curl -sS -m 5 http://abhinand:8080/api/health || echo "(not Dockyard or not up)"
    echo
    ;;
  wsl )
    exec ssh cafe "wsl -d Ubuntu -e bash -l"
    ;;
  up )
    ssh cafe "wsl -d Ubuntu -e bash -lc '
      set -e
      cd \"\$HOME\"
      if [ ! -d dockyard ]; then git clone https://github.com/Azonix07/dockyard.git; fi
      cd dockyard
      git pull --ff-only || true
      [ -f .env ] || cp .env.example .env
      sed -i \"s|^PUBLIC_HOST=.*|PUBLIC_HOST=abhinand|\" .env || true
      ./infra/up.sh
    '"
    ;;
  -h|--help|help )
    usage
    ;;
  * )
    ssh cafe "$@"
    ;;
esac
