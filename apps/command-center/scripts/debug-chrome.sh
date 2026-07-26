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
# Probe, verify, and advertise one explicit address. "localhost" may resolve to
# ::1 while a different process holds 127.0.0.1 on the same port, which would let
# us verify one socket and then talk to another.
CDP_HOST="${FARMSLOT_CDP_HOST:-127.0.0.1}"

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

# Was that pid asked for our profile and our port? The trailing space makes each
# match end at an argument boundary, so :9399 cannot satisfy :93990 and /p/profile
# cannot satisfy /p/profile2. Reading one known pid's argv cannot select the wrong
# process the way scanning for a pattern could.
owner_requested_port() {
  local cmd
  # -ww: never truncate argv to terminal width, or the flags we match on could be
  # cut off and a browser that is ours would be refused.
  cmd="$(ps -ww -p "$1" -o command= 2>/dev/null)" || return 1
  [[ -n "$cmd" ]] || return 1
  [[ "$cmd " == *"--remote-debugging-port=${PORT} "* ]] || return 1
  [[ "$cmd " == *"--user-data-dir=${PROFILE} "* ]]
}

# "<pid> <family> <address>" per listening socket, family being IPv4 or IPv6.
# The family is not decoration: lsof prints a bare `*:PORT` for a wildcard in
# EITHER family, so dropping it makes an IPv6-only listener look like it covers
# IPv4. Non-zero exit means we could not find out, which differs from finding
# nobody.
port_listeners() {
  if command -v lsof >/dev/null 2>&1; then
    # COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME — TYPE is the family.
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $2, $5, $9 }'
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    # One socket can list several pids; emit every one against its address rather
    # than letting a greedy match keep only the last. ss encodes the family in the
    # address itself.
    ss -ltnpH "sport = :${PORT}" 2>/dev/null |
      awk '{
        addr = $4
        family = (addr ~ /\[|::/) ? "IPv6" : "IPv4"
        rest = $0
        while (match(rest, /pid=[0-9]+/)) {
          print substr(rest, RSTART + 4, RLENGTH - 4), family, addr
          rest = substr(rest, RSTART + RLENGTH)
        }
      }'
    return 0
  fi
  return 1
}

# Does this pid hold the socket we will actually connect to? A dual-stack split is
# real: another process can own 127.0.0.1:PORT while ours owns [::1]:PORT, and which
# one answers "localhost" is resolution order. We connect to $CDP_HOST explicitly
# and demand the owner hold that address (or a wildcard covering it), so being
# merely present among the listeners is not enough.
owner_holds_endpoint() {
  local owner="$1" pid family addr host_family
  host_family="IPv4"
  [[ "$CDP_HOST" == *:* ]] && host_family="IPv6"
  while read -r pid family addr; do
    [[ "$pid" == "$owner" ]] || continue
    case "$addr" in
      "${CDP_HOST}:${PORT}" | "[${CDP_HOST}]:${PORT}") return 0 ;;
      "*:${PORT}" | "0.0.0.0:${PORT}" | "[::]:${PORT}")
        # A wildcard only covers its own family. Accepting an IPv6 wildcard for an
        # IPv4 host would assume v4-mapped-into-v6, which is a kernel setting, not
        # a guarantee — and lsof prints a bare `*:PORT` for either family.
        [[ "$family" == "$host_family" ]] && return 0
        ;;
    esac
  done
  return 1
}

# ours | foreign | unverifiable
#
# argv is a request, not a claim: Chrome keeps --remote-debugging-port in its
# command line even when the port was already taken and it never bound. So the
# process holding our profile must ALSO own the listening socket before we are
# entitled to drive the endpoint. Anything we cannot demonstrate is not ours.
identify_port_owner() {
  local owner listeners
  owner="$(profile_owner_pid || true)"
  [[ -n "$owner" ]] && owner_requested_port "$owner" || { printf 'foreign\n'; return; }
  listeners="$(port_listeners)" || { printf 'unverifiable\n'; return; }
  [[ -n "$listeners" ]] || { printf 'unverifiable\n'; return; }
  if owner_holds_endpoint "$owner" <<<"$listeners"; then printf 'ours\n'; else printf 'foreign\n'; fi
}

