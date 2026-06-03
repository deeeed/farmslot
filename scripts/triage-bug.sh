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
  # Derive the score key to check if file already exists
  SKIP_KEY=""
  if [ -n "$GITHUB_REF" ]; then
    SKIP_KEY=$(python3 -c "
import re, sys
ref = '${GITHUB_REF}'
m = re.match(r'https?://github\.com/[^/]+/[^/]+/issues/(\d+)', ref)
if m:
    print(f'gh-{m.group(1)}')
    sys.exit(0)
m = re.match(r'[^#]+#(\d+)$', ref)
if m:
    print(f'gh-{m.group(1)}')
    sys.exit(0)
sys.exit(1)
" 2>/dev/null) || true
  elif [ -n "$JIRA_KEY" ]; then
    SKIP_KEY=$(echo "$JIRA_KEY" | tr '[:upper:]' '[:lower:]')
  fi

  if [ -n "$SKIP_KEY" ]; then
    SKIP_FILE="${SCORES_DIR_OVERRIDE:-${PROJECT_DIR}/scores}/${SKIP_KEY}.json"
    if [ -f "$SKIP_FILE" ]; then
      HAS_HEURISTIC=$(python3 -c "
import json
d = json.load(open('${SKIP_FILE}'))
print('yes' if 'heuristic' in d and d['heuristic'] else 'no')
" 2>/dev/null) || HAS_HEURISTIC="no"
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
  # Parse owner/repo and number from URL or shorthand
  read -r REPO NUMBER <<< "$(python3 -c "
import sys, re

ref = '${GITHUB_REF}'

# https://github.com/owner/repo/issues/123
m = re.match(r'https?://github\.com/([^/]+/[^/]+)/issues/(\d+)', ref)
if m:
    print(m.group(1), m.group(2))
    sys.exit(0)

# owner/repo#123
m = re.match(r'([^#]+)#(\d+)$', ref)
if m:
    print(m.group(1), m.group(2))
    sys.exit(0)

print(f'ERROR: cannot parse GitHub ref: {ref}', file=sys.stderr)
sys.exit(1)
")"

  echo "Fetching ${REPO}#${NUMBER}..." >&2

  # Fetch issue via gh CLI
  GH_JSON=$(gh issue view "$NUMBER" --repo "$REPO" --json title,body,labels,state,url 2>&1) || {
    echo "ERROR: gh issue view failed: ${GH_JSON}" >&2
    exit 1
  }

  # Build bug-input.json from GitHub API response
  INPUT=$(mktemp)
  CLEANUP_INPUT=true
  trap "rm -f '$INPUT'" EXIT

  python3 -c "
import json, re, sys

gh = json.loads(sys.argv[1])
repo = '${REPO}'
number = '${NUMBER}'
body = gh.get('body', '') or ''

# Parse acceptance criteria
ac = []
ac_match = re.search(r'##\s*(?:Acceptance Criteria|Expected Behavior)\s*\n(.*?)(?=\n##|\Z)', body, re.DOTALL)
if ac_match:
    for line in ac_match.group(1).strip().split('\n'):
        line = re.sub(r'^[\s*-]+', '', line).strip()
        if line:
            ac.append(line)

# Parse steps to reproduce
steps = []
steps_match = re.search(r'##\s*(?:Steps to Reproduce|Repro Steps)\s*\n(.*?)(?=\n##|\Z)', body, re.DOTALL)
if steps_match:
    for line in steps_match.group(1).strip().split('\n'):
        line = re.sub(r'^[\s\d.*-]+', '', line).strip()
        if line:
            steps.append(line)

# Extract image filenames from body
screenshots = []
for m in re.finditer(r'!\[[^\]]*\]\(([^)]+)\)', body):
    screenshots.append(m.group(1).rsplit('/', 1)[-1][:50])
for m in re.finditer(r'<img[^>]+src=[\"\\']([^\"\\'>]+)[\"\\']', body):
    screenshots.append(m.group(1).rsplit('/', 1)[-1][:50])

# Extract linked PRs
linked_prs = []
for m in re.finditer(r'(?:' + re.escape(repo) + r')?#(\d+)', body):
    pr_num = m.group(1)
    if pr_num != number:
        linked_prs.append(f'{repo}#{pr_num}')

labels = [l.get('name', l) if isinstance(l, dict) else l for l in gh.get('labels', [])]

bug_input = {
    'source': 'github',
    'github_issue': f'{repo}#{number}',
    'jira_key': '',
    'title': gh.get('title', ''),
    'description': body,
    'acceptance_criteria': ac,
    'affected_area': '',
    'steps_to_reproduce': steps,
    'labels': labels,
    'components': [],
    'screenshots': screenshots,
    'state': gh.get('state', 'open').lower(),
    'linked_prs': list(set(linked_prs))
}

json.dump(bug_input, open('${INPUT}', 'w'), indent=2)
" "$GH_JSON"

  echo "  Fetched: $(python3 -c "import json; print(json.load(open('${INPUT}'))['title'])")" >&2

elif [ -n "$JIRA_KEY" ]; then
  # Resolve Jira base URL from project.json
  [ -f "$PROJECT_CONFIG" ] || { echo "ERROR: project config not found: $PROJECT_CONFIG" >&2; exit 1; }
  JIRA_BASE_URL=$(python3 -c "
import json
d = json.load(open('${PROJECT_CONFIG}'))
print(d.get('jira', {}).get('base_url', ''))
")
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

  python3 -c "
import json, re, sys

jira = json.loads(sys.argv[1])
if 'errorMessages' in jira:
    print(f'ERROR: Jira API: {jira[\"errorMessages\"]}', file=sys.stderr)
    sys.exit(1)

fields = jira.get('fields', {})
key = jira.get('key', '${JIRA_KEY}')

# Description: Jira uses ADF (Atlassian Document Format), flatten to text
desc_raw = fields.get('description', '')
if isinstance(desc_raw, dict):
    # ADF → extract text nodes recursively
    def flatten_adf(node):
        if isinstance(node, str):
            return node
        if isinstance(node, dict):
            if node.get('type') == 'text':
                return node.get('text', '')
            return ' '.join(flatten_adf(c) for c in node.get('content', []))
        if isinstance(node, list):
            return ' '.join(flatten_adf(c) for c in node)
        return ''
    body = flatten_adf(desc_raw)
else:
    body = desc_raw or ''

# Parse AC
ac = []
ac_match = re.search(r'(?:Acceptance Criteria|Expected Behavior)[:\s]*\n(.*?)(?=\n[A-Z]|\Z)', body, re.DOTALL)
if ac_match:
    for line in ac_match.group(1).strip().split('\n'):
        line = re.sub(r'^[\s*-]+', '', line).strip()
        if line:
            ac.append(line)

# Parse steps
steps = []
steps_match = re.search(r'(?:Steps to Reproduce|Repro Steps)[:\s]*\n(.*?)(?=\n[A-Z]|\Z)', body, re.DOTALL)
if steps_match:
    for line in steps_match.group(1).strip().split('\n'):
        line = re.sub(r'^[\s\d.*-]+', '', line).strip()
        if line:
            steps.append(line)

labels = fields.get('labels', [])
components = [c.get('name', c) if isinstance(c, dict) else c for c in fields.get('components', [])]

bug_input = {
    'source': 'jira',
    'github_issue': '',
    'jira_key': key,
    'title': fields.get('summary', ''),
    'description': body,
    'acceptance_criteria': ac,
    'affected_area': '',
    'steps_to_reproduce': steps,
    'labels': labels,
    'components': components,
    'screenshots': [],
    'state': (fields.get('status', {}).get('name', 'open') if isinstance(fields.get('status'), dict) else 'open').lower(),
    'linked_prs': []
}

json.dump(bug_input, open('${INPUT}', 'w'), indent=2)
" "$JIRA_JSON"

  echo "  Fetched: $(python3 -c "import json; print(json.load(open('${INPUT}'))['title'])")" >&2

elif $USE_STDIN; then
  INPUT=$(mktemp)
  CLEANUP_INPUT=true
  trap "rm -f '$INPUT'" EXIT
  cat > "$INPUT"
fi

[ -f "$INPUT" ] || { echo "ERROR: file not found: $INPUT" >&2; exit 1; }

# ── Derive score key from bug-input.json ──────────────────────────
SCORE_KEY=$(python3 -c "
import json, sys
bug = json.load(open('${INPUT}'))
gh = bug.get('github_issue', '')
jira = bug.get('jira_key', '')
if gh:
    # you/example-app#12345 → gh-12345
    num = gh.rsplit('#', 1)[-1] if '#' in gh else gh
    print(f'gh-{num}')
elif jira:
    print(jira.lower())
else:
    print('unknown', file=sys.stderr)
    sys.exit(1)
")

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
HAS_HEURISTIC=$(python3 -c "
import json
d = json.load(open('${SCORE_FILE}'))
print('yes' if 'heuristic' in d and d['heuristic'] else 'no')
")
if [ "$HAS_HEURISTIC" = "yes" ]; then
  echo "  difficulty:  $(python3 -c "import json; print(json.load(open('${SCORE_FILE}'))['heuristic']['difficulty'])")"
  echo "  category:    $(python3 -c "import json; print(json.load(open('${SCORE_FILE}'))['heuristic']['category'])")"
  echo "  p(one-shot): $(python3 -c "import json; print(json.load(open('${SCORE_FILE}'))['heuristic']['one_shot_probability'])")"
else
  echo "  scoring: not configured (bug_input saved without heuristic)"
fi
