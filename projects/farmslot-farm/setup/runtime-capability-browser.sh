#!/usr/bin/env bash
# Own the Farmslot browser/CDP provider without guessing at unrelated Chrome processes.
set -euo pipefail

MODE="${1:-}"
shift || true

CDP_PORT=""
UI_URL=""

usage() {
  echo "usage: $0 start|health|stop --cdp-port <port> [--ui-url <url>]" >&2
  exit 2
}

require_value() {
  [[ -n "${2:-}" && "${2:-}" != --* ]] || usage
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cdp-port)
      require_value "$1" "${2:-}"
      CDP_PORT="$2"
      shift 2
      ;;
    --ui-url)
      require_value "$1" "${2:-}"
      UI_URL="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$MODE" == "start" || "$MODE" == "health" || "$MODE" == "stop" ]] || usage
[[ "$CDP_PORT" =~ ^[1-9][0-9]*$ ]] || usage

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${FARMSLOT_SLOT_REPO:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
PROFILE="${FARMSLOT_CDP_PROFILE:-${HOME}/.chrome-farmslot-${CDP_PORT}}"
CDP_ENDPOINT="http://127.0.0.1:${CDP_PORT}/json/version"

profile_owner_pid() {
  local link
  link="$(readlink "${PROFILE}/SingletonLock" 2>/dev/null)" || return 1
  [[ "$link" =~ -([0-9]+)$ ]] || return 1
  kill -0 "${BASH_REMATCH[1]}" 2>/dev/null || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

owner_matches_provider() {
  local command
  command="$(ps -ww -p "$1" -o command= 2>/dev/null)" || return 1
  [[ "$command " == *"--remote-debugging-port=${CDP_PORT} "* ]] &&
    [[ "$command " == *"--user-data-dir=${PROFILE} "* ]]
}

owner_holds_endpoint() {
  command -v lsof >/dev/null 2>&1 || return 1
  local listeners
  listeners="$(lsof -nP -iTCP:"${CDP_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u)" || return 1
  [[ "$listeners" == "$1" ]]
}

case "$MODE" in
  start)
    FARMSLOT_CDP_PORT="$CDP_PORT" \
      FARMSLOT_CDP_PROFILE="$PROFILE" \
      FARMSLOT_UI_URL="$UI_URL" \
      bash "${REPO_ROOT}/apps/command-center/scripts/debug-chrome.sh" \
      --port "$CDP_PORT" --profile "$PROFILE" --url "$UI_URL"
    ;;
  health)
    owner="$(profile_owner_pid)" || {
      echo "browser provider profile has no live owner: ${PROFILE}" >&2
      exit 1
    }
    owner_matches_provider "$owner" || {
      echo "browser provider profile owner does not match CDP :${CDP_PORT}" >&2
      exit 1
    }
    owner_holds_endpoint "$owner" || {
      echo "browser provider pid ${owner} does not own CDP endpoint :${CDP_PORT}" >&2
      exit 1
    }
    curl -fsS "$CDP_ENDPOINT" >/dev/null
    ;;
  stop)
    if ! curl -fsS "$CDP_ENDPOINT" >/dev/null 2>&1; then
      exit 0
    fi
    owner="$(profile_owner_pid)" || {
      echo "refusing to stop unowned CDP endpoint :${CDP_PORT}" >&2
      exit 1
    }
    owner_matches_provider "$owner" || {
      echo "refusing to stop mismatched Chrome pid ${owner}" >&2
      exit 1
    }
    owner_holds_endpoint "$owner" || {
      echo "refusing to stop pid ${owner}; it does not own CDP endpoint :${CDP_PORT}" >&2
      exit 1
    }
    kill -TERM "$owner"
    for _ in $(seq 1 50); do
      kill -0 "$owner" 2>/dev/null || exit 0
      sleep 0.1
    done
    echo "Chrome pid ${owner} did not stop after SIGTERM" >&2
    exit 1
    ;;
esac
