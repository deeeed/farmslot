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
#   --slot <id>       resolve --port from the cdp_port of any of that slot's resources
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

usage() {
  cat <<'USAGE'
Launch a dedicated Chrome with CDP enabled for Farmslot UI debugging.

Chrome holds a singleton lock on --user-data-dir, so the profile is keyed by port:
two slots with different CDP ports each get their own profile and can run at once.

  --slot <id>       resolve the port from that slot's cdp_port in the fleet config
  --pool <dir>      where --slot looks (default <repo>/pool). Fleet configs are
                    machine-local, so a worktree has no fleet of its own.
  --port <n>        CDP port (default 9323)
  --profile <dir>   user-data-dir (default ~/.chrome-farmslot-<port>)
  --url <url>       page to open
  --headless        run headless
  --timeout <secs>  how long to wait for CDP (default 15)
  --help

Env equivalents: FARMSLOT_CDP_PORT, FARMSLOT_POOL_DIR, FARMSLOT_CDP_PROFILE,
FARMSLOT_UI_URL, FARMSLOT_CDP_HEADLESS, FARMSLOT_CDP_TIMEOUT, FARMSLOT_CHROME.
USAGE
  exit 0
}

need_value() {
  # Reject any leading dash: `--port -h` should report a missing value, not consume
  # the next flag as one.
  [[ -n "${2:-}" && "${2:0:1}" != "-" ]] || {
    echo "[debug-chrome] $1 requires a value" >&2; echo "Next: run with --help" >&2; exit 2
  }
}

ARG_SLOT=""; ARG_POOL=""; ARG_PORT=""; ARG_PROFILE=""; ARG_URL=""; ARG_TIMEOUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) need_value "$1" "${2:-}"; ARG_SLOT="$2"; shift 2 ;;
    --pool) need_value "$1" "${2:-}"; ARG_POOL="$2"; shift 2 ;;
    --port) need_value "$1" "${2:-}"; ARG_PORT="$2"; shift 2 ;;
    --profile) need_value "$1" "${2:-}"; ARG_PROFILE="$2"; shift 2 ;;
    --url) need_value "$1" "${2:-}"; ARG_URL="$2"; shift 2 ;;
    --timeout) need_value "$1" "${2:-}"; ARG_TIMEOUT="$2"; shift 2 ;;
    --headless) FARMSLOT_CDP_HEADLESS=1; shift ;;
    -h|--help) usage ;;
    *) echo "[debug-chrome] unknown argument: $1" >&2; echo "Next: run with --help" >&2; exit 2 ;;
  esac
done

PORT="${ARG_PORT:-${FARMSLOT_CDP_PORT:-9323}}"
PROFILE="${ARG_PROFILE:-${FARMSLOT_CDP_PROFILE:-}}"
TIMEOUT_SECS="${ARG_TIMEOUT:-${FARMSLOT_CDP_TIMEOUT:-15}}"
[[ "$TIMEOUT_SECS" =~ ^[1-9][0-9]*$ ]] || {
  echo "[debug-chrome] --timeout must be a positive integer, got: ${TIMEOUT_SECS}" >&2; exit 2
}
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
  slot_err_file="$(mktemp)" || {
    echo "[debug-chrome] could not create a temporary file to capture slot resolution errors" >&2
    echo "Next: check TMPDIR is writable, or pass --port explicitly to skip slot resolution." >&2
    exit 1
  }
  trap 'rm -f "$slot_err_file"' EXIT
  slot_port="$(node -e '
    const fs=require("fs"),path=require("path");
    const dir=process.argv[1]; const want=process.argv[2]; let found=false; let unreadable=[];
    for (const f of fs.readdirSync(dir).filter((n)=>n.endsWith(".json"))) {
      let d; try { d=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8")); } catch (e) { unreadable.push(f); continue; }
      for (const s of d.slots ?? []) {
        if (s.id !== want) continue;
        found = true;
        // cdp_port may live under any resource group (dev-server, browser, ...).
        for (const r of Object.values(s.resources ?? {})) {
          const p = r && typeof r === "object" ? r.cdp_port : undefined;
          if (p) { console.log(p); process.exit(0); }
        }
      }
    }
    if (unreadable.length) console.error("unreadable pool files: " + unreadable.join(", "));
    console.error(found ? "slot found but no resource declares cdp_port" : "no such slot");
    process.exit(1);
  ' "$POOL_DIR" "$ARG_SLOT" 2>"$slot_err_file")" || {
    echo "[debug-chrome] could not resolve --slot '${ARG_SLOT}' in ${POOL_DIR}/*.json: $(tr '\n' '; ' <"$slot_err_file")" >&2
    echo "Next: fleet configs are machine-local, so a worktree has no fleet of its own." >&2
    echo "      Point at the checkout that owns it with --pool <dir>, or pass --port explicitly." >&2
    exit 1
  }
  PORT="$slot_port"
