#!/bin/bash
# batch-triage.sh — Bulk-fetch bugs from GitHub or Jira and score them all.
# Project is the only required arg — repo/Jira project derived from project.json.
#
# Usage:
#   bash scripts/batch-triage.sh <project> [options]
#
# Examples:
#   bash scripts/batch-triage.sh example-mobile-farm                          # all open type-bug
#   bash scripts/batch-triage.sh example-mobile-farm --team perps --limit 20  # perps bugs only
#   bash scripts/batch-triage.sh example-mobile-farm --team infra --since 2026-03-01
#   bash scripts/batch-triage.sh example-mobile-farm --source jira --limit 10

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECTS_DIR="${PROJECTS_DIR:-${SCRIPT_DIR}/../projects}"

# ── Parse args ────────────────────────────────────────────────────
PROJECT=""
SOURCE="github"
LABELS=()
TEAM=""
JQL_EXTRA=""
LIMIT=100
SINCE=""
MAX_AGE=""
EXCLUDE_ASSIGNED=false
PARALLEL=4
RESCORE=false
VALIDATE=false

usage() {
  cat <<EOF
Usage: bash scripts/batch-triage.sh <project> [options]

Options:
  --source <github|jira> Issue source (default: github)
  --label <label>        GitHub: filter by label (repeatable). Default: type-bug
  --team <team>          GitHub: --label team-<team>. Jira: label = team-<team>
  --jql <clause>         Jira: additional JQL appended to base query
  --limit <N>            Max issues to fetch (default: 100)
  --since <date>         Only issues updated after this date (ISO)
  --max-age <days>       Only issues updated within N days (alternative to --since)
  --exclude-assigned     Skip issues already assigned
  --parallel <N>         Concurrent scoring jobs (default: 4)
  --rescore              Re-score even if scores/<key>.json exists
  --validate             LLM validity check (Haiku) — is the bug still present?
EOF
  exit 0
}

# First positional arg is the project
if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
  PROJECT="$1"; shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)           SOURCE="$2"; shift 2;;
    --label)            LABELS+=("$2"); shift 2;;
    --team)             TEAM="$2"; shift 2;;
    --jql)              JQL_EXTRA="$2"; shift 2;;
    --limit)            LIMIT="$2"; shift 2;;
    --since)            SINCE="$2"; shift 2;;
    --max-age)          MAX_AGE="$2"; shift 2;;
    --exclude-assigned) EXCLUDE_ASSIGNED=true; shift;;
    --parallel)         PARALLEL="$2"; shift 2;;
    --rescore)          RESCORE=true; shift;;
    --validate)         VALIDATE=true; shift;;
    -h|--help)          usage;;
    *)                  echo "ERROR: unknown arg: $1" >&2; exit 1;;
  esac
done

[ -z "$PROJECT" ] && { echo "ERROR: project name required as first argument" >&2; usage; }

PROJECT_DIR="${PROJECTS_DIR}/${PROJECT}"
PROJECT_CONFIG="${PROJECT_DIR}/project.json"
[ -f "$PROJECT_CONFIG" ] || { echo "ERROR: project config not found: $PROJECT_CONFIG" >&2; exit 1; }

# Use team subdirectory when --team is specified
if [ -n "$TEAM" ]; then
  SCORES_DIR="${PROJECT_DIR}/scores/team-${TEAM}"
else
  SCORES_DIR="${PROJECT_DIR}/scores"
fi
mkdir -p "$SCORES_DIR"

# Apply --team as a label filter
if [ -n "$TEAM" ]; then
  LABELS+=("team-${TEAM}")
fi

