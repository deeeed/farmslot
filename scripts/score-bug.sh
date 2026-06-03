#!/bin/bash
# score-bug.sh — Score a bug's difficulty using project-specific heuristics.
#
# Project-agnostic CLI. Loads the scoring script from project.json and
# delegates to the project's scorer. Validates output JSON before emitting.
#
# Usage:
#   bash scripts/score-bug.sh --input path/to/bug.json [--project <name>]
#   cat bug.json | bash scripts/score-bug.sh --stdin --project <name>
#
# Accepts any supported input format (bug-input.json, raw GitHub API JSON).
# The project scorer handles format auto-detection internally.
#
# Output (stdout): JSON with at minimum:
#   { "issue_ref", "difficulty", "one_shot_probability", "category" }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECTS_DIR="${PROJECTS_DIR:-${SCRIPT_DIR}/../projects}"

# ── Parse args ────────────────────────────────────────────────────
INPUT=""
PROJECT=""
USE_STDIN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)   INPUT="$2"; shift 2;;
    --stdin)   USE_STDIN=true; shift;;
    --project) PROJECT="$2"; shift 2;;
    -h|--help)
      echo "Usage: bash scripts/score-bug.sh --input <bug.json> [--project <name>]"
      echo "       cat bug.json | bash scripts/score-bug.sh --stdin --project <name>"
      exit 0;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 1;;
  esac
done

if $USE_STDIN && [ -n "$INPUT" ]; then
  echo "ERROR: --stdin and --input are mutually exclusive" >&2
  exit 1
fi

if ! $USE_STDIN; then
  [ -z "$INPUT" ] && { echo "ERROR: --input or --stdin required" >&2; exit 1; }
  [ -f "$INPUT" ] || { echo "ERROR: file not found: $INPUT" >&2; exit 1; }
fi

# ── Auto-detect project from input path (fallback) ───────────────
if [ -z "$PROJECT" ] && [ -n "$INPUT" ]; then
  PROJECT=$(echo "$INPUT" | sed -n 's|.*projects/\([^/]*\)/.*|\1|p')
fi
[ -z "$PROJECT" ] && { echo "ERROR: --project required (could not auto-detect from path)" >&2; exit 1; }

# ── Load project config ──────────────────────────────────────────
PROJECT_CONFIG="${PROJECTS_DIR}/${PROJECT}/project.json"
[ -f "$PROJECT_CONFIG" ] || { echo "ERROR: project config not found: $PROJECT_CONFIG" >&2; exit 1; }

SCORING_SCRIPT=$(python3 -c "
import json
with open('${PROJECT_CONFIG}') as f:
    d = json.load(f)
print(d.get('scoring', {}).get('script', ''))
")

# Skip if project doesn't define a scoring script
if [ -z "$SCORING_SCRIPT" ]; then
  echo "INFO: No scoring.script configured in ${PROJECT_CONFIG} — skipping heuristic scoring." >&2
  exit 0
fi

# ── Prepare input and run scorer ─────────────────────────────────
PROJECT_DIR="${PROJECTS_DIR}/${PROJECT}"

if $USE_STDIN; then
  # Buffer stdin to a temp file so the scorer can read it
  TMPFILE=$(mktemp)
  trap "rm -f '$TMPFILE'" EXIT
  cat > "$TMPFILE"
  INPUT_ABS="$TMPFILE"
  SCORING_SCRIPT="${SCORING_SCRIPT//\{\{INPUT_FILE\}\}/$INPUT_ABS}"
  OUTPUT=$(cd "$PROJECT_DIR" && eval "$SCORING_SCRIPT") || {
    echo "ERROR: scoring script failed (exit $?)" >&2
    exit 1
  }
else
  INPUT_ABS=$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")
  SCORING_SCRIPT="${SCORING_SCRIPT//\{\{INPUT_FILE\}\}/$INPUT_ABS}"
  OUTPUT=$(cd "$PROJECT_DIR" && eval "$SCORING_SCRIPT") || {
    echo "ERROR: scoring script failed (exit $?)" >&2
    exit 1
  }
fi

# ── Validate output JSON ─────────────────────────────────────────
echo "$OUTPUT" | python3 -c "
import json, sys

try:
    d = json.load(sys.stdin)
except Exception as e:
    print(f'ERROR: scorer output is not valid JSON: {e}', file=sys.stderr)
    sys.exit(1)

required = ['difficulty', 'one_shot_probability', 'category']
missing = [f for f in required if f not in d]
if missing:
    print(f'ERROR: missing required fields: {missing}', file=sys.stderr)
    sys.exit(1)

valid_difficulties = ['low', 'medium', 'high', 'extreme']
if d['difficulty'] not in valid_difficulties:
    print(f'ERROR: difficulty must be one of {valid_difficulties}, got: {d[\"difficulty\"]}', file=sys.stderr)
    sys.exit(1)

prob = d['one_shot_probability']
if not isinstance(prob, (int, float)) or not (0 <= prob <= 1):
    print(f'ERROR: one_shot_probability must be 0-1, got: {prob}', file=sys.stderr)
    sys.exit(1)

json.dump(d, sys.stdout, indent=2)
print()
"
