#!/bin/bash
# triage-bug.sh — Heuristic-only scoring. Writes scores/<key>.json without
# creating a task folder or running LLM grading. Free to run at scale.
#
# Usage:
#   bash scripts/triage-bug.sh --github you/example-app#12345 --project example-mobile-farm
#   bash scripts/triage-bug.sh --github https://github.com/you/example-app/issues/12345 --project example-mobile-farm
#   bash scripts/triage-bug.sh --jira PROJ-2236 --project example-mobile-farm
#   bash scripts/triage-bug.sh --input path/to/bug-input.json --project example-mobile-farm
#   cat bug-input.json | bash scripts/triage-bug.sh --stdin --project example-mobile-farm
#
# Output: writes/updates projects/<project>/scores/<key>.json with bug_input + heuristic.
# Preserves existing llm/final sections if the score file already exists (re-triage).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECTS_DIR="${PROJECTS_DIR:-${SCRIPT_DIR}/../projects}"

# ── Resolve farmslot CLI (copied from scripts/lib/slot-common.sh) ─────────────
if [ -z "${FARMSLOT_CLI:-}" ]; then
  _cli_candidate="$(cd "${SCRIPT_DIR}/../packages/cli" && pwd)/bin/farmslot.mjs"
  if [ -f "$_cli_candidate" ]; then
    FARMSLOT_CLI="$_cli_candidate"
  elif command -v farmslot >/dev/null 2>&1; then
    FARMSLOT_CLI="$(command -v farmslot)"
  else
    echo "FAIL: farmslot CLI not found (no packages/cli next to scripts/ and no farmslot on PATH). Set FARMSLOT_CLI." >&2
    exit 1
  fi
fi

# ── Parse args ────────────────────────────────────────────────────
INPUT=""
GITHUB_REF=""
JIRA_KEY=""
PROJECT=""
SCORES_DIR_OVERRIDE=""
USE_STDIN=false
SKIP_EXISTING=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)         INPUT="$2"; shift 2;;
    --github)        GITHUB_REF="$2"; shift 2;;
    --jira)          JIRA_KEY="$2"; shift 2;;
    --stdin)         USE_STDIN=true; shift;;
    --project)       PROJECT="$2"; shift 2;;
    --scores-dir)    SCORES_DIR_OVERRIDE="$2"; shift 2;;
    --skip-existing) SKIP_EXISTING=true; shift;;
    -h|--help)
      echo "Usage: bash scripts/triage-bug.sh --github <owner/repo#N or URL> --project <name>"
      echo "       bash scripts/triage-bug.sh --jira <KEY> --project <name>"
      echo "       bash scripts/triage-bug.sh --input <bug-input.json> --project <name>"
      echo "       cat bug-input.json | bash scripts/triage-bug.sh --stdin --project <name>"
      echo ""
      echo "Heuristic-only scoring — no LLM cost. Writes to projects/<project>/scores/<key>.json"
      echo ""
      echo "Options:"
      echo "  --skip-existing  Exit 0 if score file already has a heuristic section"
      exit 0;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 1;;
  esac
done

# ── Validate mutually exclusive input modes ───────────────────────
MODE_COUNT=0
$USE_STDIN && MODE_COUNT=$((MODE_COUNT + 1))
[ -n "$INPUT" ] && MODE_COUNT=$((MODE_COUNT + 1))
[ -n "$GITHUB_REF" ] && MODE_COUNT=$((MODE_COUNT + 1))
[ -n "$JIRA_KEY" ] && MODE_COUNT=$((MODE_COUNT + 1))
if [ "$MODE_COUNT" -eq 0 ]; then
  echo "ERROR: one of --github, --jira, --input, or --stdin required" >&2
  exit 1
fi
if [ "$MODE_COUNT" -gt 1 ]; then
  echo "ERROR: --github, --jira, --input, and --stdin are mutually exclusive" >&2
  exit 1
fi

[ -z "$PROJECT" ] && { echo "ERROR: --project required" >&2; exit 1; }

PROJECT_DIR="${PROJECTS_DIR}/${PROJECT}"
PROJECT_CONFIG="${PROJECT_DIR}/project.json"
[ -d "$PROJECT_DIR" ] || { echo "ERROR: project dir not found: $PROJECT_DIR" >&2; exit 1; }

