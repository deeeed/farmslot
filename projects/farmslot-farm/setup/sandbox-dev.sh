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
  echo "usage: $0 <start|health|stop|test-marker> --gateway-port <port>" >&2
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
REPO_ROOT="${FARMSLOT_SLOT_REPO:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
RUNTIME_DIR="${FARMSLOT_RUNTIME_DIR:-$REPO_ROOT/.sandbox/farmslot-farm/agent}"
PID_FILE="$RUNTIME_DIR/sandbox-dev.pid"
LOG_FILE="$RUNTIME_DIR/sandbox-dev.log"
SHARED_RUNS_MARKER="$RUNTIME_DIR/shared-runs-dir"
SHARED_RUNS_MARKER_LOCK="$RUNTIME_DIR/shared-runs-dir.lock.d"
PORT_ENV="$REPO_ROOT/.env.ports"

mkdir -p "$RUNTIME_DIR"

acquire_shared_runs_marker_lock() {
  local i=0
  while ! mkdir "$SHARED_RUNS_MARKER_LOCK" 2>/dev/null; do
    sleep 0.05
    i=$((i + 1))
    if (( i > 200 )); then
      echo "[sandbox-dev] timed out waiting for shared-runs marker lock" >&2
      return 1
    fi
  done
}

release_shared_runs_marker_lock() {
  rmdir "$SHARED_RUNS_MARKER_LOCK" 2>/dev/null || true
}

read_shared_runs_marker() {
  if [[ ! -f "$SHARED_RUNS_MARKER" ]]; then
    return 1
  fi
  local value=""
  if ! acquire_shared_runs_marker_lock; then
    return 1
  fi
  IFS= read -r value <"$SHARED_RUNS_MARKER" || value=""
  release_shared_runs_marker_lock
  if [[ -z "$value" ]]; then
    return 1
  fi
  printf '%s' "$value"
}

write_shared_runs_marker() {
  local value="$1"
  local tmp="${SHARED_RUNS_MARKER}.tmp.$$"
  if ! acquire_shared_runs_marker_lock; then
    return 1
  fi
  printf '%s\n' "$value" >"$tmp"
  sync "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$SHARED_RUNS_MARKER"
  release_shared_runs_marker_lock
}

clear_shared_runs_marker() {
  if ! acquire_shared_runs_marker_lock; then
    rm -f "$SHARED_RUNS_MARKER"
    return 0
  fi
  rm -f "$SHARED_RUNS_MARKER"
  release_shared_runs_marker_lock
}

