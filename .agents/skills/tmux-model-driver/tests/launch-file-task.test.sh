#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/launch-file-task.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

state_script="$tmp/pane-state.sh"
cat > "$state_script" <<'EOF'
#!/bin/bash
printf '{"state":"shell"}\n'
EOF
chmod +x "$state_script"

send_script="$tmp/send-and-verify.sh"
cat > "$send_script" <<'EOF'
#!/bin/bash
set -euo pipefail
cat > "$TMUX_MODEL_DRIVER_CAPTURE_FILE"
EOF
chmod +x "$send_script"

task_file="$tmp/TASK.md"
cat > "$task_file" <<'EOF'
## Task

```text
WRAPPER: custom-review
```
EOF

capture_file="$tmp/captured.txt"
TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT="$state_script" \
TMUX_MODEL_DRIVER_SEND_SCRIPT="$send_script" \
TMUX_MODEL_DRIVER_CAPTURE_FILE="$capture_file" \
  "$SCRIPT" "%1" claude sonnet "$task_file"

grep -F 'claude --dangerously-skip-permissions --model sonnet' "$capture_file" >/dev/null
grep -F 'Wrapper\ hint:\ \"custom-review\"' "$capture_file" >/dev/null
grep -F "$task_file" "$capture_file" >/dev/null

cat > "$task_file" <<'EOF'
## Task

```text
WRAPPER: custom-fixbug
```
EOF

TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT="$state_script" \
TMUX_MODEL_DRIVER_SEND_SCRIPT="$send_script" \
TMUX_MODEL_DRIVER_CAPTURE_FILE="$capture_file" \
  "$SCRIPT" "%1" claude sonnet "$task_file"

grep -F 'Wrapper\ hint:\ \"custom-fixbug\"' "$capture_file" >/dev/null
grep -F "$task_file" "$capture_file" >/dev/null

cat > "$task_file" <<'EOF'
## Task

```text
WRAPPER: recipe-cook
```
EOF

TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT="$state_script" \
TMUX_MODEL_DRIVER_SEND_SCRIPT="$send_script" \
TMUX_MODEL_DRIVER_CAPTURE_FILE="$capture_file" \
  "$SCRIPT" "%1" claude sonnet "$task_file"

grep -F 'Read\ \"' "$capture_file" >/dev/null
grep -F "$task_file" "$capture_file" >/dev/null
grep -F 'recipe-cook-learning.json' "$capture_file" >/dev/null
old_learning_artifact="$(printf '%s-%s-%s.%s' fs cook learning json)"
! grep -F "$old_learning_artifact" "$capture_file" >/dev/null

skill_file="$tmp/SKILL.md"
printf '%s\n' '# Clean-room skill' > "$skill_file"
TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT="$state_script" \
TMUX_MODEL_DRIVER_SEND_SCRIPT="$send_script" \
TMUX_MODEL_DRIVER_CAPTURE_FILE="$capture_file" \
  "$SCRIPT" "%1" claude sonnet "$task_file" "" "" "$skill_file"
grep -F 'claude --safe-mode --append-system-prompt-file' "$capture_file" >/dev/null
! grep -F -- '--append-system-prompt ' "$capture_file" >/dev/null
grep -F "$skill_file" "$capture_file" >/dev/null
grep -F -- '--disallowedTools Agent' "$capture_file" >/dev/null
grep -F 'Resolve\ its\ relative\ scripts\,\ references\,\ and\ assets\ from' "$capture_file" >/dev/null
grep -F "$tmp" "$capture_file" >/dev/null

(
  cd "$tmp"
  TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT="$state_script" \
  TMUX_MODEL_DRIVER_SEND_SCRIPT="$send_script" \
  TMUX_MODEL_DRIVER_CAPTURE_FILE="$capture_file" \
    "$SCRIPT" "%1" claude sonnet "$task_file" "" "" "SKILL.md"
)
grep -F "$skill_file" "$capture_file" >/dev/null

echo "launch-file-task tests: ok"
