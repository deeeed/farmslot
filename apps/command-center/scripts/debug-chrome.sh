#!/usr/bin/env bash
# Launch a dedicated Chrome with CDP enabled for Farmslot UI debugging.
#
# - Reuses the existing session if CDP is already listening on $FARMSLOT_CDP_PORT.
# - Uses a dedicated profile ($FARMSLOT_CDP_PROFILE) to avoid clobbering the user's main Chrome.
# - Defaults to port 9323 to avoid conflicts with other tooling (9222 is Chrome's well-known
#   default and is used by example-browser; 4355 is already reserved for another flow).
#
# Override via env:
#   FARMSLOT_CDP_PORT=9400 bash scripts/debug-chrome.sh
#   FARMSLOT_CDP_PROFILE=~/.chrome-farmslot-alt bash scripts/debug-chrome.sh
#   FARMSLOT_UI_URL=http://localhost:5174/#runs bash scripts/debug-chrome.sh
#   FARMSLOT_CDP_HEADLESS=1 bash scripts/debug-chrome.sh

set -euo pipefail

PORT="${FARMSLOT_CDP_PORT:-9323}"
PROFILE="${FARMSLOT_CDP_PROFILE:-$HOME/.chrome-farmslot}"
URL="${FARMSLOT_UI_URL:-http://localhost:5174/}"
CHROME="${FARMSLOT_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
HEADLESS="${FARMSLOT_CDP_HEADLESS:-0}"

if curl -sf "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "[debug-chrome] CDP already listening on :${PORT} — reusing existing session"
  echo "[debug-chrome] endpoints:  http://localhost:${PORT}/json"
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
)
if [[ "$HEADLESS" == "1" || "$HEADLESS" == "true" || "$HEADLESS" == "yes" ]]; then
  CHROME_ARGS+=(--headless=new --disable-gpu)
fi
if [[ "$HEADLESS" == "1" || "$HEADLESS" == "true" || "$HEADLESS" == "yes" ]] \
  && [[ "$CHROME" == "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]] \
  && command -v open >/dev/null 2>&1; then
  # macOS routes direct Chrome binary invocations into the already-running GUI
  # instance, which can drop the requested CDP port. `open -na` forces a
  # separate app instance; with headless mode this does not create a visible
  # browser window.
  open -na "Google Chrome" --args "${CHROME_ARGS[@]}" "$URL" >/dev/null 2>&1
else
  "$CHROME" "${CHROME_ARGS[@]}" "$URL" >/dev/null 2>&1 &
fi

# Wait up to 5s for CDP to come up so callers can chain `scripts/cdp.mjs` immediately.
for _ in $(seq 1 25); do
  if curl -sf "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
    echo "[debug-chrome] ready on :${PORT}"
    exit 0
  fi
  sleep 0.2
done

echo "[debug-chrome] CDP did not come up on :${PORT} within 5s" >&2
exit 1
