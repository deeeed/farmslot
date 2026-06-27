#!/usr/bin/env bash
# Per-worktree gateway + Command Center UI bootstrap for farmslot-farm sandboxes.
#
# Worktree slots own their dev stack (tsx watch via scripts/dev.sh) — not the
# global `farmslot up` pidfile. Each checkout uses .env.ports for GATEWAY_PORT /
# VITE_PORT isolation.
#
# Usage (from slot prepare hooks):
#   bash projects/farmslot-farm/setup/sandbox-dev.sh start --gateway-port 8808
#   bash projects/farmslot-farm/setup/sandbox-dev.sh health --gateway-port 8808
#   bash projects/farmslot-farm/setup/sandbox-dev.sh stop --gateway-port 8808
set -euo pipefail

ACTION="${1:-}"
GATEWAY_PORT=""
VITE_PORT=""

usage() {
  echo "usage: $0 <start|health|stop> --gateway-port <port>" >&2
  exit 1
}

[[ -n "$ACTION" ]] || usage
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway-port)
      GATEWAY_PORT="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ "$GATEWAY_PORT" =~ ^[0-9]+$ ]] || usage

SLOT_GATEWAY_PORT="$GATEWAY_PORT"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNTIME_DIR="${FARMSLOT_RUNTIME_DIR:-$REPO_ROOT/.sandbox/farmslot-farm/agent}"
PID_FILE="$RUNTIME_DIR/sandbox-dev.pid"
LOG_FILE="$RUNTIME_DIR/sandbox-dev.log"
PORT_ENV="$REPO_ROOT/.env.ports"

mkdir -p "$RUNTIME_DIR"

if [[ -f "$PORT_ENV" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$PORT_ENV"
  set +a
fi

# Pool slot port wins over .env.ports (prepare passes --gateway-port {{port}}).
GATEWAY_PORT="$SLOT_GATEWAY_PORT"
export GATEWAY_PORT
VITE_PORT="${VITE_PORT:-5174}"
export VITE_PORT

gateway_health() {
  curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1
}

kill_port_listeners() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
}

stop_sandbox_dev() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  kill_port_listeners "$GATEWAY_PORT"
  kill_port_listeners "$VITE_PORT"
}

wait_for_gateway() {
  local max="${1:-90}"
  local i=0
  while (( i < max )); do
    if gateway_health; then
      return 0
    fi
    sleep 1
    ((i++))
  done
  return 1
}

case "$ACTION" in
  health)
    if gateway_health; then
      echo "[sandbox-dev] gateway healthy on :${GATEWAY_PORT}"
      exit 0
    fi
    echo "[sandbox-dev] gateway not healthy on :${GATEWAY_PORT}" >&2
    exit 1
    ;;
  stop)
    stop_sandbox_dev
    echo "[sandbox-dev] stopped sandbox dev on :${GATEWAY_PORT}"
    ;;
  start)
    if gateway_health; then
      echo "[sandbox-dev] gateway already healthy on :${GATEWAY_PORT} — skipping start"
      exit 0
    fi

    stop_sandbox_dev

    echo "[sandbox-dev] starting gateway :${GATEWAY_PORT} ui :${VITE_PORT} (tsx watch)"
    : >"$LOG_FILE"
    (
      cd "$REPO_ROOT"
      GATEWAY_PORT="$GATEWAY_PORT" VITE_PORT="$VITE_PORT" exec bash scripts/dev.sh
    ) >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"

    if wait_for_gateway 90; then
      echo "[sandbox-dev] ready — gateway http://127.0.0.1:${GATEWAY_PORT} ui http://127.0.0.1:${VITE_PORT}"
      echo "[sandbox-dev] log: ${LOG_FILE}"
      exit 0
    fi

    echo "[sandbox-dev] gateway did not become healthy — tail ${LOG_FILE}" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
    ;;
  *)
    usage
    ;;
esac