if [[ -f "$PORT_ENV" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$PORT_ENV"
  set +a
fi

# Canonical operator ports for the primary worktree (see docs/operations/worktree-operator-model.md).
OPERATOR_GATEWAY_PORT="${GATEWAY_PORT:-}"
OPERATOR_VITE_PORT="${VITE_PORT:-}"

read_primary_repo() {
  local project_json="$REPO_ROOT/projects/farmslot-farm/project.json"
  [[ -f "$project_json" ]] || return 1
  node -e "
    const fs = require('fs');
    const project = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    process.stdout.write(String(project.primary_repo || '').trim());
  " "$project_json"
}

is_primary_checkout() {
  local primary_repo
  primary_repo="$(read_primary_repo)" || return 1
  [[ "$(cd "$REPO_ROOT" && pwd -P)" == "$(cd "$primary_repo" && pwd -P)" ]]
}

PRIMARY_CHECKOUT=0
if is_primary_checkout; then
  PRIMARY_CHECKOUT=1
  # Main worktree: operator gateway + Command Center UI — never an isolated slot port.
  if [[ ! "$OPERATOR_GATEWAY_PORT" =~ ^[0-9]+$ || ! "$OPERATOR_VITE_PORT" =~ ^[0-9]+$ ]]; then
    echo "[sandbox-dev] primary worktree must set GATEWAY_PORT and VITE_PORT in .env.ports" >&2
    exit 1
  fi
  GATEWAY_PORT="$OPERATOR_GATEWAY_PORT"
  VITE_PORT="$OPERATOR_VITE_PORT"
else
  # Worktree sandboxes get isolated ports from their own .env.ports.
  GATEWAY_PORT="$SLOT_GATEWAY_PORT"
  VITE_PORT="${VITE_PORT:-}"
  if [[ -z "$VITE_PORT" || "$VITE_PORT" == "5174" ]]; then
    echo "[sandbox-dev] worktree sandbox must set VITE_PORT in .env.ports (cannot use operator UI :5174)" >&2
    exit 1
  fi
fi
export GATEWAY_PORT
export VITE_PORT

# Worktree sandboxes boot an isolated gateway, but operators still expect the
# canonical run history from the primary checkout. Share read/write .runs only
# when this checkout is not the primary_repo (explicit FARMSLOT_RUNS_DIR wins).
resolve_primary_runs_dir() {
  if [[ "$PRIMARY_CHECKOUT" == 1 || -n "${FARMSLOT_RUNS_DIR:-}" ]]; then
    return 0
  fi
  local primary_repo
  primary_repo="$(read_primary_repo)" || return 0
  local primary_runs="$primary_repo/.runs"
  if [[ -d "$primary_runs" ]]; then
    export FARMSLOT_RUNS_DIR="$primary_runs"
    echo "[sandbox-dev] sharing run history from ${FARMSLOT_RUNS_DIR}"
  fi
}

gateway_health() {
  curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1
}

ui_health() {
  curl -sf "http://127.0.0.1:${VITE_PORT}/" >/dev/null 2>&1 \
    || curl -sf -g "http://[::1]:${VITE_PORT}/" >/dev/null 2>&1
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
  clear_shared_runs_marker
}

wait_for_gateway() {
  local max="${1:-90}"
  local i=0
  while (( i < max )); do
    if gateway_health; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

wait_for_ui() {
  local max="${1:-90}"
  local i=0
  while (( i < max )); do
    if ui_health; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

case "$ACTION" in
  health)
    if [[ "$PRIMARY_CHECKOUT" == 1 ]]; then
      if gateway_health && ui_health; then
        echo "[sandbox-dev] primary checkout — operator gateway :${GATEWAY_PORT}, Command Center :${VITE_PORT}"
        exit 0
      fi
      if ! gateway_health; then
        echo "[sandbox-dev] primary checkout — operator gateway not healthy on :${GATEWAY_PORT}" >&2
      fi
      if ! ui_health; then
        echo "[sandbox-dev] primary checkout — Command Center not reachable on :${VITE_PORT}" >&2
      fi
      exit 1
    fi
    if gateway_health && ui_health; then
      echo "[sandbox-dev] gateway healthy on :${GATEWAY_PORT}, UI on :${VITE_PORT}"
      exit 0
    fi
    if ! gateway_health; then
      echo "[sandbox-dev] gateway not healthy on :${GATEWAY_PORT}" >&2
    fi
    if ! ui_health; then
      echo "[sandbox-dev] Command Center not reachable on :${VITE_PORT}" >&2
    fi
    exit 1
    ;;
  stop)
    if [[ "$PRIMARY_CHECKOUT" == 1 ]]; then
      echo "[sandbox-dev] primary checkout — not stopping operator gateway on :${GATEWAY_PORT}"
      exit 0
    fi
    stop_sandbox_dev
    echo "[sandbox-dev] stopped sandbox dev on :${GATEWAY_PORT}"
    ;;
  start)
    if [[ "$PRIMARY_CHECKOUT" == 1 ]]; then
      if gateway_health && ui_health; then
        echo "[sandbox-dev] primary checkout — operator gateway :${GATEWAY_PORT}, Command Center :${VITE_PORT}"
        exit 0
      fi
      if ! gateway_health; then
        echo "[sandbox-dev] primary checkout — start operator stack: bash scripts/dev.sh (gateway :${GATEWAY_PORT}, UI :${VITE_PORT})" >&2
        exit 1
      fi
      echo "[sandbox-dev] primary checkout — gateway :${GATEWAY_PORT} up; start Command Center on :${VITE_PORT} (bash scripts/dev.sh)" >&2
      exit 1
    fi

    resolve_primary_runs_dir

    if gateway_health && ui_health; then
      if [[ -z "${FARMSLOT_RUNS_DIR:-}" ]]; then
        echo "[sandbox-dev] gateway and UI already healthy on :${GATEWAY_PORT}/:${VITE_PORT} — skipping start"
        exit 0
      fi
      active_shared_runs=""
      if active_shared_runs="$(read_shared_runs_marker)"; then
        :
      else
        active_shared_runs=""
      fi
      if [[ "$active_shared_runs" == "$FARMSLOT_RUNS_DIR" ]]; then
        echo "[sandbox-dev] gateway and UI already healthy on :${GATEWAY_PORT}/:${VITE_PORT} with shared run history from ${FARMSLOT_RUNS_DIR}"
        exit 0
      fi
      echo "[sandbox-dev] restarting gateway on :${GATEWAY_PORT} to apply shared run history"
    fi

    stop_sandbox_dev

    echo "[sandbox-dev] starting gateway :${GATEWAY_PORT} ui :${VITE_PORT} (tsx watch)"
    : >"$LOG_FILE"
    (
      cd "$REPO_ROOT"
      export GATEWAY_PORT="$GATEWAY_PORT"
      export VITE_PORT="$VITE_PORT"
      # The isolated self-integration pool is keyed by farmslot-demo. Register
      # this stack's co-launched node under the same identity so node-backed
      # exec, attachments, file watches, and metrics exercise the sandbox
      # instead of silently falling back to the physical host node.
      export MACHINE_NAME="${MACHINE_NAME:-farmslot-demo}"
      # This is a per-worktree validation/recipe stack, not the control plane. It
      # shares the operator's run history (FARMSLOT_RUNS_DIR) for read-only display,
      # so it must NOT orchestrate: run recovery here would re-drive the operator's
      # in-flight prepare and kill the operator's live prepare-* tmux window.
      export FARMSLOT_DISABLE_ORCHESTRATION=1
      export VITE_FARMSLOT_DEMO_BANNER="${VITE_FARMSLOT_DEMO_BANNER:-}"
      if [[ -n "${FARMSLOT_RUNS_DIR:-}" ]]; then
        export FARMSLOT_RUNS_DIR
      fi
      exec bash scripts/dev.sh
    ) >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"

    if wait_for_gateway 90 && wait_for_ui 90; then
      if [[ -n "${FARMSLOT_RUNS_DIR:-}" ]]; then
        write_shared_runs_marker "$FARMSLOT_RUNS_DIR"
      else
        clear_shared_runs_marker
      fi
      echo "[sandbox-dev] ready — gateway http://127.0.0.1:${GATEWAY_PORT} ui http://127.0.0.1:${VITE_PORT}"
      echo "[sandbox-dev] log: ${LOG_FILE}"
      exit 0
    fi

    if ! gateway_health; then
      echo "[sandbox-dev] gateway did not become healthy — tail ${LOG_FILE}" >&2
    else
      echo "[sandbox-dev] Command Center did not become reachable on :${VITE_PORT} — tail ${LOG_FILE}" >&2
    fi
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
    ;;
  test-marker)
    test_dir="$(mktemp -d "${TMPDIR:-/tmp}/sandbox-dev-marker.XXXXXX")"
    SHARED_RUNS_MARKER="$test_dir/shared-runs-dir"
    SHARED_RUNS_MARKER_LOCK="$test_dir/shared-runs-dir.lock.d"
    trap 'rm -rf "$test_dir"' EXIT

    write_shared_runs_marker "/tmp/primary/.runs"
    read_back="$(read_shared_runs_marker)" || {
      echo "read after write failed" >&2
      exit 1
    }
    [[ "$read_back" == "/tmp/primary/.runs" ]] || {
      echo "marker mismatch: got '$read_back'" >&2
      exit 1
    }

    tmp_seen=""
    (
      write_shared_runs_marker "/tmp/primary/.runs-concurrent"
    ) &
    wait_back="$!"
    if read_shared_runs_marker >/dev/null 2>&1; then
      tmp_seen=1
    fi
    wait "$wait_back"
    final="$(read_shared_runs_marker)"
    [[ "$final" == "/tmp/primary/.runs-concurrent" ]] || {
      echo "concurrent final mismatch: '$final'" >&2
      exit 1
    }

    clear_shared_runs_marker
    if read_shared_runs_marker >/dev/null 2>&1; then
      echo "marker still present after clear" >&2
      exit 1
    fi

    echo "sandbox-dev marker tests: ok"
    exit 0
    ;;
  *)
    usage
    ;;
esac
