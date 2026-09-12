#!/usr/bin/env bash
# Writes live host health JSON for Runbase admin Device tab.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${HOST_HEALTH_DIR:-$ROOT/data}"
OUT_FILE="$OUT_DIR/host-health.json"
HISTORY_FILE="$OUT_DIR/host-health-history.jsonl"
PS="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
SCRIPT="$ROOT/scripts/host-health.ps1"
INTERVAL="${HOST_HEALTH_INTERVAL:-15}"

mkdir -p "$OUT_DIR"

echo "[host-health] writing to $OUT_FILE every ${INTERVAL}s"

while true; do
  if [[ ! -x "$PS" && ! -f "$PS" ]]; then
    echo "{\"available\":false,\"error\":\"powershell missing\",\"sampledAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >"$OUT_FILE"
    sleep "$INTERVAL"
    continue
  fi

  if json="$("$PS" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT" 2>/dev/null | tr -d '\r')"; then
    json="${json#"${json%%[![:space:]]*}"}"
    if [[ -n "$json" && "$json" == \{* ]]; then
      printf '%s\n' "$json" >"$OUT_FILE.tmp"
      mv "$OUT_FILE.tmp" "$OUT_FILE"
      # Append compact sample for energy integration (keep ~24h via rotate)
      watts=$(printf '%s' "$json" | sed -n 's/.*"watts":\([0-9.][0-9.]*\).*/\1/p' | head -1)
      ts=$(printf '%s' "$json" | sed -n 's/.*"sampledAt":"\([^"]*\)".*/\1/p' | head -1)
      if [[ -n "$watts" && -n "$ts" ]]; then
        printf '{"t":"%s","w":%s}\n' "$ts" "$watts" >>"$HISTORY_FILE"
        if [[ -f "$HISTORY_FILE" ]]; then
          lines=$(wc -l <"$HISTORY_FILE" | tr -d ' ')
          if [[ "$lines" -gt 6000 ]]; then
            tail -n 5000 "$HISTORY_FILE" >"$HISTORY_FILE.tmp"
            mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
          fi
        fi
      fi
    else
      echo "{\"available\":false,\"error\":\"empty collector output\",\"sampledAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >"$OUT_FILE"
    fi
  else
    echo "{\"available\":false,\"error\":\"collector failed\",\"sampledAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >"$OUT_FILE"
  fi
  sleep "$INTERVAL"
done
