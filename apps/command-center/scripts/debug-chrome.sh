#!/usr/bin/env bash
# Launch a dedicated Chrome with CDP enabled for Farmslot UI debugging.
#
# - Reuses the existing session if CDP is already listening on $FARMSLOT_CDP_PORT.
# - Uses a dedicated per-port profile ($FARMSLOT_CDP_PROFILE) to avoid clobbering the user's
#   main Chrome. The profile is keyed by port because Chrome holds a singleton lock on
#   --user-data-dir: sharing one profile across slots means the second slot's launch hands off
#   to the first instance and exits, leaving its CDP port unreachable.
# - Defaults to port 9323 to avoid conflicts with other tooling (9222 is Chrome's well-known
#   default and is used by example-browser; 4355 is already reserved for another flow).
#
# Flags (preferred) or the equivalent env vars:
#   --slot <id>       resolve --port from that slot's resources.dev-server.cdp_port
#   --pool <dir>      FARMSLOT_POOL_DIR      where --slot looks (default <repo>/pool).
#                     Fleet configs are machine-local, so a worktree has no fleet of its own —
#                     point this at the checkout that owns it.
#   --port <n>        FARMSLOT_CDP_PORT      (default 9323)
#   --profile <dir>   FARMSLOT_CDP_PROFILE   (default ~/.chrome-farmslot-<port>)
#   --url <url>       FARMSLOT_UI_URL
#   --headless        FARMSLOT_CDP_HEADLESS=1
#   --timeout <secs>  FARMSLOT_CDP_TIMEOUT   (default 15)
#   --help

set -euo pipefail

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

ARG_SLOT=""; ARG_POOL=""; ARG_PORT=""; ARG_PROFILE=""; ARG_URL=""; ARG_TIMEOUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) ARG_SLOT="${2:-}"; shift 2 ;;
    --pool) ARG_POOL="${2:-}"; shift 2 ;;
    --port) ARG_PORT="${2:-}"; shift 2 ;;
    --profile) ARG_PROFILE="${2:-}"; shift 2 ;;
    --url) ARG_URL="${2:-}"; shift 2 ;;
    --timeout) ARG_TIMEOUT="${2:-}"; shift 2 ;;
    --headless) FARMSLOT_CDP_HEADLESS=1; shift ;;
    -h|--help) usage ;;
    *) echo "[debug-chrome] unknown argument: $1" >&2; echo "Next: run with --help" >&2; exit 2 ;;
  esac
done

PORT="${ARG_PORT:-${FARMSLOT_CDP_PORT:-9323}}"
PROFILE="${ARG_PROFILE:-${FARMSLOT_CDP_PROFILE:-}}"
TIMEOUT_SECS="${ARG_TIMEOUT:-${FARMSLOT_CDP_TIMEOUT:-15}}"
CHROME="${FARMSLOT_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
HEADLESS="${FARMSLOT_CDP_HEADLESS:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FARMSLOT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEFAULT_UI_PORT="5174"
if [[ -f "$FARMSLOT_ROOT/.env.ports" ]]; then
  configured_vite_port="$(awk -F= '/^VITE_PORT=/ { print $2; exit }' "$FARMSLOT_ROOT/.env.ports" | tr -d '[:space:]')"
  if [[ "$configured_vite_port" =~ ^[0-9]+$ ]]; then
    DEFAULT_UI_PORT="$configured_vite_port"
  fi
fi
POOL_DIR="${ARG_POOL:-${FARMSLOT_POOL_DIR:-$FARMSLOT_ROOT/pool}}"
if [[ -n "$ARG_SLOT" ]]; then
  slot_port="$(node -e '
    const fs=require("fs"),path=require("path");
    const dir=process.argv[1]; const want=process.argv[2];
    for (const f of fs.readdirSync(dir).filter((n)=>n.endsWith(".json"))) {
      let d; try { d=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8")); } catch { continue; }
      for (const s of d.slots ?? []) {
        if (s.id === want) { const p=s.resources?.["dev-server"]?.cdp_port; if (p) { console.log(p); process.exit(0); } }
      }
    }
    process.exit(1);
  ' "$POOL_DIR" "$ARG_SLOT" 2>/dev/null)" || {
    echo "[debug-chrome] slot '${ARG_SLOT}' not found with a resources.dev-server.cdp_port in ${POOL_DIR}/*.json" >&2
    echo "Next: fleet configs are machine-local, so a worktree has no fleet of its own." >&2
    echo "      Point at the checkout that owns it with --pool <dir>, or pass --port explicitly." >&2
    exit 1
  }
  PORT="$slot_port"