# Recorded before launching: only an owner that predates our launch can be the
# instance this launch handed off to. Checking after would match what we started.
pre_launch_owner="$(profile_owner_pid || true)"

if curl -sf "http://${CDP_HOST}:${PORT}/json/version" >/dev/null 2>&1; then
  # Something is serving this port. Unless the process holding our profile is
  # demonstrably that server, we must not hand the caller a success it will chain
  # CDP commands onto.
  case "$(identify_port_owner)" in
    foreign)
      echo "[debug-chrome] a browser is already serving CDP on :${PORT}, but it is not the Chrome" >&2
      echo "  holding profile ${PROFILE}." >&2
      echo "Next: reusing it would drive an unrelated browser. Choose another --port, stop that" >&2
      echo "      instance, or pass the --profile it actually owns to target it deliberately." >&2
      exit 1
      ;;
    unverifiable)
      echo "[debug-chrome] something is serving CDP on :${PORT}, and this script cannot tell whether" >&2
      echo "  it is the Chrome holding ${PROFILE}: no lsof or ss to read socket ownership from." >&2
      echo "Next: driving an unverified browser is not safe, so this is a refusal rather than a" >&2
      echo "      guess. Install lsof (or iproute2 for ss), choose another --port, or stop the" >&2
      echo "      instance on :${PORT} and re-run so this script launches the browser it drives." >&2
      exit 1
      ;;
  esac
  owner_pid="$(profile_owner_pid || true)"

  echo "[debug-chrome] CDP already listening on :${PORT} — reusing existing session (pid ${owner_pid})"
  echo "[debug-chrome] endpoints:  http://${CDP_HOST}:${PORT}/json"
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
  if curl -sf "http://${CDP_HOST}:${PORT}/json/version" >/dev/null 2>&1; then
    # A responder appearing during launch is not proof it is ours — another
    # process can win the port in the same window. Hold reuse to the same standard.
    case "$(identify_port_owner)" in
      ours)
        echo "[debug-chrome] ready on :${PORT}"
        exit 0
        ;;
      foreign)
        echo "[debug-chrome] :${PORT} is served by a browser that does not hold ${PROFILE}" >&2
        echo "Next: another process took this port while Chrome was starting. Choose another" >&2
        echo "      --port, or stop that instance and re-run." >&2
        exit 1
        ;;
      unverifiable)
        echo "[debug-chrome] :${PORT} answered, but socket ownership cannot be read here" >&2
        echo "Next: install lsof (or iproute2 for ss) so this script can confirm the endpoint is" >&2
        echo "      the browser it launched, or choose another --port." >&2
        exit 1
        ;;
    esac
  fi
  sleep 0.2
done

echo "[debug-chrome] CDP did not come up on :${PORT} within ${TIMEOUT_SECS}s (profile ${PROFILE})" >&2
# Report the handoff only when the pid that predated the launch is STILL the pid
# recorded in the profile's lock. Liveness alone would misattribute a recycled pid,
# or a lock that has since changed hands, to a singleton handoff.
if [[ -n "$pre_launch_owner" && "$(profile_owner_pid || true)" == "$pre_launch_owner" ]]; then
  echo "Next: pid ${pre_launch_owner} held this profile before the launch and is still running." >&2
  echo "      Chrome holds a singleton lock on --user-data-dir, so a launch against an owned" >&2
  echo "      profile hands off to that instance and exits without binding the port." >&2
  echo "      Use a different --profile, or stop that instance." >&2
else
  echo "Next: raise --timeout if this machine is slow to start Chrome, or run without --headless to" >&2
  echo "      see the launch failure. Verify the binary at: ${CHROME}" >&2
fi
exit 1
