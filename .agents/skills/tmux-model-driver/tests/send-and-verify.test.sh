#!/bin/bash
set -euo pipefail

# Real tmux only on a private server: no $TMUX, and a TMUX_TMPDIR this test
# owns, so plain `tmux` here and in the scripts under test lands on it. Cleanup
# ends that server by its socket, never the operator's.
unset TMUX TMUX_PANE
TMUX_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/fs-tmux-XXXXXX")"
export TMUX_TMPDIR
FARMSLOT_TMUX_SANDBOX="$TMUX_TMPDIR/tmux-$(id -u)/default"
export FARMSLOT_TMUX_SANDBOX
# With -S, tmux does not create the per-user socket directory it would under TMUX_TMPDIR.
mkdir -m 700 "$TMUX_TMPDIR/tmux-$(id -u)"
tmux_sandbox_close() {
  # The socket exists only if the test started a server.
  if [ -S "$FARMSLOT_TMUX_SANDBOX" ]; then
    tmux -S "$FARMSLOT_TMUX_SANDBOX" kill-server 2>/dev/null || true # the server may already be gone
  fi
  rm -rf "$TMUX_TMPDIR"
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/send-and-verify.sh"
session="tmux-model-driver-send-test-$$"
received="$(mktemp -t tmux-model-driver-send-test.XXXXXX)"
fake_dir=""
shell_dir=""

cleanup() {
  tmux -S "$FARMSLOT_TMUX_SANDBOX" kill-session -t "$session" 2>/dev/null || true
  rm -f "$received"
  [ -z "$fake_dir" ] || rm -rf "$fake_dir"
  [ -z "$shell_dir" ] || rm -rf "$shell_dir"
  tmux_sandbox_close
}
trap cleanup EXIT

tmux -S "$FARMSLOT_TMUX_SANDBOX" new-session -d -s "$session" \
  "bash --noprofile --norc -c 'printf \"Working (stale)\\n\"; stty -echo; while IFS= read -r line; do printf \"<%s>\\n\" \"\$line\" >> \"$received\"; done'"
pane_id="$(tmux -S "$FARMSLOT_TMUX_SANDBOX" display-message -p -t "$session" '#{pane_id}')"
sleep 0.2

for runner in claude codex grok cursor; do
  result="$(printf 'buffer guard %s' "$runner" | "$SCRIPT" "$pane_id" "$runner")"
  printf '%s\n' "$result" | grep -q '"verification": "unverified"'
done

[ "$(wc -l < "$received" | tr -d ' ')" -eq 4 ]
for runner in claude codex grok cursor; do
  [ "$(grep -Fxc "<buffer guard $runner>" "$received")" -eq 1 ]
done

tmux -S "$FARMSLOT_TMUX_SANDBOX" kill-session -t "$session"
tmux -S "$FARMSLOT_TMUX_SANDBOX" new-session -d -s "$session" \
  "bash --noprofile --norc -c 'stty -echo; while IFS= read -r _; do printf \"Working (fresh)\\n\"; done'"
pane_id="$(tmux -S "$FARMSLOT_TMUX_SANDBOX" display-message -p -t "$session" '#{pane_id}')"
sleep 0.2
result="$(printf 'start work' | "$SCRIPT" "$pane_id" codex)"
printf '%s\n' "$result" | grep -q '"verification": "submitted"'

tmux -S "$FARMSLOT_TMUX_SANDBOX" kill-session -t "$session"
tmux -S "$FARMSLOT_TMUX_SANDBOX" new-session -d -s "$session" \
  "bash --noprofile --norc -c 'stty -echo; while IFS= read -r _; do printf \"✢ Schlepping… (fresh)\\n\"; done'"
pane_id="$(tmux -S "$FARMSLOT_TMUX_SANDBOX" display-message -p -t "$session" '#{pane_id}')"
sleep 0.2
result="$(printf 'review work' | "$SCRIPT" "$pane_id" claude)"
printf '%s\n' "$result" | grep -q '"verification": "submitted"'

tmux -S "$FARMSLOT_TMUX_SANDBOX" kill-session -t "$session"
shell_dir="$(mktemp -d -t tmux-model-driver-shell.XXXXXX)"
tmux -S "$FARMSLOT_TMUX_SANDBOX" new-session -d -s "$session" -c "$shell_dir" \
  "bash --noprofile --norc"
pane_id="$(tmux -S "$FARMSLOT_TMUX_SANDBOX" display-message -p -t "$session" '#{pane_id}')"
sleep 0.2
result="$(printf 'printf x >> marker' | "$SCRIPT" "$pane_id" shell)"
printf '%s\n' "$result" | grep -q '"verification": "submitted"'
[ "$(cat "$shell_dir/marker")" = "x" ]

tmux -S "$FARMSLOT_TMUX_SANDBOX" kill-session -t "$session"
fake_dir="$(mktemp -d -t tmux-model-driver-fake.XXXXXX)"
fake_state="$fake_dir/pane-state.sh"
state_count="$fake_dir/count"
cat > "$fake_state" <<'SH'
#!/bin/bash
count=0
[ ! -f "$TMUX_FAKE_STATE_COUNT" ] || count="$(cat "$TMUX_FAKE_STATE_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$TMUX_FAKE_STATE_COUNT"
if [ "$count" -lt 3 ]; then
  state=claude
  tail='❯ /exit'
else
  state=shell
  tail='user@host %'
fi
printf '{"state":"%s","phase":"idle","session_name":"test","tail":"%s","last_line":"%s"}\n' "$state" "$tail" "$tail"
SH
chmod +x "$fake_state"
tmux -S "$FARMSLOT_TMUX_SANDBOX" new-session -d -s "$session" \
  "bash --noprofile --norc"
pane_id="$(tmux -S "$FARMSLOT_TMUX_SANDBOX" display-message -p -t "$session" '#{pane_id}')"
result="$(printf '/exit' | \
  TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT="$fake_state" \
  TMUX_FAKE_STATE_COUNT="$state_count" \
  "$SCRIPT" "$pane_id" claude)"
printf '%s\n' "$result" | grep -q '"after_state": "shell"'
printf '%s\n' "$result" | grep -q '"verification": "submitted"'

echo 'send-and-verify tests: ok'
