#!/bin/bash
# Run a model headlessly under the wrapper contract from SKILL.md § Headless Exec Guard.
#
# The contract was prose an orchestrator had to remember, so its two silent
# failures kept being re-derived live:
#   1. stdin hang     — `codex exec` with a non-TTY stdin blocks forever on
#                       "Reading additional input from stdin..."
#   2. no-verdict run — the process exits 0 (or a pipe launders a timeout kill)
#                       having written no terminal marker, and the empty result
#                       reads as a completed review
#
# This script closes stdin, keeps output in files rather than pipes, gates on the
# process's OWN exit code, and requires an anchored marker in the final-message
# artifact — not the log, which echoes the prompt and therefore contains the
# marker text already.
#
# usage:
#   headless-exec.sh --last <file> --log <file> [--marker '^VERDICT:']
#                    [--timeout <secs>] -- <command> [args...]
#
# exit: 0 only when the command exited 0 AND the marker is present in --last.
set -euo pipefail

last_file=""
log_file=""
marker='^VERDICT:'
timeout_secs=1200

die() {
  echo "headless-exec: $1" >&2
  [ -z "${2:-}" ] || echo "Next: $2" >&2
  exit 2
}

need_value() {
  [ -n "${2:-}" ] && [ "${2:0:1}" != "-" ] || die "$1 requires a value" "run with no arguments for usage"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --last) need_value "$1" "${2:-}"; last_file="$2"; shift 2 ;;
    --log) need_value "$1" "${2:-}"; log_file="$2"; shift 2 ;;
    --marker) need_value "$1" "${2:-}"; marker="$2"; shift 2 ;;
    --timeout) need_value "$1" "${2:-}"; timeout_secs="$2"; shift 2 ;;
    --) shift; break ;;
    *) die "unknown argument: $1" "separate the command with --" ;;
  esac
done

[ -n "$last_file" ] || die "--last <file> is required" \
  "the marker is checked in the final-message artifact, not the log"
[ -n "$log_file" ] || die "--log <file> is required" "headless output must go to a file, never a pipe"
[ $# -gt 0 ] || die "no command given" "put the model invocation after --"
[[ "$timeout_secs" =~ ^[1-9][0-9]*$ ]] || die "--timeout must be a positive integer, got: ${timeout_secs}" \
  "a large-diff review can legitimately need well over 10 minutes"

# A stale artifact from a previous run must not be read as this run's verdict.
: >"$last_file"

# `set -e` would abort before the exit code can be inspected; the whole point is
# to capture and report it.
set +e
timeout "$timeout_secs" "$@" </dev/null >"$log_file" 2>&1
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
  if [ "$rc" -eq 124 ]; then
    echo "headless-exec: FAILED — timed out after ${timeout_secs}s" >&2
    echo "Next: a mid-analysis kill produces silent no-verdict output. Raise --timeout, or" >&2
    echo "      narrow the task. Do not trust ${log_file}." >&2
  else
    echo "headless-exec: FAILED — command exited ${rc}" >&2
    echo "Next: read ${log_file} for the cause. Do not trust it as a result." >&2
  fi
  exit 1
fi

if ! grep -qE "$marker" "$last_file"; then
  echo "headless-exec: FAILED — exited 0 but ${last_file} has no ${marker}" >&2
  echo "Next: an exit code alone does not prove the model produced a result — an empty" >&2
  echo "      final message reads as a completed run. Check ${log_file} for a stall (a" >&2
  echo "      run stuck on stdin never reaches its verdict) and re-run." >&2
  exit 1
fi

cat "$last_file"
