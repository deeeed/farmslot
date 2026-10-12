#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT="$tmp/state.sh"
export DRIVER_STARTUP_SEQUENCE="$tmp/sequence"
cat > "$TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT" <<'SH'
#!/bin/bash
state="$(head -1 "$DRIVER_STARTUP_SEQUENCE")"
tail -n +2 "$DRIVER_STARTUP_SEQUENCE" > "$DRIVER_STARTUP_SEQUENCE.next"
if [ -s "$DRIVER_STARTUP_SEQUENCE.next" ]; then mv "$DRIVER_STARTUP_SEQUENCE.next" "$DRIVER_STARTUP_SEQUENCE"; fi
printf '{"state":"%s","phase":"unknown","launch_blocker":null,"auto_action":null}\n' "$state"
SH
chmod +x "$TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT"
printf 'shell\nunknown\nclaude\n' > "$DRIVER_STARTUP_SEQUENCE"
out="$("$root/scripts/resolve-launch-blockers.sh" '%fixture' claude 2)"
python3 -c 'import json,sys; value=json.loads(sys.argv[1]); assert value["resolved"] and value["state"] == "claude"' "$out"
printf 'codex\n' > "$DRIVER_STARTUP_SEQUENCE"
if out="$("$root/scripts/resolve-launch-blockers.sh" '%fixture' claude 2)"; then exit 1; fi
python3 -c 'import json,sys; value=json.loads(sys.argv[1]); assert not value["resolved"] and value["state"] == "codex"' "$out"
printf 'shell\n' > "$DRIVER_STARTUP_SEQUENCE"
if out="$("$root/scripts/resolve-launch-blockers.sh" '%fixture' claude 1)"; then exit 1; fi
python3 -c 'import json,sys; value=json.loads(sys.argv[1]); assert not value["resolved"] and "timed out" in value["error"]' "$out"
# Exercise the production loop with structured inspections and a stubbed action sink.
mkdir -p "$tmp/skill/scripts"
cp "$root/scripts/resolve-launch-blockers.sh" "$tmp/skill/scripts/resolve-launch-blockers.sh"
cat > "$tmp/skill/scripts/run-driver.sh" <<'SINK'
#!/bin/bash
printf '%s\n' "$*" >> "$DRIVER_STARTUP_ACTIONS"
printf '{"action_sent":true}\n'
SINK
chmod +x "$tmp/skill/scripts/run-driver.sh"
export DRIVER_STARTUP_ACTIONS="$tmp/actions"
cat > "$TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT" <<'STATE'
#!/bin/bash
head -1 "$DRIVER_STARTUP_SEQUENCE"
tail -n +2 "$DRIVER_STARTUP_SEQUENCE" > "$DRIVER_STARTUP_SEQUENCE.next"
if [ -s "$DRIVER_STARTUP_SEQUENCE.next" ]; then mv "$DRIVER_STARTUP_SEQUENCE.next" "$DRIVER_STARTUP_SEQUENCE"; fi
STATE
cat > "$DRIVER_STARTUP_SEQUENCE" <<'STATES'
{"state":"codex","phase":"launch-blocker","launch_blocker":"update-available","auto_action":"codex-skip-update"}
{"state":"codex","phase":"launch-blocker","launch_blocker":"update-available","auto_action":"codex-skip-update"}
{"state":"codex","phase":"idle","launch_blocker":null,"auto_action":null}
STATES
out="$(bash "$tmp/skill/scripts/resolve-launch-blockers.sh" '%fixture' codex 2)"
python3 -c 'import json,sys; assert json.loads(sys.argv[1])["resolved"]' "$out"
test "$(wc -l < "$DRIVER_STARTUP_ACTIONS" | tr -d ' ')" = 1

echo 'resolve-launch-blockers tests: ok'
