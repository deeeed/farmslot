#!/bin/bash
# show-slot.sh <slot_id>
# Toggle headless → visible emulator for human review.
# On headless Linux (runner-a): uses Xvfb virtual display.
# Prints VNC/X forwarding instructions for remote viewing.
set -euo pipefail

SLOT_ID="${1:?Usage: show-slot.sh <slot_id>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Parse slot config
SLOT_JSON=$(python3 - "$PROJECT_DIR" "$SLOT_ID" <<'PY'
import glob
import json
import os
import sys

project_dir, slot_id = sys.argv[1:]
for pool_file in glob.glob(os.path.join(project_dir, "pool", "*.json")):
    with open(pool_file) as f:
        pool = json.load(f)
    for slot in pool.get("slots", []):
        if str(slot.get("id")) == slot_id:
            slot["_machine"] = pool.get("machine", "")
            json.dump(slot, sys.stdout)
            sys.exit(0)
sys.exit(1)
PY
)

AVD_NAME=$(echo "${SLOT_JSON}" | python3 -c "import json,sys; print(json.load(sys.stdin)['avd'])")
ADB_SERIAL=$(echo "${SLOT_JSON}" | python3 -c "import json,sys; print(json.load(sys.stdin)['adb_serial'])")
MACHINE_NAME=$(echo "${SLOT_JSON}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('_machine') or 'runner')")

echo "=== show-slot: ${AVD_NAME} (${ADB_SERIAL}) ==="

# --- Kill headless emulator ---
EMULATOR_PID=$(ps aux | grep "emulator.*-avd ${AVD_NAME}" | grep -v grep | awk '{print $2}' || true)
if [ -n "${EMULATOR_PID}" ]; then
  echo "Killing headless emulator (PID ${EMULATOR_PID})..."
  kill "${EMULATOR_PID}" 2>/dev/null || true
  sleep 3
else
  echo "No running emulator found for ${AVD_NAME}"
fi

# --- Start Xvfb if no display ---
DISPLAY_NUM=99
if [ -z "${DISPLAY:-}" ]; then
  echo "No DISPLAY set — starting Xvfb on :${DISPLAY_NUM}"

  if ! pgrep -f "Xvfb :${DISPLAY_NUM}" >/dev/null 2>&1; then
    # Install if missing
    command -v Xvfb >/dev/null || {
      echo "Installing Xvfb..."
      sudo apt-get update -qq && sudo apt-get install -y -qq xvfb
    }
    Xvfb ":${DISPLAY_NUM}" -screen 0 1280x720x24 &
    sleep 1
    echo "[OK] Xvfb started on :${DISPLAY_NUM}"
  else
    echo "[OK] Xvfb already running on :${DISPLAY_NUM}"
  fi
  export DISPLAY=":${DISPLAY_NUM}"
fi

# --- Relaunch emulator with window ---
echo "Launching ${AVD_NAME} with window on DISPLAY=${DISPLAY}..."
emulator -avd "${AVD_NAME}" \
  -no-audio \
  -no-boot-anim \
  -gpu swiftshader_indirect &
NEW_PID=$!
echo "Emulator PID: ${NEW_PID}"

# Wait for boot
adb -s "${ADB_SERIAL}" wait-for-device 2>/dev/null
adb -s "${ADB_SERIAL}" shell 'while [ -z "$(getprop sys.boot_completed)" ]; do sleep 1; done' 2>/dev/null

echo ""
echo "========================================="
echo "Emulator ${AVD_NAME} visible on DISPLAY=${DISPLAY}"
echo ""
echo "To view remotely:"
echo ""
echo "  Option 1 — SSH X forwarding:"
echo "    ssh -X user@${MACHINE_NAME}"
echo "    DISPLAY=:${DISPLAY_NUM} scrot /tmp/screen.png  # screenshot"
echo ""
echo "  Option 2 — VNC (install x11vnc):"
echo "    x11vnc -display :${DISPLAY_NUM} -nopw -forever &"
echo "    # Then connect VNC client to ${MACHINE_NAME}:5900"
echo ""
echo "  Option 3 — adb screenshot (no X needed):"
echo "    adb -s ${ADB_SERIAL} exec-out screencap -p > /tmp/screen.png"
echo ""
echo "To return to headless:"
echo "    kill ${NEW_PID}"
echo "    bash scripts/setup-slot.sh ${SLOT_ID} <branch>"
echo "========================================="