fi
PROFILE="${PROFILE:-$HOME/.chrome-farmslot-$PORT}"
URL="${ARG_URL:-${FARMSLOT_UI_URL:-http://localhost:${DEFAULT_UI_PORT}/}}"

if curl -sf "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "[debug-chrome] CDP already listening on :${PORT} — reusing existing session"
  echo "[debug-chrome] endpoints:  http://localhost:${PORT}/json"
  if [[ -n "$URL" ]]; then
    url_js="$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$URL")"
    FARMSLOT_CDP_PORT="$PORT" node "$SCRIPT_DIR/cdp.mjs" eval "-" \
      "window.location.href=${url_js}; await new Promise((r) => setTimeout(r, 2000)); true" \
      >/dev/null 2>&1 \
      || echo "[debug-chrome] warn: could not navigate reused session to ${URL}" >&2
  fi
  exit 0
fi

if [[ ! -x "$CHROME" ]]; then
  echo "[debug-chrome] chrome binary not found at: $CHROME" >&2
  echo "[debug-chrome] set FARMSLOT_CHROME=/path/to/chrome to override" >&2
  exit 1
fi

mkdir -p "$PROFILE"

echo "[debug-chrome] launching Chrome  port=${PORT}  profile=${PROFILE}  url=${URL}"
CHROME_ARGS=(
  --remote-debugging-port="$PORT"
  --remote-allow-origins='*'
  --user-data-dir="$PROFILE"
  --no-first-run
  --no-default-browser-check
  --disable-notifications
  --deny-permission-prompts
)
if [[ "$HEADLESS" == "1" || "$HEADLESS" == "true" || "$HEADLESS" == "yes" ]]; then
  CHROME_ARGS+=(--headless=new --disable-gpu)
else
  # ScreenCaptureKit treats windows on secondary/virtual spaces as off-screen.
  # Pin headed CDP Chrome to the primary display so capture-helper can record.
  CHROME_ARGS+=(--window-position=200,150 --window-size=1200,800)
fi
if [[ "$CHROME" == "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]] \
  && command -v open >/dev/null 2>&1; then
  # macOS routes direct Chrome binary invocations into the already-running GUI
  # instance, which can drop the requested CDP port and immediately exit.
  # `open -na` forces a separate app instance for both headed capture and
  # headless validation profiles.
  open -na "Google Chrome" --args "${CHROME_ARGS[@]}" "$URL" >/dev/null 2>&1
else
  "$CHROME" "${CHROME_ARGS[@]}" "$URL" >/dev/null 2>&1 &
fi

# Wait for CDP so callers can chain `scripts/cdp.mjs` immediately.
attempts=$(( TIMEOUT_SECS * 5 ))
for _ in $(seq 1 "$attempts"); do
  if curl -sf "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
    echo "[debug-chrome] ready on :${PORT}"
    exit 0
  fi
  sleep 0.2
done

echo "[debug-chrome] CDP did not come up on :${PORT} within ${TIMEOUT_SECS}s (profile ${PROFILE})" >&2
if pgrep -f -- "--user-data-dir=${PROFILE}" >/dev/null 2>&1; then
  echo "Next: a Chrome already owns this profile. Chrome holds a singleton lock on --user-data-dir," >&2
  echo "      so a second launch hands off to it and exits without binding the port. Use a different" >&2
  echo "      --profile, or stop that instance." >&2
else
  echo "Next: raise --timeout if this machine is slow to start Chrome, or run without --headless to" >&2
  echo "      see the launch failure. Verify the binary at: ${CHROME}" >&2
fi
exit 1
