#!/bin/bash
# validate-bug.sh — LLM check: is this bug still valid or likely already fixed?
#
# Uses claude CLI (haiku model) to assess validity based on:
#   - Bug description and age
#   - Linked/merged PRs from GitHub
#   - Recent commits mentioning the issue
#
# Usage:
#   bash scripts/validate-bug.sh --score-file <path> [--project <name>]
#
# Updates the score file with a "validation" section:
#   { "still_valid": true|false, "confidence": 0.0-1.0, "reason": "..." }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECTS_DIR="${PROJECTS_DIR:-${SCRIPT_DIR}/../projects}"

# ── Parse args ────────────────────────────────────────────────────
SCORE_FILE=""
PROJECT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --score-file) SCORE_FILE="$2"; shift 2;;
    --project)    PROJECT="$2"; shift 2;;
    -h|--help)
      echo "Usage: bash scripts/validate-bug.sh --score-file <path> [--project <name>]"
      echo ""
      echo "LLM validity check — is this bug still present or already fixed?"
      echo "Adds a 'validation' section to the score file."
      exit 0;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 1;;
  esac
done

[ -z "$SCORE_FILE" ] && { echo "ERROR: --score-file required" >&2; exit 1; }
[ -f "$SCORE_FILE" ] || { echo "ERROR: score file not found: $SCORE_FILE" >&2; exit 1; }

# Auto-detect project from path
if [ -z "$PROJECT" ]; then
  PROJECT=$(echo "$SCORE_FILE" | sed -n 's|.*projects/\([^/]*\)/.*|\1|p')
fi
[ -z "$PROJECT" ] && { echo "ERROR: --project required" >&2; exit 1; }

PROJECT_CONFIG="${PROJECTS_DIR}/${PROJECT}/project.json"
[ -f "$PROJECT_CONFIG" ] || { echo "ERROR: project config not found: $PROJECT_CONFIG" >&2; exit 1; }

# Resolve GitHub repo
REPO=$(python3 -c "
import json
d = json.load(open('${PROJECT_CONFIG}'))
repo = d.get('ci', {}).get('repo', '')
if not repo:
    url = d.get('repo_url', '')
    repo = url.split(':')[-1].replace('.git', '')
print(repo)
")

# ── Gather GitHub context ─────────────────────────────────────────
ISSUE_REF=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('issue_ref', ''))")
ISSUE_NUM=""
if echo "$ISSUE_REF" | grep -q '#'; then
  ISSUE_NUM=$(echo "$ISSUE_REF" | sed 's/.*#//')
fi

GITHUB_CONTEXT=""
if [ -n "$ISSUE_NUM" ]; then
  # Check for merged PRs referencing this issue
  MERGED_PRS=$(gh search prs --repo "$REPO" --state merged --limit 5 --json title,number,mergedAt "fixes #${ISSUE_NUM}" 2>/dev/null || echo "[]")
  if [ "$MERGED_PRS" != "[]" ] && [ -n "$MERGED_PRS" ]; then
    GITHUB_CONTEXT="${GITHUB_CONTEXT}
Merged PRs referencing this issue:
$(echo "$MERGED_PRS" | python3 -c "
import json, sys
for pr in json.load(sys.stdin):
    print(f\"  - PR #{pr['number']}: {pr['title']} (merged {pr.get('mergedAt', '?')[:10]})\")
" 2>/dev/null || true)"
  fi

  # Get latest comments
  COMMENTS=$(gh issue view "$ISSUE_NUM" --repo "$REPO" --json comments --jq '.comments[-3:]' 2>/dev/null || echo "[]")
  if [ "$COMMENTS" != "[]" ] && [ -n "$COMMENTS" ]; then
    GITHUB_CONTEXT="${GITHUB_CONTEXT}
Recent comments:
$(echo "$COMMENTS" | python3 -c "
import json, sys
for c in json.load(sys.stdin):
    date = c.get('createdAt', '')[:10]
    author = c.get('author', {}).get('login', '?')
    body = c.get('body', '')[:150].replace('\n', ' ')
    print(f'  {date} {author}: {body}')
" 2>/dev/null || true)"
  fi
fi

if [ -z "$GITHUB_CONTEXT" ]; then
  GITHUB_CONTEXT="No linked PRs or recent commits found referencing this issue."
fi

# ── Build prompt and call claude CLI ──────────────────────────────
TITLE=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('bug_input', {}).get('title', ''))")
STATE=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('bug_input', {}).get('state', 'open'))")
LABELS=$(python3 -c "import json; print(', '.join(json.load(open('${SCORE_FILE}')).get('bug_input', {}).get('labels', [])))")
DESCRIPTION=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('bug_input', {}).get('description', '')[:3000])")

echo "  Validating ${ISSUE_REF}..." >&2

PROMPT="Assess whether this bug is likely still valid (unfixed) or already resolved.

ISSUE: ${ISSUE_REF}
TITLE: ${TITLE}
STATE: ${STATE}
LABELS: ${LABELS}

DESCRIPTION (truncated):
${DESCRIPTION}

GITHUB ACTIVITY:
${GITHUB_CONTEXT}

Based on the above, determine:
1. Is this bug likely STILL VALID (present in codebase) or LIKELY FIXED/EXPIRED?
2. Your confidence level (0.0 = no idea, 1.0 = certain)
3. Brief reason (1-2 sentences)

Consider:
- If merged PRs explicitly fix this issue, it's likely fixed
- If no activity and the issue is old (>6 months), it may be stale but not necessarily fixed
- If the description references specific code/UI that still exists, it's likely still valid
- Issues about missing features vs bugs in existing features age differently

Respond ONLY with valid JSON, no markdown:
{\"still_valid\": true, \"confidence\": 0.8, \"reason\": \"No merged PRs reference this issue and the described UI component still exists.\"}"

LLM_RESPONSE=$(claude -p "$PROMPT" --model haiku --output-format text 2>/dev/null) || {
  echo "  WARN: claude CLI failed" >&2
  exit 1
}

# ── Parse response and update score file ──────────────────────────
python3 -c "
import json, sys
from datetime import datetime, timezone

response_text = sys.argv[1].strip()

# Handle markdown code blocks
if response_text.startswith('\`\`\`'):
    response_text = response_text.split('\n', 1)[-1].rsplit('\`\`\`', 1)[0].strip()

try:
    validation = json.loads(response_text)
except json.JSONDecodeError:
    print(f'  WARN: could not parse LLM response: {response_text[:100]}', file=sys.stderr)
    validation = {'still_valid': True, 'confidence': 0.0, 'reason': 'LLM response unparseable'}

validation.setdefault('still_valid', True)
validation.setdefault('confidence', 0.0)
validation.setdefault('reason', '')
validation['validated_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

score = json.load(open('${SCORE_FILE}'))
score['validation'] = validation
json.dump(score, open('${SCORE_FILE}', 'w'), indent=2)

status = 'STILL VALID' if validation['still_valid'] else 'LIKELY FIXED'
print(f'  {status} (confidence: {validation[\"confidence\"]}) — {validation[\"reason\"]}', file=sys.stderr)
" "$LLM_RESPONSE"
