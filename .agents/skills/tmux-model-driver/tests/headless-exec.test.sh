#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/headless-exec.sh"
work="$(mktemp -d -t headless-exec-test.XXXXXX)"

cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT

last="$work/run.last"
log="$work/run.log"

# A command that exits 0 and writes a verdict is the only accepted shape.
cat >"$work/ok.sh" <<EOF
#!/bin/bash
printf 'chatter that echoes the prompt, VERDICT: not this one\n'
printf 'VERDICT: APPROVE — fine\n' > "$last"
EOF
chmod +x "$work/ok.sh"
out="$("$SCRIPT" --last "$last" --log "$log" -- "$work/ok.sh")"
printf '%s\n' "$out" | grep -q '^VERDICT: APPROVE'

# The failure this guard exists for: exits 0, writes nothing. An exit code alone
# would report success and the empty file would read as a completed review.
cat >"$work/silent.sh" <<'EOF'
#!/bin/bash
printf 'started analysing...\n'
EOF
chmod +x "$work/silent.sh"
if "$SCRIPT" --last "$last" --log "$log" -- "$work/silent.sh" >"$work/silent.out" 2>"$work/silent.err"; then
  echo "FAIL: silent no-verdict run was accepted" >&2
  exit 1
fi
grep -q 'no ' "$work/silent.err"

# A stale verdict from a previous run must not satisfy the next one.
printf 'VERDICT: APPROVE — from an earlier run\n' > "$last"
if "$SCRIPT" --last "$last" --log "$log" -- "$work/silent.sh" >/dev/null 2>&1; then
  echo "FAIL: stale verdict artifact was reused" >&2
  exit 1
fi

# A non-zero exit is reported as failure even when a verdict is present.
cat >"$work/failing.sh" <<EOF
#!/bin/bash
printf 'VERDICT: APPROVE — despite failing\n' > "$last"
exit 3
EOF
chmod +x "$work/failing.sh"
if "$SCRIPT" --last "$last" --log "$log" -- "$work/failing.sh" >/dev/null 2>"$work/failing.err"; then
  echo "FAIL: non-zero exit was accepted" >&2
  exit 1
fi
grep -q 'exited 3' "$work/failing.err"

# stdin is closed for the child: a command that reads stdin must not block.
cat >"$work/reader.sh" <<EOF
#!/bin/bash
cat > /dev/null
printf 'VERDICT: APPROVE — stdin was closed\n' > "$last"
EOF
chmod +x "$work/reader.sh"
out="$(timeout 20 "$SCRIPT" --last "$last" --log "$log" -- "$work/reader.sh")" || {
  echo "FAIL: child blocked on stdin" >&2
  exit 1
}
printf '%s\n' "$out" | grep -q 'stdin was closed'

# A timeout is surfaced as failure, not laundered into success.
cat >"$work/slow.sh" <<'EOF'
#!/bin/bash
sleep 30
EOF
chmod +x "$work/slow.sh"
if "$SCRIPT" --last "$last" --log "$log" --timeout 1 -- "$work/slow.sh" >/dev/null 2>"$work/slow.err"; then
  echo "FAIL: timeout was accepted as success" >&2
  exit 1
fi
grep -q 'timed out' "$work/slow.err"

# Required arguments are enforced rather than defaulted into a silent guess.
"$SCRIPT" --log "$log" -- "$work/ok.sh" >/dev/null 2>&1 && {
  echo "FAIL: missing --last accepted" >&2
  exit 1
}

echo "headless-exec.test.sh: ok"
