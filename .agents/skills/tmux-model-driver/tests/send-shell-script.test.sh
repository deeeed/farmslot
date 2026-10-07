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
tmux_sandbox_close() {
  # The socket exists only if the test started a server.
  if [ -S "$FARMSLOT_TMUX_SANDBOX" ]; then
    tmux -S "$FARMSLOT_TMUX_SANDBOX" kill-server 2>/dev/null || true # the server may already be gone
  fi
  rm -rf "$TMUX_TMPDIR"
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/send-shell-script.sh"

tmp="$(mktemp -d)"
session="tmux-model-driver-test-$$"
cleanup() {
  tmux -S "$FARMSLOT_TMUX_SANDBOX" kill-session -t "$session" 2>/dev/null || true
  rm -rf "$tmp"
  tmux_sandbox_close
}
trap cleanup EXIT

repo="$tmp/repo"
stage_root="$tmp/stage"
trace="$tmp/trace.jsonl"
marker="$tmp/marker"
mode_file="$tmp/mode"
digest_file="$tmp/digest"
mkdir -p "$repo" "$stage_root"
git -C "$repo" init --quiet
before_status="$(git -C "$repo" status --short)"

tmux -S "$FARMSLOT_TMUX_SANDBOX" new-session -d -s "$session" -c "$repo" 'bash --noprofile --norc'
pane_id="$(tmux -S "$FARMSLOT_TMUX_SANDBOX" display-message -p -t "$session" '#{pane_id}')"

{
  printf 'if stat -f %%Lp "$0" >/dev/null 2>&1; then stat -f %%Lp "$0"; else stat -c %%a "$0"; fi > %q\n' "$mode_file"
  printf 'shasum -a 256 "$0" | awk '\''{print $1}'\'' > %q\n' "$digest_file"
  printf 'printf done > %q\n' "$marker"
  printf '%s\n' 'exec true'
} | TMUX_MODEL_DRIVER_STAGE_ROOT="$stage_root" "$SCRIPT" "$pane_id" "$repo" "$trace"

for _ in {1..50}; do
  if [ -f "$marker" ] && [ -f "$mode_file" ] && [ -f "$digest_file" ] \
    && [ -z "$(find "$stage_root" -mindepth 1 -print -quit)" ]; then
    break
  fi
  sleep 0.1
done

test "$(cat "$marker")" = "done"
test "$(cat "$mode_file")" = "600"
test "$(git -C "$repo" status --short)" = "$before_status"
test -z "$(find "$stage_root" -mindepth 1 -print -quit)"

payload="$(python3 -c 'import json, sys; print(json.loads(open(sys.argv[1]).readlines()[-1])["payload"])' "$trace")"
case "$payload" in
  bash\ */launch-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].sh) ;;
  *) echo "unexpected trace payload: $payload" >&2; exit 1 ;;
esac

filename_digest="$(basename "${payload#bash }" | sed -E 's/^launch-([0-9a-f]{16})\.sh$/\1/')"
test "${filename_digest}" = "$(cut -c1-16 "$digest_file")"

echo "send-shell-script tests: ok"
