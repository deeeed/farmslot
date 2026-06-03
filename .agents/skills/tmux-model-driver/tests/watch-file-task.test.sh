#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/watch-file-task.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

task_dir="$tmp/run"
mkdir -p "$task_dir/artifacts"
state_file="$tmp/state.json"

cat > "$task_dir/TASK.md" <<'EOF'
# Task

## Task

```text
STATUS: pending
```

## Checklist

- [ ] one
EOF

out="$(WATCH_NOW_EPOCH=100 "$SCRIPT" "$task_dir" --state-file "$state_file" --grace-sec 10 --window-sec 20)"
printf '%s\n' "$out" | grep -q '"decision": "grace"'

out="$(WATCH_NOW_EPOCH=105 "$SCRIPT" "$task_dir" --state-file "$state_file" --grace-sec 10 --window-sec 20)"
printf '%s\n' "$out" | grep -q '"decision": "grace"\|"decision": "waiting"'

cat > "$task_dir/TASK.md" <<'EOF'
# Task

## Task

```text
STATUS: working
```

## Checklist

- [x] one
EOF
cat > "$task_dir/artifacts/recipe-cook-learning.json" <<'EOF'
{"evidence_verdict":"ok"}
EOF

out="$(WATCH_NOW_EPOCH=115 "$SCRIPT" "$task_dir" --state-file "$state_file" --grace-sec 10 --window-sec 20)"
printf '%s\n' "$out" | grep -q '"decision": "healthy"'
printf '%s\n' "$out" | grep -q '"learning_exists": true'

out="$(WATCH_NOW_EPOCH=140 "$SCRIPT" "$task_dir" --state-file "$state_file" --grace-sec 10 --window-sec 20)"
printf '%s\n' "$out" | grep -q '"decision": "false_progress"'

cat > "$task_dir/SIGNAL.json" <<'EOF'
{"status":"blocked","outcome":"partial","reason":"live slot unavailable","timestamp":"2026-04-17T00:00:00Z"}
EOF

out="$(WATCH_NOW_EPOCH=141 "$SCRIPT" "$task_dir" --state-file "$state_file" --grace-sec 10 --window-sec 20)"
printf '%s\n' "$out" | grep -q '"decision": "terminal"'
printf '%s\n' "$out" | grep -q 'signal:blocked'

echo "watch-file-task tests: ok"
