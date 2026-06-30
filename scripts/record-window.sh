#!/usr/bin/env bash
# record-window.sh — Record a macOS window to MP4 via external capture-helper + ffmpeg.
# Uses a FIFO to decouple capture-helper capture output from ffmpeg for clean signal handling.
#
# Usage:
#   bash record-window.sh --pid 12345 --output artifacts/review.mp4 &
#   RECORDER_PID=$!
#   # ... do work ...
#   kill $RECORDER_PID; sleep 2    # SIGTERM (or -INT)
#
# The script traps SIGINT/SIGTERM, sends SIGINT to capture-helper only,
# lets it flush final frames, then ffmpeg reads remaining data and writes moov atom.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/lib/capture-helper.sh"

CAPTURE_HELPER="$(FARMSLOT_CAPTURE_HELPER_REPO_ROOT="$REPO_ROOT" resolve_capture_helper_bin || true)"
if [[ -z "$CAPTURE_HELPER" ]]; then
  CAPTURE_HELPER="capture-helper"
fi
FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
SCREEN_CONTROL_SOCKET="${SCREEN_CONTROL_SOCKET:-/tmp/farmslot-screen-control-$(id -u).sock}"

# Defaults
MAX_FPS=15
MAX_SIZE=720
MIN_DURATION=2
OUTPUT=""
PID_ARG=""
WINDOW_NAME=""
APP_NAME=""
RECORDING_ID=""
CONTROL_RESPONSE=""
USE_CONTROL_SOCKET=false

usage() {
  echo "Usage: record-window.sh [--pid PID | --window-name SUBSTR] [--app-name NAME] --output PATH [--max-fps N] [--max-size N] [--min-duration N]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pid)        PID_ARG="$2"; shift 2 ;;
    --window-name) WINDOW_NAME="$2"; shift 2 ;;
    --app-name)   APP_NAME="$2"; shift 2 ;;
    --output)     OUTPUT="$2"; shift 2 ;;
    --max-fps)    MAX_FPS="$2"; shift 2 ;;
    --max-size)   MAX_SIZE="$2"; shift 2 ;;
    --min-duration) MIN_DURATION="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; usage ;;
  esac
done

[[ -z "$OUTPUT" ]] && { echo "Error: --output is required" >&2; usage; }
[[ -z "$PID_ARG" && -z "$WINDOW_NAME" ]] && { echo "Error: --pid or --window-name is required" >&2; usage; }

# Verify prerequisites
if ! command -v "$CAPTURE_HELPER" >/dev/null 2>&1; then
  echo "Error: capture-helper not found. Install @siteed/capture-helper or set CAPTURE_HELPER_PATH." >&2
  exit 1
fi
command -v "$FFMPEG" &>/dev/null || { echo "Error: ffmpeg not found at $FFMPEG" >&2; exit 1; }

# Resolve PID to window-owning process (e.g., launcher PID → Chromium PID).
# browser.pid often contains the Node launcher; ScreenCaptureKit needs the actual
# Chromium process PID which owns the window.
resolve_window_pid() {
  local pid=$1 depth=${2:-0}
  [[ $depth -gt 5 ]] && return
  if ps -p "$pid" -o ucomm= 2>/dev/null | grep -qi 'chromium\|simulator'; then
    echo "$pid"; return
  fi
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    local found
    found=$(resolve_window_pid "$child" $((depth + 1)))
    if [[ -n "$found" ]]; then echo "$found"; return; fi
  done
}

if [[ -n "$PID_ARG" ]]; then
  RESOLVED=$(resolve_window_pid "$PID_ARG")
  if [[ -n "$RESOLVED" && "$RESOLVED" != "$PID_ARG" ]]; then
    echo "[record-window] resolved pid $PID_ARG → $RESOLVED ($(ps -p "$RESOLVED" -o comm= 2>/dev/null))"
    PID_ARG="$RESOLVED"
  fi
fi

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT")"

# Create FIFO
FIFO=$(mktemp -u /tmp/farmslot-record-XXXXXXXX)
mkfifo "$FIFO"