fi
[[ "$PORT" =~ ^[1-9][0-9]*$ ]] || {
  echo "[debug-chrome] --port must be a positive integer, got: ${PORT}" >&2; exit 2
}
PROFILE="${PROFILE:-$HOME/.chrome-farmslot-$PORT}"
URL="${ARG_URL:-${FARMSLOT_UI_URL:-http://localhost:${DEFAULT_UI_PORT}/}}"

# Chrome only writes DevToolsActivePort when the requested port is 0, but it always
# maintains <profile>/SingletonLock, a symlink named <host>-<pid>, for the instance
# owning that profile. That gives us one authoritative pid to ask about.
profile_owner_pid() {
  local link pid
  link="$(readlink "$PROFILE/SingletonLock" 2>/dev/null)" || return 1
  [[ "$link" =~ -([0-9]+)$ ]] || return 1
  pid="${BASH_REMATCH[1]}"
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s\n' "$pid"
}

# Does that pid hold our profile AND serve our port? Reading one known pid's argv
# cannot select the wrong process the way scanning for a pattern could, and a stale
# lock naming a recycled or non-Chrome pid simply fails both tests. The trailing
# space makes each match end at an argument boundary, so :9399 cannot satisfy :93990
# and /p/profile cannot satisfy /p/profile2.
owner_serves_port() {
  local cmd
  cmd="$(ps -p "$1" -o command= 2>/dev/null)" || return 1
  [[ -n "$cmd" ]] || return 1
  [[ "$cmd " == *"--remote-debugging-port=${PORT} "* ]] || return 1
  [[ "$cmd " == *"--user-data-dir=${PROFILE} "* ]]
}

# Recorded before launching: only an owner that predates our launch can be the
# instance this launch handed off to. Checking after would match what we started.
pre_launch_owner="$(profile_owner_pid || true)"

if curl -sf "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  # Identity is deliberately binary. Something is serving this port; unless the
  # process holding our profile is demonstrably that server, it is someone else's
  # browser and we must not hand the caller a success it will chain CDP onto.
  owner_pid="$(profile_owner_pid || true)"
  if [[ -z "$owner_pid" ]] || ! owner_serves_port "$owner_pid"; then
    echo "[debug-chrome] a browser is already serving CDP on :${PORT}, but it is not the Chrome" >&2
    echo "  holding profile ${PROFILE}." >&2
    echo "Next: reusing it would drive an unrelated browser. Choose another --port, stop that" >&2
    echo "      instance, or pass the --profile it actually owns to target it deliberately." >&2
    exit 1
  fi

  echo "[debug-chrome] CDP already listening on :${PORT} — reusing existing session (pid ${owner_pid})"
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
  launch_err="$(open -na "Google Chrome" --args "${CHROME_ARGS[@]}" "$URL" 2>&1 >/dev/null)" || {
    echo "[debug-chrome] failed to launch Chrome via 'open -na': ${launch_err:-<no output>}" >&2
    echo "Next: verify the app at /Applications/Google Chrome.app, or set FARMSLOT_CHROME to a" >&2
    echo "      binary and re-run so it is launched directly instead." >&2
    exit 1
  }
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
# Report the handoff only when the same owner both predated the launch and is still
# running: that is what is actually observable. Claiming causation from a single
# pre-launch snapshot would assert more than the evidence supports.
if [[ -n "$pre_launch_owner" ]] && kill -0 "$pre_launch_owner" 2>/dev/null; then
  echo "Next: pid ${pre_launch_owner} held this profile before the launch and is still running." >&2
  echo "      Chrome holds a singleton lock on --user-data-dir, so a launch against an owned" >&2
  echo "      profile hands off to that instance and exits without binding the port." >&2
  echo "      Use a different --profile, or stop that instance." >&2
else
  echo "Next: raise --timeout if this machine is slow to start Chrome, or run without --headless to" >&2
  echo "      see the launch failure. Verify the binary at: ${CHROME}" >&2
fi
exit 1