# Default label for GitHub if none specified
if [ "$SOURCE" = "github" ] && [ ${#LABELS[@]} -eq 0 ]; then
  LABELS+=("type-bug")
fi

# Convert --max-age to --since
if [ -n "$MAX_AGE" ]; then
  [ -n "$SINCE" ] && { echo "ERROR: --since and --max-age are mutually exclusive" >&2; exit 1; }
  SINCE=$(python3 -c "
from datetime import datetime, timedelta, timezone
d = datetime.now(timezone.utc) - timedelta(days=${MAX_AGE})
print(d.strftime('%Y-%m-%d'))
")
fi

# ── Resolve repo/project from project.json ─────────────────────────
REPO=$(python3 -c "
import json
d = json.load(open('${PROJECT_CONFIG}'))
repo = d.get('ci', {}).get('repo', '')
if not repo:
    url = d.get('repo_url', '')
    # git@github.com:owner/repo.git → owner/repo
    repo = url.split(':')[-1].replace('.git', '')
print(repo)
")

JIRA_PROJECT=$(python3 -c "
import json
d = json.load(open('${PROJECT_CONFIG}'))
print(d.get('jira', {}).get('project', ''))
")

JIRA_BASE_URL=$(python3 -c "
import json
d = json.load(open('${PROJECT_CONFIG}'))
print(d.get('jira', {}).get('base_url', ''))
")

# ── Fetch issues ──────────────────────────────────────────────────
ISSUES_JSON=$(mktemp)
trap "rm -f '$ISSUES_JSON'" EXIT

if [ "$SOURCE" = "github" ]; then
  [ -z "$REPO" ] && { echo "ERROR: cannot resolve GitHub repo from project.json" >&2; exit 1; }

  # Validate team label exists on GitHub
  if [ -n "$TEAM" ]; then
    TEAM_LABEL="team-${TEAM}"
    LABEL_EXISTS=$(gh label list --repo "$REPO" --search "$TEAM_LABEL" --limit 10 --json name --jq '.[].name' 2>/dev/null | grep -x "$TEAM_LABEL" || true)
    if [ -z "$LABEL_EXISTS" ]; then
      SUGGESTIONS=$(gh label list --repo "$REPO" --search "team-${TEAM}" --limit 5 --json name --jq '.[].name' 2>/dev/null | head -5)
      echo "ERROR: label '${TEAM_LABEL}' not found in ${REPO}" >&2
      if [ -n "$SUGGESTIONS" ]; then
        echo "  Did you mean:" >&2
        echo "$SUGGESTIONS" | sed 's/^team-/    --team /' >&2
      fi
      exit 1
    fi
  fi

  # Build gh CLI args
  GH_ARGS=(issue list --repo "$REPO" --state open --limit "$LIMIT"
           --json number,title,labels,assignees,updatedAt)
  for label in "${LABELS[@]}"; do
    GH_ARGS+=(--label "$label")
  done

  DISPLAY_LABELS=$(IFS=', '; echo "${LABELS[*]}")
  echo "Fetching up to ${LIMIT} issues from ${REPO} (${DISPLAY_LABELS})..." >&2

  gh "${GH_ARGS[@]}" > "$ISSUES_JSON" 2>&1 || {
    echo "ERROR: gh issue list failed: $(cat "$ISSUES_JSON")" >&2
    exit 1
  }

  # Post-filter: --since and --exclude-assigned
  python3 -c "
import json, sys
from datetime import datetime

issues = json.load(open('${ISSUES_JSON}'))
since = '${SINCE}'
exclude_assigned = ${EXCLUDE_ASSIGNED:+True} or False

filtered = []
for issue in issues:
    if since:
        updated = issue.get('updatedAt', '')[:10]
        if updated < since:
            continue
    if exclude_assigned and issue.get('assignees'):
        continue
    filtered.append(issue)

json.dump(filtered, open('${ISSUES_JSON}', 'w'))
print(f'Fetched {len(issues)} issues, {len(filtered)} after filters', file=sys.stderr)
" 2>&1

elif [ "$SOURCE" = "jira" ]; then
  [ -z "$JIRA_PROJECT" ] && { echo "ERROR: jira.project not set in project.json" >&2; exit 1; }
  [ -z "$JIRA_BASE_URL" ] && { echo "ERROR: jira.base_url not set in project.json" >&2; exit 1; }
  [ -z "${JIRA_EMAIL:-}" ] && { echo "ERROR: JIRA_EMAIL env var required for Jira source" >&2; exit 1; }
  [ -z "${JIRA_TOKEN:-}" ] && { echo "ERROR: JIRA_TOKEN env var required for Jira source" >&2; exit 1; }

  # Build JQL
  JQL="project = ${JIRA_PROJECT} AND type = Bug AND status != Done"
  if [ -n "$TEAM" ]; then
    JQL="${JQL} AND labels = \"team-${TEAM}\""
  fi
  if [ -n "$SINCE" ]; then
    JQL="${JQL} AND updated >= \"${SINCE}\""
  fi
  if $EXCLUDE_ASSIGNED; then
    JQL="${JQL} AND assignee is EMPTY"
  fi
  if [ -n "$JQL_EXTRA" ]; then
    JQL="${JQL} AND ${JQL_EXTRA}"
  fi
  JQL="${JQL} ORDER BY updated DESC"

  echo "Fetching up to ${LIMIT} Jira issues (${JQL})..." >&2

  JIRA_RESPONSE=$(curl -s -u "${JIRA_EMAIL}:${JIRA_TOKEN}" \
    -H "Content-Type: application/json" \
    "${JIRA_BASE_URL}/rest/api/3/search?jql=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${JQL}'))")&maxResults=${LIMIT}&fields=key,summary,labels,assignee,updated,description,status" \
    2>&1) || {
    echo "ERROR: Jira API request failed" >&2
    exit 1
  }

  # Convert Jira response to our internal format
  python3 -c "
import json, sys

response = json.loads(sys.argv[1])
if 'errorMessages' in response:
    print(f'ERROR: Jira API error: {response[\"errorMessages\"]}', file=sys.stderr)
    sys.exit(1)

issues = []
for item in response.get('issues', []):
    fields = item.get('fields', {})
    issues.append({
        'key': item['key'],
        'title': fields.get('summary', ''),
        'labels': fields.get('labels', []),
        'assignee': fields.get('assignee'),
        'updatedAt': fields.get('updated', ''),
    })

json.dump(issues, open('${ISSUES_JSON}', 'w'))
print(f'Fetched {len(issues)} Jira issues', file=sys.stderr)
" "$JIRA_RESPONSE" 2>&1

else
  echo "ERROR: --source must be 'github' or 'jira'" >&2
  exit 1
fi

# ── Score each issue ──────────────────────────────────────────────
TOTAL=$(python3 -c "import json; print(len(json.load(open('${ISSUES_JSON}'))))")
if [ "$TOTAL" -eq 0 ]; then
  echo "No issues found matching filters." >&2
  exit 0
fi

SCORED=0
SKIPPED=0
FAILED=0

score_one() {
  local ref="$1"
  local source_flag="$2"

  local triage_args=("${source_flag}" "${ref}" --project "$PROJECT" --scores-dir "$SCORES_DIR")
  if ! $RESCORE; then
    triage_args+=(--skip-existing)
  fi

  local output
  output=$(bash "${SCRIPT_DIR}/triage-bug.sh" "${triage_args[@]}" 2>&1) || {
    echo "  FAIL: ${ref}: ${output}" >&2
    return 1
  }

  echo "$output" >&2
  return 0
}

# Run scoring with GNU parallel if available, else sequential with job control
if [ "$SOURCE" = "github" ]; then
  ISSUE_REFS=$(python3 -c "
import json
issues = json.load(open('${ISSUES_JSON}'))
repo = '${REPO}'
for issue in issues:
    print(f'{repo}#{issue[\"number\"]}')
")
  SOURCE_FLAG="--github"
else
  ISSUE_REFS=$(python3 -c "
import json
issues = json.load(open('${ISSUES_JSON}'))
for issue in issues:
    print(issue['key'])
")
  SOURCE_FLAG="--jira"
fi

echo "" >&2
echo "Scoring ${TOTAL} issues (parallel=${PARALLEL})..." >&2
echo "" >&2

# Job control for parallel execution
RUNNING=0
PIDS=()
REFS=()

while IFS= read -r ref; do
  [ -z "$ref" ] && continue

  # Launch scoring in background
  score_one "$ref" "$SOURCE_FLAG" &
  PIDS+=($!)
  REFS+=("$ref")
  RUNNING=$((RUNNING + 1))

  # Wait for a slot if at parallel limit
  if [ "$RUNNING" -ge "$PARALLEL" ]; then
    wait "${PIDS[0]}" && SCORED=$((SCORED + 1)) || FAILED=$((FAILED + 1))
    PIDS=("${PIDS[@]:1}")
    REFS=("${REFS[@]:1}")
    RUNNING=$((RUNNING - 1))
  fi
done <<< "$ISSUE_REFS"

# Wait for remaining jobs
for pid in "${PIDS[@]}"; do
  wait "$pid" && SCORED=$((SCORED + 1)) || FAILED=$((FAILED + 1))
done

# ── Validate (optional LLM pass) ──────────────────────────────────
if $VALIDATE; then
  echo "" >&2
  echo "Validating scored issues (LLM)..." >&2

  for score_file in "$SCORES_DIR"/*.json; do
    [ -f "$score_file" ] || continue
    # Skip if already validated (unless --rescore)
    if ! $RESCORE; then
      HAS_VALIDATION=$(python3 -c "
import json
d = json.load(open('${score_file}'))
print('yes' if 'validation' in d and d['validation'] else 'no')
" 2>/dev/null) || HAS_VALIDATION="no"
      if [ "$HAS_VALIDATION" = "yes" ]; then
        continue
      fi
    fi
    SCORE_FILE="$score_file" REPO="$REPO" bash "${SCRIPT_DIR}/validate-bug.sh" --score-file "$score_file" --project "$PROJECT" || true
  done
fi

# ── Print summary report ─────────────────────────────────────────
echo "" >&2

python3 "${SCRIPT_DIR}/lib/batch-triage-display.py" "$SCORES_DIR" "$ISSUES_JSON" "$REPO" "${DISPLAY_LABELS:-}"