CAPTURE_PID=""
FFMPEG_PID=""
LOG_FILE="/tmp/farmslot-record-$$.log"
START_TS=$(date +%s)

cleanup() {
  rm -f "$FIFO"
  rm -f "$LOG_FILE"
}

screen_control_start() {
  [[ -S "$SCREEN_CONTROL_SOCKET" ]] || return 1
  RECORDING_ID="record-window-$$-$(date +%s)"
  CONTROL_RESPONSE=$(
    SCREEN_CONTROL_SOCKET="$SCREEN_CONTROL_SOCKET" \
    RECORDING_ID="$RECORDING_ID" \
    OUTPUT_PATH="$FIFO" \
    PID_ARG="$PID_ARG" \
    WINDOW_NAME="$WINDOW_NAME" \
    APP_NAME="$APP_NAME" \
    MAX_FPS="$MAX_FPS" \
    MAX_SIZE="$MAX_SIZE" \
    python3 - <<'PY'
import json, os, socket, sys
sock_path = os.environ["SCREEN_CONTROL_SOCKET"]
req = {
    "op": "record.start",
    "recordingId": os.environ["RECORDING_ID"],
    "outputPath": os.environ["OUTPUT_PATH"],
    "maxFps": int(os.environ["MAX_FPS"]),
    "maxSize": int(os.environ["MAX_SIZE"]),
}
pid_arg = os.environ.get("PID_ARG")
window_name = os.environ.get("WINDOW_NAME")
app_name = os.environ.get("APP_NAME")
if pid_arg:
    req["targetPid"] = int(pid_arg)
if window_name:
    req["windowName"] = window_name
if app_name:
    req["appName"] = app_name
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(sock_path)
sock.sendall(json.dumps(req).encode("utf-8") + b"\n")
data = b""
while not data.endswith(b"\n"):
    chunk = sock.recv(65536)
    if not chunk:
      break
    data += chunk
sock.close()
resp = json.loads(data.decode("utf-8").strip() or "{}")
if not resp.get("ok"):
    print(resp.get("error", "record.start failed"), file=sys.stderr)
    sys.exit(1)
print(json.dumps(resp))
PY
  )
}

screen_control_stop() {
  [[ -n "$RECORDING_ID" ]] || return 0
  [[ -S "$SCREEN_CONTROL_SOCKET" ]] || return 0
  SCREEN_CONTROL_SOCKET="$SCREEN_CONTROL_SOCKET" \
  RECORDING_ID="$RECORDING_ID" \
  python3 - <<'PY'
import json, os, socket, sys
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["SCREEN_CONTROL_SOCKET"])
sock.sendall(json.dumps({"op": "record.stop", "recordingId": os.environ["RECORDING_ID"]}).encode("utf-8") + b"\n")
data = b""
while not data.endswith(b"\n"):
    chunk = sock.recv(65536)
    if not chunk:
        break
    data += chunk
sock.close()
resp = json.loads(data.decode("utf-8").strip() or "{}")
if not resp.get("ok"):
    print(resp.get("error", "record.stop failed"), file=sys.stderr)
    sys.exit(1)
PY
}

