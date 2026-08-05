#!/bin/bash
# post-review.sh — Format and post a review comment to a GitHub PR.
#
# Usage:
#   bash scripts/post-review.sh --pr 27409 --repo example-org/example-mobile --commit-id <sha> --slot runner-mobile-1
#   bash scripts/post-review.sh --pr 27409 --repo example-org/example-mobile --commit-id <sha> --slot runner-mobile-1 --task-dir .task/review/27409-0321-1105
#
# Reads artifacts from the slot's repo:
#   .task/<flow>/<id>/artifacts/review.md
#   .task/<flow>/<id>/artifacts/line-comments.json
#   .task/<flow>/<id>/artifacts/recipe.json
#   .task/<flow>/<id>/artifacts/evidence/review.mp4
#
# Gets token usage via session-usage.sh.
# Posts a formatted comment to the PR via gh CLI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${PROJECT_DIR}/pool"

# ── Parse args ────────────────────────────────────────────────────
PR_NUMBER=""
GH_REPO=""
REVIEW_COMMIT_ID=""
SLOT_ID=""
TASK_DIR_ON_WORKER=""
DRY_RUN=false
OVERRIDE_RECOMMENDATION=""
OVERRIDE_RUNNER=""
OVERRIDE_MODEL=""
OVERRIDE_COST=""
OVERRIDE_TOTAL_TOKENS=""
EVIDENCE_MD_FILE=""
RUN_ID=""
SKIP_SESSION_USAGE=false
SKIP_ARTIFACT_UPLOAD=false
SKIP_ARCHIVE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)            RUN_ID="$2"; shift 2 ;;
    --pr)                PR_NUMBER="$2"; shift 2 ;;
    --repo)              GH_REPO="$2"; shift 2 ;;
    --commit-id)         REVIEW_COMMIT_ID="$2"; shift 2 ;;
    --slot)              SLOT_ID="$2"; shift 2 ;;
    --task-dir)          TASK_DIR_ON_WORKER="$2"; shift 2 ;;
    --recommendation)    OVERRIDE_RECOMMENDATION="$2"; shift 2 ;;
    --runner)            OVERRIDE_RUNNER="$2"; shift 2 ;;
    --model)             OVERRIDE_MODEL="$2"; shift 2 ;;
    --cost)              OVERRIDE_COST="$2"; shift 2 ;;
    --total-tokens)      OVERRIDE_TOTAL_TOKENS="$2"; shift 2 ;;
    --evidence-md-file)  EVIDENCE_MD_FILE="$2"; shift 2 ;;
    --skip-session-usage) SKIP_SESSION_USAGE=true; shift ;;
    --skip-artifact-upload) SKIP_ARTIFACT_UPLOAD=true; shift ;;
    --skip-archive)      SKIP_ARCHIVE=true; shift ;;
    --dry-run)           DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[ -z "$PR_NUMBER" ] && { echo "ERROR: --pr required"; exit 1; }
[ -z "$GH_REPO" ] && { echo "ERROR: --repo required"; exit 1; }
[ -z "$REVIEW_COMMIT_ID" ] && { echo "ERROR: --commit-id required"; exit 1; }
[[ "$REVIEW_COMMIT_ID" =~ ^[0-9a-fA-F]{7,40}$ ]] || { echo "ERROR: invalid --commit-id"; exit 1; }
[ -z "$SLOT_ID" ] && { echo "ERROR: --slot required"; exit 1; }

source "${SCRIPT_DIR}/lib/slot-common.sh"
load_slot_vars "$SLOT_ID"
load_project_config || true

# Derive artifact path: prefer --task-dir, fallback to farm-status
if [ -n "$TASK_DIR_ON_WORKER" ]; then
  TASK_REL=""
  ARTIFACT_BASE="${REMOTE_REPO}/${TASK_DIR_ON_WORKER}/artifacts"
