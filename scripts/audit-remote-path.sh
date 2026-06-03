#!/usr/bin/env bash
# audit-remote-path.sh — probe every remote machine for the binaries the
# farmslot pipeline relies on (tmux + lsof + ffmpeg + node + python3).
#
# Walks every pool/*.json, skips machines flagged as local (host matches the
# current hostname OR the literal "LOCAL"), SSHs the rest with `command -v`,
# prints a table, and exits non-zero when any binary is missing.
#
# Usage: bash scripts/audit-remote-path.sh [--binaries tmux,lsof,...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POOL_DIR="${POOL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/pool}"
BINARIES="tmux lsof ffmpeg node python3"

while [ $# -gt 0 ]; do
  case "$1" in
    --binaries)
      BINARIES="$(echo "$2" | tr ',' ' ')"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--binaries tmux,lsof,ffmpeg,node,python3]"
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# shellcheck source=lib/slot-common.sh
source "$SCRIPT_DIR/lib/slot-common.sh"

if [ ! -d "$POOL_DIR" ]; then
  echo "FAIL: pool dir not found at $POOL_DIR" >&2
  exit 2
fi

printf '%-10s %-25s %-10s %s\n' 'MACHINE' 'HOST' 'BINARY' 'STATUS'
printf '%-10s %-25s %-10s %s\n' '-------' '----' '------' '------'

missing=0
checked=0

for f in "$POOL_DIR"/*.json; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in
    *.bak.*|example.json|farmslot-demo.json) continue ;;
  esac

  machine="$(python3 -c "import json,sys; print(json.load(open('$f'))['machine'])" 2>/dev/null || echo "")"
  host="$(python3 -c "import json,sys; print(json.load(open('$f'))['host'])" 2>/dev/null || echo "")"
  # ssh_user is optional in pool JSON; fall back to the operator's local user to
  # mirror openssh's default. Without this the probe SSHs as $USER everywhere,
  # which fails on fleets where the login name differs per machine.
  ssh_user="$(python3 -c "import json,sys; d=json.load(open('$f')); print(d.get('ssh_user') or '')" 2>/dev/null || echo "")"
  [ -z "$machine" ] || [ -z "$host" ] && continue

  if is_local "$host" "$machine"; then
    continue
  fi

  if [ -n "$ssh_user" ]; then
    ssh_target="${ssh_user}@${host}"
  else
    ssh_target="$host"
  fi

  # Probe all binaries in one SSH round-trip.
  cmd="for b in $BINARIES; do printf '%s=%s\n' \"\$b\" \"\$(command -v \"\$b\" 2>/dev/null || echo MISSING)\"; done"
  if ! output="$(ssh -o BatchMode=yes -o ConnectTimeout=5 "$ssh_target" "$cmd" 2>/dev/null)"; then
    for b in $BINARIES; do
      printf '%-10s %-25s %-10s %s\n' "$machine" "$host" "$b" "UNREACHABLE"
      missing=$((missing + 1))
      checked=$((checked + 1))
    done
    continue
  fi

  while IFS='=' read -r bin resolved; do
    checked=$((checked + 1))
    if [ "$resolved" = "MISSING" ] || [ -z "$resolved" ]; then
      printf '%-10s %-25s %-10s %s\n' "$machine" "$host" "$bin" "MISSING"
      missing=$((missing + 1))
    else
      printf '%-10s %-25s %-10s %s\n' "$machine" "$host" "$bin" "$resolved"
    fi
  done <<< "$output"
done

echo
if [ "$missing" -eq 0 ]; then
  echo "OK: all $checked binaries present across remote machines."
  exit 0
fi
echo "FAIL: $missing/$checked binaries missing or unreachable." >&2
exit 1
