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

# ── Resolve farmslot CLI (copied from scripts/lib/slot-common.sh) ─────────────
# shellcheck disable=SC1091
source "$(dirname "$0")/lib/resolve-farmslot-cli.sh"

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

SCORING_SCRIPT=$(jq -r '.scoring.script // empty' "$PROJECT_CONFIG")

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

# ── Validate output JSON via CLI (ported from Python heredoc) ────
echo "$OUTPUT" | "$FARMSLOT_CLI" internal validate-bug-score