else
  TASK_REL=$(python3 -c "
import json
with open('${PROJECT_DIR}/.farm-status.json') as f:
    data = json.load(f)
for s in data.get('slots', []):
    if s['slot'] == '${SLOT_ID}' and s.get('task_file'):
        print(s['task_file'])
        break
" 2>/dev/null || true)
  if [ -z "$TASK_REL" ]; then
    echo "ERROR: No task_file in farm-status for ${SLOT_ID} and no --task-dir provided"
    exit 1
  fi
  ARTIFACT_BASE="${REMOTE_REPO}/${WORKER_TASK_DIR_NAME:-${ARTIFACT_DIR:-.task}}/${TASK_REL}/artifacts"
fi

# ── Read artifacts ────────────────────────────────────────────────
read_artifact() {
  local path="$1"
  if is_local "$HOST" "$MACHINE"; then
    cat "$path" 2>/dev/null || true
  else
    ssh "${SSH_TARGET}" "cat '${path}' 2>/dev/null" 2>/dev/null || true
  fi
}

REVIEW_MD=$(read_artifact "${ARTIFACT_BASE}/review.md")
if [ -z "$REVIEW_MD" ]; then
  echo "ERROR: review.md not found at ${ARTIFACT_BASE}/review.md"
  exit 1
fi

LINE_COMMENTS_JSON=$(read_artifact "${ARTIFACT_BASE}/line-comments.json")
RECIPE_JSON=$(read_artifact "${ARTIFACT_BASE}/recipe.json")

# Check for video
VIDEO_SIZE=""
VIDEO_PATH="${ARTIFACT_BASE}/evidence/review.mp4"
if is_local "$HOST" "$MACHINE"; then
  [ -f "$VIDEO_PATH" ] && VIDEO_SIZE=$(du -h "$VIDEO_PATH" 2>/dev/null | cut -f1 | tr -d ' ')
else
  VIDEO_SIZE=$(ssh "${SSH_TARGET}" "du -h '${VIDEO_PATH}' 2>/dev/null | cut -f1 | tr -d ' '" 2>/dev/null || true)
fi

# ── Parse task file for metadata ──────────────────────────────────
# Layout: tasks/review/<id>/TASK.md — search by PR number in folder name
TASK_FILE=$(find "${PROJECT_DIR}/projects/${PROJECT_NAME}/tasks/review" -name "TASK.md" 2>/dev/null | while read f; do
  dir=$(basename "$(dirname "$f")")
  if echo "$dir" | grep -q "^${PR_NUMBER}-"; then echo "$f"; break; fi
done || true)
# Fallback: search content
if [ -z "$TASK_FILE" ]; then
  TASK_FILE=$(find "${PROJECT_DIR}/projects/${PROJECT_NAME}/tasks/review" -name "TASK.md" 2>/dev/null | xargs grep -l "PR_NUMBER:.*${PR_NUMBER}" 2>/dev/null | tail -1 || true)
fi

RUNNER=""
MODEL=""
EFFORT="auto"
if [ -n "$TASK_FILE" ]; then
  RUNNER=$(grep -m1 '^\*\*Runner:\*\*' "$TASK_FILE" | sed 's/.*\*\*Runner:\*\* *//' | tr -d '`' || true)
  MODEL=$(grep -m1 '^\*\*Model:\*\*' "$TASK_FILE" | sed 's/.*\*\*Model:\*\* *//' | tr -d '`' || true)
  EFFORT=$(grep -m1 '^\*\*Effort:\*\*' "$TASK_FILE" | sed 's/.*\*\*Effort:\*\* *//' | tr -d '`' || true)
fi
# CLI overrides (gateway passes these from run.metrics) win over TASK.md
[ -n "$OVERRIDE_RUNNER" ] && RUNNER="$OVERRIDE_RUNNER"
[ -n "$OVERRIDE_MODEL" ] && MODEL="$OVERRIDE_MODEL"
RUNNER="${RUNNER:-unknown}"
MODEL="${MODEL:-unknown}"
EFFORT="${EFFORT:-auto}"

# ── Parse recommendation ──────────────────────────────────────────
# Try line-comments.json first (has explicit "recommendation" field), then review.md
RECOMMENDATION=""
if [ -n "$LINE_COMMENTS_JSON" ]; then
  RECOMMENDATION=$(echo "$LINE_COMMENTS_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
r = d.get('recommendation', '') if isinstance(d, dict) else ''
print(r)
" 2>/dev/null || true)
fi
if [ -z "$RECOMMENDATION" ]; then
  # Look for "## Recommended Action\n\nAPPROVE" pattern in review.md
  RECOMMENDATION=$(echo "$REVIEW_MD" | grep -A2 'Recommended Action' | grep -oiE '(APPROVE|REQUEST_CHANGES|COMMENT)' | head -1 || true)
fi
RECOMMENDATION="${RECOMMENDATION:-COMMENT}"
if [ -n "$OVERRIDE_RECOMMENDATION" ]; then
  RECOMMENDATION="$OVERRIDE_RECOMMENDATION"
fi

# ── Detect tier from task file or review content ──────────────────
TIER="unknown"
if [ -n "$TASK_FILE" ]; then
  TIER=$(grep -m1 'REVIEW_TIER:' "$TASK_FILE" | sed 's/.*REVIEW_TIER: *//' | tr -d ' ' || true)
fi
if [ "$TIER" = "unknown" ] || [ -z "$TIER" ]; then
  TIER=$(echo "$REVIEW_MD" | grep -oiE '\b(light|standard|full)\b' | head -1 || true)
  TIER="${TIER:-unknown}"
fi

# ── Token usage ───────────────────────────────────────────────────
COST=""
TOTAL_TOKENS=""
DURATION=""

if [ -n "$OVERRIDE_COST" ]; then
  COST="\$${OVERRIDE_COST}"
elif [ "$SKIP_SESSION_USAGE" = false ]; then
  USAGE_OUTPUT=$(bash "${SCRIPT_DIR}/session-usage.sh" "$SLOT_ID" report 2>/dev/null || true)
  if [ -n "$USAGE_OUTPUT" ]; then
    COST=$(echo "$USAGE_OUTPUT" | grep '^cost_usd=' | cut -d= -f2)
    [ -n "$COST" ] && COST="\$${COST}"
  fi
fi

if [ -n "$OVERRIDE_TOTAL_TOKENS" ]; then
  if ! [[ "$OVERRIDE_TOTAL_TOKENS" =~ ^[0-9]+$ ]]; then
    echo "ERROR: --total-tokens must be a non-negative integer (got: $OVERRIDE_TOTAL_TOKENS)" >&2
    exit 1
  fi
  TOTAL_TOKENS=$(python3 -c "print(f'{${OVERRIDE_TOTAL_TOKENS}/1_000_000:.1f}M')" 2>/dev/null || echo "${OVERRIDE_TOTAL_TOKENS}")
elif [ -n "${USAGE_OUTPUT:-}" ]; then
  TOTAL_TOKENS=$(echo "$USAGE_OUTPUT" | grep '^total_tokens=' | cut -d= -f2)
  if [[ "$TOTAL_TOKENS" =~ ^[0-9]+$ ]]; then
    TOTAL_TOKENS=$(python3 -c "print(f'{${TOTAL_TOKENS}/1_000_000:.1f}M')" 2>/dev/null || echo "${TOTAL_TOKENS}")
  else
    TOTAL_TOKENS=""
  fi
fi
COST="${COST:-N/A}"
TOTAL_TOKENS="${TOTAL_TOKENS:-N/A}"

# ── Parse recipe.json for step count ──────────────────────────────
RECIPE_SUMMARY=""
if [ -n "$RECIPE_JSON" ]; then
  RECIPE_SUMMARY=$(echo "$RECIPE_JSON" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    steps = None
    workflow = data.get('workflow') if isinstance(data, dict) else None
    if isinstance(workflow, dict) and isinstance(workflow.get('nodes'), dict):
        steps = list(workflow['nodes'].values())
    if isinstance(steps, list):
        total = len(steps)
        passed = sum(1 for s in steps if isinstance(s, dict) and s.get('status','').lower() in ('pass','passed','done','complete'))
        if passed > 0:
            print(f'{passed}/{total} steps PASS')
        else:
            print(f'{total} steps defined')
    else:
        print('N/A')
except:
    print('N/A')
" 2>/dev/null || echo "N/A")
fi
RECIPE_SUMMARY="${RECIPE_SUMMARY:-N/A}"

# ── Parse line-comments.json for summary ──────────────────────────
LINE_COMMENTS_SUMMARY=""
LINE_COMMENTS_FORMATTED=""
if [ -n "$LINE_COMMENTS_JSON" ]; then
  # Parse into summary + formatted lines via python
  LC_TMPFILE=$(mktemp /tmp/lc-formatted-XXXXXX.md)
  LINE_COMMENTS_SUMMARY=$(echo "$LINE_COMMENTS_JSON" | python3 -c "
import json, sys

comments = json.load(sys.stdin)
if not isinstance(comments, list):
    comments = comments.get('comments', [])
total = len(comments)
counts = {}
for c in comments:
    sev = c.get('severity', 'comment').lower()
    counts[sev] = counts.get(sev, 0) + 1
parts = []
for sev in ['must_fix', 'suggestion', 'nitpick', 'comment']:
    if sev in counts:
        parts.append(f'{counts[sev]} {sev}')
summary = f'{total} comments: ' + ', '.join(parts) if parts else f'{total} comments'
print(summary)

# Write formatted lines to file
lines = []
for c in comments:
    file = c.get('file', c.get('path', ''))
    line = c.get('line', '')
    sev = c.get('severity', 'comment')
    body = c.get('body', c.get('comment', c.get('message', '')))
    # Truncate long bodies for the collapsible section
    loc = f'\`{file}:{line}\`' if line else f'\`{file}\`'
    lines.append(f'- **[{sev}]** {loc}: {body}')
with open('${LC_TMPFILE}', 'w') as f:
    f.write(chr(10).join(lines))
" 2>/dev/null || echo "none")
  LINE_COMMENTS_FORMATTED=$(cat "$LC_TMPFILE" 2>/dev/null || true)
  rm -f "$LC_TMPFILE"
fi
LINE_COMMENTS_SUMMARY="${LINE_COMMENTS_SUMMARY:-none}"

# ── Compose comment body ─────────────────────────────────────────
COMMENT_FILE=$(mktemp /tmp/review-comment-XXXXXX)
mv "$COMMENT_FILE" "${COMMENT_FILE}.md"
COMMENT_FILE="${COMMENT_FILE}.md"

# Split review.md into summary + rest
REVIEW_SPLIT=$(echo "$REVIEW_MD" | python3 -c "
import sys

lines = sys.stdin.read().split('\n')
summary_lines = []
rest_lines = []
in_summary = False
past_summary = False

for line in lines:
    if past_summary:
        rest_lines.append(line)
    elif in_summary:
        # Next ## heading ends the summary
        if line.startswith('## '):
            past_summary = True
            rest_lines.append(line)
        else:
            summary_lines.append(line)
    elif line.startswith('## '):
        in_summary = True
    # Skip everything before first ## heading (title, verdict line, etc.)

# Strip trailing blank lines from summary
while summary_lines and not summary_lines[-1].strip():
    summary_lines.pop()

print('---SUMMARY---')
print('\n'.join(summary_lines))
print('---REST---')
print('\n'.join(rest_lines))
")

REVIEW_SUMMARY=$(echo "$REVIEW_SPLIT" | sed -n '/^---SUMMARY---$/,/^---REST---$/p' | sed '1d;$d')
REVIEW_REST=$(echo "$REVIEW_SPLIT" | sed -n '/^---REST---$/,$p' | sed '1d')

cat > "$COMMENT_FILE" <<HEADER
## Automated Review — PR #${PR_NUMBER}

> **BETA** — Automated review from the farmslot pipeline.

| | |
|---|---|
| **Recommendation** | ${RECOMMENDATION} |
| **Reviewed commit** | \`${COMMIT_ID}\` |
| **Runner** | ${RUNNER} / ${MODEL} |
| **Tier** | ${TIER} |
| **Cost** | ${COST} (${TOTAL_TOKENS} tokens) |
| **Recipe** | ${RECIPE_SUMMARY} |

### Summary

${REVIEW_SUMMARY}

HEADER

# Visual evidence (inlined from gateway; was posted as a separate comment previously)
if [ -n "$EVIDENCE_MD_FILE" ] && [ -f "$EVIDENCE_MD_FILE" ]; then
  echo "## Visual Evidence" >> "$COMMENT_FILE"
  echo "" >> "$COMMENT_FILE"
  cat "$EVIDENCE_MD_FILE" >> "$COMMENT_FILE"
  echo "" >> "$COMMENT_FILE"
fi

# Full review in collapsible section
if [ -n "$REVIEW_REST" ]; then
  cat >> "$COMMENT_FILE" <<'DETAILS_START'
<details>
<summary>Full review details</summary>

DETAILS_START
  echo "$REVIEW_REST" >> "$COMMENT_FILE"
  cat >> "$COMMENT_FILE" <<'DETAILS_END'

</details>
DETAILS_END
  echo "" >> "$COMMENT_FILE"
fi

# Line comments in collapsible section
if [ -n "$LINE_COMMENTS_JSON" ] && [ "$LINE_COMMENTS_SUMMARY" != "none" ]; then
  cat >> "$COMMENT_FILE" <<LCSUMMARY
<details>
<summary>Line comments (${LINE_COMMENTS_SUMMARY})</summary>

LCSUMMARY
  echo "$LINE_COMMENTS_FORMATTED" >> "$COMMENT_FILE"
  cat >> "$COMMENT_FILE" <<'LCEND'

</details>
LCEND
  echo "" >> "$COMMENT_FILE"
fi

# Recipe in collapsible section
if [ -n "$RECIPE_JSON" ]; then
  cat >> "$COMMENT_FILE" <<RECIPE_START
<details>
<summary>Recipe (${RECIPE_SUMMARY})</summary>

\`\`\`json
RECIPE_START
  echo "$RECIPE_JSON" >> "$COMMENT_FILE"
  cat >> "$COMMENT_FILE" <<'RECIPE_END'
```

</details>
RECIPE_END
  echo "" >> "$COMMENT_FILE"
fi

# Video — standalone callers upload artifacts here. Gateway callers already
# uploaded and rendered visual evidence into EVIDENCE_MD_FILE.
ARTIFACTS_REPO=$(get_project_field "artifacts_repo")
VIDEO_DOWNLOAD_URL=""

if [ "$SKIP_ARTIFACT_UPLOAD" = false ] && [ -n "$ARTIFACTS_REPO" ]; then
  # Ensure artifacts are locally available for upload
  LOCAL_UPLOAD_DIR=""
  CLEANUP_UPLOAD_DIR=""
  if is_local "$HOST" "$MACHINE"; then
    LOCAL_UPLOAD_DIR="$ARTIFACT_BASE"
  else
    LOCAL_UPLOAD_DIR=$(mktemp -d /tmp/review-upload-XXXXXX)
    CLEANUP_UPLOAD_DIR="$LOCAL_UPLOAD_DIR"
    rsync -az "${SSH_TARGET}:${ARTIFACT_BASE}/" "${LOCAL_UPLOAD_DIR}/" 2>/dev/null || true
  fi

  if [ -d "$LOCAL_UPLOAD_DIR" ]; then
    echo "Uploading artifacts to ${ARTIFACTS_REPO}..." >&2
    UPLOAD_RESULT=$(bash "${SCRIPT_DIR}/gh-upload-asset.sh" \
      --dir "$LOCAL_UPLOAD_DIR" \
      --artifacts-repo "$ARTIFACTS_REPO" \
      --flow review --id "$PR_NUMBER" 2>/dev/null || true)

    if [ -n "$UPLOAD_RESULT" ] && [ -n "$VIDEO_SIZE" ]; then
      VIDEO_DOWNLOAD_URL="https://raw.githubusercontent.com/${ARTIFACTS_REPO}/main/reviews/${PR_NUMBER}/evidence/review.mp4"
    fi
  fi

  # Clean up temp dir if we created one
  [ -n "$CLEANUP_UPLOAD_DIR" ] && rm -r "$CLEANUP_UPLOAD_DIR" 2>/dev/null || true
fi

if [ "$SKIP_ARTIFACT_UPLOAD" = false ]; then
  echo "---" >> "$COMMENT_FILE"
  echo "" >> "$COMMENT_FILE"
  if [ -n "$VIDEO_DOWNLOAD_URL" ]; then
    echo "[review.mp4 (${VIDEO_SIZE})](${VIDEO_DOWNLOAD_URL})" >> "$COMMENT_FILE"
  elif [ -n "$VIDEO_SIZE" ]; then
    echo "*Video evidence: \`review.mp4\` (${VIDEO_SIZE}) — upload pending (local artifact only)*" >> "$COMMENT_FILE"
  else
    echo "*No video evidence recorded.*" >> "$COMMENT_FILE"
  fi
fi

# ── Post or dry-run ───────────────────────────────────────────────
COMMENT_MARKER=""
if [ -n "$RUN_ID" ]; then
  COMMENT_MARKER="<!-- farmslot-review-run:${RUN_ID} -->"
  {
    echo "$COMMENT_MARKER"
    cat "$COMMENT_FILE"
  } > "${COMMENT_FILE}.marked"
  mv "${COMMENT_FILE}.marked" "$COMMENT_FILE"
fi

echo "Comment file: ${COMMENT_FILE}"
echo "---"
head -20 "$COMMENT_FILE"
echo "..."
echo "---"

if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN — comment NOT posted. Review at: ${COMMENT_FILE}"
  exit 0
fi

unset GH_TOKEN
EXISTING_COMMENT_ID=""
if [ -n "$COMMENT_MARKER" ]; then
  EXISTING_COMMENT_ID=$(gh api --paginate "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" \
    --jq ".[] | select(.body | contains(\"${COMMENT_MARKER}\")) | .id" | tail -1)
fi
if [ -n "$EXISTING_COMMENT_ID" ]; then
  echo "Updating existing review comment ${EXISTING_COMMENT_ID} on ${GH_REPO}#${PR_NUMBER}..."
  gh api --method PATCH "repos/${GH_REPO}/issues/comments/${EXISTING_COMMENT_ID}" \
    -F "body=@${COMMENT_FILE}" >/dev/null
  echo "Comment updated successfully."
else
  echo "Posting comment to ${GH_REPO}#${PR_NUMBER}..."
  gh pr comment "$PR_NUMBER" --repo "$GH_REPO" --body-file "$COMMENT_FILE"
  echo "Comment posted successfully."
fi

# ── Submit formal GitHub review event (APPROVE / REQUEST_CHANGES) ─
if [ "$RECOMMENDATION" = "APPROVE" ]; then
  echo "Submitting APPROVE review event..."
  unset GH_TOKEN
  APPROVE_OUTPUT=""
  if APPROVE_OUTPUT=$(gh api --method POST "repos/${GH_REPO}/pulls/${PR_NUMBER}/reviews" \
    -f "body=Automated review — see comment above for full details." \
    -f "event=APPROVE" \
    -f "commit_id=${REVIEW_COMMIT_ID}" 2>&1); then
    echo "APPROVE submitted."
  elif echo "$APPROVE_OUTPUT" | grep -Eiq 'can ?not approve your own pull request|cannot approve your own pull request'; then
    echo "$APPROVE_OUTPUT" >&2
    echo "APPROVE skipped: GitHub does not allow approving your own pull request." >&2
  else
    echo "$APPROVE_OUTPUT" >&2
    exit 1
  fi
elif [ "$RECOMMENDATION" = "REQUEST_CHANGES" ]; then
  echo "Submitting REQUEST_CHANGES review event..."
  unset GH_TOKEN
  gh api --method POST "repos/${GH_REPO}/pulls/${PR_NUMBER}/reviews" \
    -f "body=Automated review — see comment above for full details." \
    -f "event=REQUEST_CHANGES" \
    -f "commit_id=${REVIEW_COMMIT_ID}" >/dev/null
  echo "REQUEST_CHANGES submitted."
fi

# ── Archive artifacts to orchestrator task folder ─────────────────
ORCH_TASK_DIR=""
if [ -n "$TASK_FILE" ]; then
  ORCH_TASK_DIR=$(dirname "$TASK_FILE")
fi
if [ -z "$ORCH_TASK_DIR" ] && [ -n "$TASK_REL" ]; then
  ORCH_TASK_DIR="${PROJECT_DIR}/projects/${PROJECT_NAME}/tasks/${TASK_REL}"
fi

if [ "$SKIP_ARCHIVE" = false ] && [ -n "$ORCH_TASK_DIR" ] && [ -d "$ORCH_TASK_DIR" ]; then
  mkdir -p "${ORCH_TASK_DIR}/artifacts"

  # Copy artifacts from slot to orchestrator task folder
  if is_local "$HOST" "$MACHINE"; then
    cp -r "${ARTIFACT_BASE}/"* "${ORCH_TASK_DIR}/artifacts/" 2>/dev/null || true
  else
    rsync -az "${SSH_TARGET}:${ARTIFACT_BASE}/" "${ORCH_TASK_DIR}/artifacts/" 2>/dev/null || true
  fi

  # Save the posted comment
  cp "$COMMENT_FILE" "${ORCH_TASK_DIR}/artifacts/comment.md" 2>/dev/null || true
  echo "Artifacts archived to: ${ORCH_TASK_DIR}/artifacts/"

  # ── Write meta.json + tier.txt for fine-tuning data collection ────────────
  echo "$TIER" > "${ORCH_TASK_DIR}/artifacts/tier.txt" 2>/dev/null || true

  COMPLETED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  STARTED_AT=$(python3 -c "
import json
try:
    with open('${PROJECT_DIR}/.farm-status.json') as f:
        data = json.load(f)
    for s in data.get('slots', []):
        if s['slot'] == '${SLOT_ID}' and s.get('dispatched_at'):
            print(s['dispatched_at'])
            break
except: pass
" 2>/dev/null || true)

  echo "${RECIPE_JSON}" | python3 -c "
import json, sys
runner = '${RUNNER}'
model = '${MODEL}'
started_at = '${STARTED_AT}'
completed_at = '${COMPLETED_AT}'
tier = '${TIER}'
recommendation = '${RECOMMENDATION}'

recipe_raw = sys.stdin.read().strip()
outcome = 'unknown'
validate_exit = -1
if recipe_raw:
    try:
        data = json.loads(recipe_raw)
        steps = None
        if isinstance(data, list): steps = data
        elif 'steps' in data: steps = data['steps']
        elif 'recipe' in data: steps = data['recipe']
        if isinstance(steps, list) and steps:
            total = len(steps)
            passed = sum(1 for s in steps if isinstance(s, dict) and s.get('status','').lower() in ('pass','passed','done','complete'))
            if passed == total: outcome, validate_exit = 'pass', 0
            elif passed > 0: outcome, validate_exit = 'partial', 1
            else: outcome, validate_exit = 'fail', 1
    except: pass

print(json.dumps({'runner': runner, 'model': model, 'tier': tier, 'recommendation': recommendation, 'started_at': started_at, 'completed_at': completed_at, 'validate_exit': validate_exit, 'outcome': outcome}, indent=2))
" > "${ORCH_TASK_DIR}/artifacts/meta.json" 2>/dev/null || true
  echo "meta.json written: ${ORCH_TASK_DIR}/artifacts/meta.json"
elif [ "$SKIP_ARCHIVE" = false ]; then
  echo "WARN: Could not determine orchestrator task folder — artifacts not archived locally"
fi

# Cleanup temp file
rm -f "$COMMENT_FILE"