stop_recording() {
  local now elapsed remaining
  now=$(date +%s)
  elapsed=$((now - START_TS))
  if [[ "$elapsed" -lt "$MIN_DURATION" ]]; then
    remaining=$((MIN_DURATION - elapsed))
    sleep "$remaining"
  fi

  # Send SIGINT to capture-helper — it flushes final frames then exits
  if $USE_CONTROL_SOCKET; then
    screen_control_stop || true
  elif [[ -n "$CAPTURE_PID" ]] && kill -0 "$CAPTURE_PID" 2>/dev/null; then
    kill -INT "$CAPTURE_PID" 2>/dev/null || true
  fi

  # Wait for capture-helper to exit (flushes + closes FIFO), but never
  # indefinitely. ScreenCaptureKit can wedge when the target window disappeared;
  # leaked recorders keep replayd/capture-helper hot and make the machine unusable.
  if [[ -n "$CAPTURE_PID" ]]; then
    for _ in $(seq 1 100); do
      kill -0 "$CAPTURE_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$CAPTURE_PID" 2>/dev/null; then
      kill -TERM "$CAPTURE_PID" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$CAPTURE_PID" 2>/dev/null || break
        sleep 0.1
      done
    fi
    kill -9 "$CAPTURE_PID" 2>/dev/null || true
    wait "$CAPTURE_PID" 2>/dev/null || true
  fi

  # ffmpeg will read remaining data and exit naturally when FIFO closes
  if [[ -n "$FFMPEG_PID" ]] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
    # Give ffmpeg up to 10s to finalize naturally
    for _ in $(seq 1 100); do
      kill -0 "$FFMPEG_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$FFMPEG_PID" 2>/dev/null; then
      kill -INT "$FFMPEG_PID" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$FFMPEG_PID" 2>/dev/null || break
        sleep 0.1
      done
    fi
    # Force kill only as a last resort
    kill -9 "$FFMPEG_PID" 2>/dev/null || true
  fi

  # Verify moov atom
  if [[ -f "$OUTPUT" ]]; then
    if python3 -c "import sys; sys.exit(0 if b'moov' in open('$OUTPUT','rb').read() else 1)" 2>/dev/null; then
      echo "[record-window] OK output=$OUTPUT"
    else
      echo "[record-window] WARN: no moov atom in $OUTPUT — file may be corrupt" >&2
      cleanup
      exit 1
    fi
  else
    echo "[record-window] WARN: output file not created: $OUTPUT" >&2
    cleanup
    exit 1
  fi

  cleanup
  exit 0
}

STOP=false
handle_signal() { STOP=true; }
trap handle_signal INT TERM

# Build capture-helper args (non-framed mode — raw Annex B for ffmpeg)
CAPTURE_ARGS=(--max-fps "$MAX_FPS" --max-size "$MAX_SIZE")
if [[ -n "$PID_ARG" ]]; then
  CAPTURE_ARGS+=(--pid "$PID_ARG")
elif [[ -n "$WINDOW_NAME" ]]; then
  if [[ -n "$APP_NAME" ]]; then
    CAPTURE_ARGS+=(--app-name "$APP_NAME")
  fi
  CAPTURE_ARGS+=(--window-name "$WINDOW_NAME")
fi

# Start ffmpeg FIRST (FIFO blocks until writer opens)
# Re-encode with an explicit input frame rate so raw Annex B capture stays
# wall-clock aligned when muxed into MP4. `-c copy` produced incorrect MP4
# durations because the elementary stream does not carry stable timestamps.
"$FFMPEG" -nostdin -framerate "$MAX_FPS" -fflags +genpts -f h264 -i "$FIFO" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -movflags +faststart -y "$OUTPUT" \
  </dev/null 2>/dev/null &
FFMPEG_PID=$!

if screen_control_start 2>>"$LOG_FILE"; then
  USE_CONTROL_SOCKET=true
  echo "[record-window] attached to shared screen owner socket=$SCREEN_CONTROL_SOCKET response=$CONTROL_RESPONSE"
else
  # Start capture-helper writing to FIFO
  "$CAPTURE_HELPER" capture "${CAPTURE_ARGS[@]}" > "$FIFO" 2>"$LOG_FILE" &
  CAPTURE_PID=$!
fi

echo "[record-window] started capture_pid=${CAPTURE_PID:-shared-owner} ffmpeg_pid=$FFMPEG_PID output=$OUTPUT"

# Poll until signaled or a child dies. sleep is interruptible by signals
# (unlike wait, which bash ignores SIGINT for in background processes).
while ! $STOP && { $USE_CONTROL_SOCKET || kill -0 "$CAPTURE_PID" 2>/dev/null; } && kill -0 "$FFMPEG_PID" 2>/dev/null; do
  sleep 0.5
done

stop_recording