# ── Early exit for --skip-existing ────────────────────────────────
if $SKIP_EXISTING; then
  # Derive the score key to check if file already exists (bash regex, no subprocess)
  SKIP_KEY=""
  if [ -n "$GITHUB_REF" ]; then
    if [[ "$GITHUB_REF" =~ /issues/([0-9]+)$ ]]; then
      SKIP_KEY="gh-${BASH_REMATCH[1]}"
    elif [[ "$GITHUB_REF" =~ \#([0-9]+)$ ]]; then
      SKIP_KEY="gh-${BASH_REMATCH[1]}"
    fi
  elif [ -n "$JIRA_KEY" ]; then
    SKIP_KEY=$(echo "$JIRA_KEY" | tr '[:upper:]' '[:lower:]')
  fi

  if [ -n "$SKIP_KEY" ]; then
    SKIP_FILE="${SCORES_DIR_OVERRIDE:-${PROJECT_DIR}/scores}/${SKIP_KEY}.json"
    if [ -f "$SKIP_FILE" ]; then
      HAS_HEURISTIC=$(jq -r 'if .heuristic then "yes" else "no" end' "$SKIP_FILE" 2>/dev/null || echo "no")
      if [ "$HAS_HEURISTIC" = "yes" ]; then
        echo "  Skipped (already scored): ${SKIP_KEY}" >&2
        exit 0
      fi
    fi
  fi
fi

# ── Resolve input to a bug-input.json file ────────────────────────
CLEANUP_INPUT=false

if [ -n "$GITHUB_REF" ]; then
  # Parse owner/repo and number from URL or shorthand using bash regex
  if [[ "$GITHUB_REF" =~ ^https?://github\.com/([^/]+/[^/]+)/issues/([0-9]+) ]]; then
    REPO="${BASH_REMATCH[1]}"
    NUMBER="${BASH_REMATCH[2]}"
  elif [[ "$GITHUB_REF" =~ ^([^#]+)\#([0-9]+)$ ]]; then
    REPO="${BASH_REMATCH[1]}"
    NUMBER="${BASH_REMATCH[2]}"
  else
    echo "ERROR: cannot parse GitHub ref: ${GITHUB_REF}" >&2
    exit 1
  fi

  echo "Fetching ${REPO}#${NUMBER}..." >&2

  # Fetch issue via gh CLI
  GH_JSON=$(gh issue view "$NUMBER" --repo "$REPO" --json title,body,labels,state,url 2>&1) || {
    echo "ERROR: gh issue view failed: ${GH_JSON}" >&2
    exit 1
  }

  # Build bug-input.json via the CLI parser (ported from the Python heredoc)
  INPUT=$(mktemp)
  CLEANUP_INPUT=true
  trap "rm -f '$INPUT'" EXIT

  echo "$GH_JSON" | "$FARMSLOT_CLI" internal parse-bug-input github > "$INPUT"

  echo "  Fetched: $(jq -r '.title' "$INPUT")" >&2

elif [ -n "$JIRA_KEY" ]; then
  # Resolve Jira base URL from project.json
  [ -f "$PROJECT_CONFIG" ] || { echo "ERROR: project config not found: $PROJECT_CONFIG" >&2; exit 1; }
  JIRA_BASE_URL=$(jq -r '.jira.base_url // empty' "$PROJECT_CONFIG")
  [ -z "$JIRA_BASE_URL" ] && { echo "ERROR: jira.base_url not set in project.json" >&2; exit 1; }
  [ -z "${JIRA_EMAIL:-}" ] && { echo "ERROR: JIRA_EMAIL env var required" >&2; exit 1; }
  [ -z "${JIRA_TOKEN:-}" ] && { echo "ERROR: JIRA_TOKEN env var required" >&2; exit 1; }

  echo "Fetching ${JIRA_KEY}..." >&2

  JIRA_JSON=$(curl -s -u "${JIRA_EMAIL}:${JIRA_TOKEN}" \
    -H "Content-Type: application/json" \
    "${JIRA_BASE_URL}/rest/api/3/issue/${JIRA_KEY}?fields=summary,description,labels,status,components" \
    2>&1) || {
    echo "ERROR: Jira API request failed" >&2
    exit 1
  }

  INPUT=$(mktemp)
  CLEANUP_INPUT=true
  trap "rm -f '$INPUT'" EXIT

  echo "$JIRA_JSON" | "$FARMSLOT_CLI" internal parse-bug-input jira > "$INPUT"

  echo "  Fetched: $(jq -r '.title' "$INPUT")" >&2

elif $USE_STDIN; then
  INPUT=$(mktemp)
  CLEANUP_INPUT=true
  trap "rm -f '$INPUT'" EXIT
  cat > "$INPUT"
fi

[ -f "$INPUT" ] || { echo "ERROR: file not found: $INPUT" >&2; exit 1; }

# ── Derive score key from bug-input.json ──────────────────────────
SCORE_KEY=$(jq -r '
  if .github_issue != "" then
    "gh-\(.github_issue | split("#") | last)"
  elif .jira_key != "" then
    .jira_key | ascii_downcase
  else
    error("bug_input has neither github_issue nor jira_key")
  end
' "$INPUT")

SCORES_DIR="${SCORES_DIR_OVERRIDE:-${PROJECT_DIR}/scores}"
SCORE_FILE="${SCORES_DIR}/${SCORE_KEY}.json"
mkdir -p "$SCORES_DIR"

# ── Run heuristic scoring ─────────────────────────────────────────
HEURISTIC=$(bash "${SCRIPT_DIR}/score-bug.sh" --input "$INPUT" --project "$PROJECT") || {
  echo "ERROR: score-bug.sh failed" >&2
  exit 1
}

# ── Build/update score file ───────────────────────────────────────
python3 -c "
import json, sys
from datetime import datetime, timezone

bug_input = json.load(open('${INPUT}'))
heuristic_raw = sys.argv[1].strip()

# Preserve existing sections if re-triaging
score = {}
try:
    score = json.load(open('${SCORE_FILE}'))
except (FileNotFoundError, json.JSONDecodeError):
    pass

gh = bug_input.get('github_issue', '')
jira = bug_input.get('jira_key', '')
score['issue_ref'] = gh or jira
score['scored_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
score['bug_input'] = bug_input

# score-bug.sh exits 0 with no stdout when scoring is not configured
if heuristic_raw:
    score['heuristic'] = json.loads(heuristic_raw)

json.dump(score, open('${SCORE_FILE}', 'w'), indent=2)
print()
" "$HEURISTIC"

echo "Scored: ${SCORE_FILE}"
# Display scoring details if heuristic was produced
HAS_HEURISTIC=$(jq -r 'if .heuristic then "yes" else "no" end' "$SCORE_FILE")
if [ "$HAS_HEURISTIC" = "yes" ]; then
  echo "  difficulty:  $(jq -r '.heuristic.difficulty' "$SCORE_FILE")"
  echo "  category:    $(jq -r '.heuristic.category' "$SCORE_FILE")"
  echo "  p(one-shot): $(jq -r '.heuristic.one_shot_probability' "$SCORE_FILE")"
else
  echo "  scoring: not configured (bug_input saved without heuristic)"
fi
