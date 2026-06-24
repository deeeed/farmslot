#!/bin/bash
# post-fix.sh — Format and post a fix report comment to a GitHub PR.
#
# Usage:
#   bash scripts/post-fix.sh --pr 27409 --repo you/example-app --slot runner-mobile-1 [--dry-run]
#   bash scripts/post-fix.sh --pr 27409 --repo you/example-app --slot runner-mobile-1 --task-dir .task/fix/proj-2403-0321-1350
#
# Reads artifacts from the slot's repo:
#   .task/<flow>/<id>/artifacts/report.md       (required)
#   .task/<flow>/<id>/artifacts/recipe.json     (optional)
#   .task/<flow>/<id>/artifacts/before.mp4      (optional)
#   .task/<flow>/<id>/artifacts/after.mp4       (optional)
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
SLOT_ID=""
TASK_DIR_ON_WORKER=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)       PR_NUMBER="$2"; shift 2 ;;
    --repo)     GH_REPO="$2"; shift 2 ;;
    --slot)     SLOT_ID="$2"; shift 2 ;;
    --task-dir) TASK_DIR_ON_WORKER="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[ -z "$PR_NUMBER" ] && { echo "ERROR: --pr required"; exit 1; }
[ -z "$GH_REPO" ] && { echo "ERROR: --repo required"; exit 1; }
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

REPORT_MD=$(read_artifact "${ARTIFACT_BASE}/report.md")
if [ -z "$REPORT_MD" ]; then
  echo "ERROR: report.md not found at ${ARTIFACT_BASE}/report.md"
  exit 1
fi

RECIPE_JSON=$(read_artifact "${ARTIFACT_BASE}/recipe.json")

# Check for videos
check_video_size() {
  local video_path="$1"
  local size=""
  if is_local "$HOST" "$MACHINE"; then
    [ -f "$video_path" ] && size=$(du -h "$video_path" 2>/dev/null | cut -f1 | tr -d ' ')
  else
    size=$(ssh "${SSH_TARGET}" "du -h '${video_path}' 2>/dev/null | cut -f1 | tr -d ' '" 2>/dev/null || true)
  fi
  echo "$size"
}

BEFORE_SIZE=$(check_video_size "${ARTIFACT_BASE}/before.mp4")
AFTER_SIZE=$(check_video_size "${ARTIFACT_BASE}/after.mp4")

# ── Parse task file for metadata ──────────────────────────────────
# Layout: tasks/fix/<id>/TASK.md — search by PR number in content
TASK_FILE=$(find "${PROJECT_DIR}/projects/${PROJECT_NAME}/tasks/fix" -name "TASK.md" 2>/dev/null | xargs grep -l "PR_NUMBER:.*${PR_NUMBER}\|PR.*${PR_NUMBER}\|#${PR_NUMBER}" 2>/dev/null | tail -1 || true)

RUNNER="unknown"
MODEL="unknown"
EFFORT="auto"
JIRA=""
if [ -n "$TASK_FILE" ]; then
  RUNNER=$(grep -m1 '^\*\*Runner:\*\*' "$TASK_FILE" | sed 's/.*\*\*Runner:\*\* *//' | tr -d '`' || true)
  MODEL=$(grep -m1 '^\*\*Model:\*\*' "$TASK_FILE" | sed 's/.*\*\*Model:\*\* *//' | tr -d '`' || true)
  EFFORT=$(grep -m1 '^\*\*Effort:\*\*' "$TASK_FILE" | sed 's/.*\*\*Effort:\*\* *//' | tr -d '`' || true)
  JIRA=$(grep -m1 '^\*\*Jira:\*\*\|^JIRA:' "$TASK_FILE" | sed 's/.*\*\*Jira:\*\* *//;s/^JIRA: *//' | tr -d '`' || true)
  if [ -z "$JIRA" ]; then
    JIRA=$(grep -m1 '^GITHUB_ISSUE:' "$TASK_FILE" | sed 's/^GITHUB_ISSUE: *//' | tr -d '`' || true)
  fi
fi
RUNNER="${RUNNER:-unknown}"
MODEL="${MODEL:-unknown}"
EFFORT="${EFFORT:-auto}"
JIRA="${JIRA:-N/A}"

# ── Compute orchestrator task folder (needed for PR description update) ──────
ORCH_TASK_DIR=""
if [ -n "$TASK_FILE" ]; then
  ORCH_TASK_DIR=$(dirname "$TASK_FILE")
fi
if [ -z "$ORCH_TASK_DIR" ] && [ -n "$TASK_REL" ]; then
  ORCH_TASK_DIR="${PROJECT_DIR}/projects/${PROJECT_NAME}/tasks/${TASK_REL}"
fi

# ── Token usage ───────────────────────────────────────────────────
COST=""
TOTAL_TOKENS=""

USAGE_OUTPUT=$(bash "${SCRIPT_DIR}/session-usage.sh" "$SLOT_ID" report 2>/dev/null || true)
if [ -n "$USAGE_OUTPUT" ]; then
  COST=$(echo "$USAGE_OUTPUT" | grep '^cost_usd=' | cut -d= -f2)
  TOTAL_TOKENS=$(echo "$USAGE_OUTPUT" | grep '^total_tokens=' | cut -d= -f2)
  if [ -n "$COST" ]; then
    COST="\$${COST}"
  fi
  if [ -n "$TOTAL_TOKENS" ]; then
    TOTAL_TOKENS=$(python3 -c "print(f'{int(${TOTAL_TOKENS})/1_000_000:.1f}M')" 2>/dev/null || echo "${TOTAL_TOKENS}")
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
    if isinstance(data, list):
        steps = data
    elif 'steps' in data:
        steps = data['steps']
    elif 'recipe' in data:
        steps = data['recipe']
    elif 'validate' in data:
        v = data['validate']
        if isinstance(v, dict):
            for key in ('runtime', 'visual', 'static'):
                if key in v and isinstance(v[key], dict) and 'steps' in v[key]:
                    steps = v[key]['steps']
                    break
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

# ── Compose comment body ─────────────────────────────────────────
COMMENT_FILE=$(mktemp /tmp/fix-comment-XXXXXX)
mv "$COMMENT_FILE" "${COMMENT_FILE}.md"
COMMENT_FILE="${COMMENT_FILE}.md"

cat > "$COMMENT_FILE" <<HEADER
## Automated Fix Report — PR #${PR_NUMBER}

> **BETA** — Automated fix from the farmslot pipeline.

| | |
|---|---|
| **Ticket** | ${JIRA} |
| **Runner** | ${RUNNER} / ${MODEL} |
| **Cost** | ${COST} (${TOTAL_TOKENS} tokens) |
| **Recipe** | ${RECIPE_SUMMARY} |

HEADER

# Append report.md content
echo "$REPORT_MD" >> "$COMMENT_FILE"

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

# ── Upload artifacts ──────────────────────────────────────────────
echo "---" >> "$COMMENT_FILE"
echo "" >> "$COMMENT_FILE"
ARTIFACTS_REPO=$(get_project_field "artifacts_repo")
BEFORE_URL=""
AFTER_URL=""

if [ -n "$ARTIFACTS_REPO" ]; then
  # Ensure artifacts are locally available for upload
  LOCAL_UPLOAD_DIR=""
  CLEANUP_UPLOAD_DIR=""
  if is_local "$HOST" "$MACHINE"; then
    LOCAL_UPLOAD_DIR="$ARTIFACT_BASE"
  else
    LOCAL_UPLOAD_DIR=$(mktemp -d /tmp/fix-upload-XXXXXX)
    CLEANUP_UPLOAD_DIR="$LOCAL_UPLOAD_DIR"
    rsync -az "${SSH_TARGET}:${ARTIFACT_BASE}/" "${LOCAL_UPLOAD_DIR}/" 2>/dev/null || true
  fi

  if [ -d "$LOCAL_UPLOAD_DIR" ]; then
    # Restructure: videos go into evidence/ subfolder (mirrors reviews/<PR>/evidence/)
    STRUCTURED_DIR=$(mktemp -d /tmp/fix-structured-XXXXXX)
    mkdir -p "${STRUCTURED_DIR}/evidence"
    # Copy non-video files to root
    for f in "${LOCAL_UPLOAD_DIR}"/*.md "${LOCAL_UPLOAD_DIR}"/*.json; do
      [ -f "$f" ] && cp "$f" "${STRUCTURED_DIR}/" 2>/dev/null || true
    done
    # Copy videos to evidence/
    for f in "${LOCAL_UPLOAD_DIR}"/*.mp4 "${LOCAL_UPLOAD_DIR}"/*.mov "${LOCAL_UPLOAD_DIR}"/*.webm; do
      [ -f "$f" ] && cp "$f" "${STRUCTURED_DIR}/evidence/" 2>/dev/null || true
    done

    echo "Uploading artifacts to ${ARTIFACTS_REPO}..." >&2
    UPLOAD_RESULT=$(bash "${SCRIPT_DIR}/gh-upload-asset.sh" \
      --dir "$STRUCTURED_DIR" \
      --artifacts-repo "$ARTIFACTS_REPO" \
      --flow fix --id "$PR_NUMBER" 2>/dev/null || true)
    rm -rf "$STRUCTURED_DIR"

    if [ -n "$UPLOAD_RESULT" ]; then
      [ -n "$BEFORE_SIZE" ] && BEFORE_URL="https://raw.githubusercontent.com/${ARTIFACTS_REPO}/main/fixes/${PR_NUMBER}/evidence/before.mp4"
      [ -n "$AFTER_SIZE" ] && AFTER_URL="https://raw.githubusercontent.com/${ARTIFACTS_REPO}/main/fixes/${PR_NUMBER}/evidence/after.mp4"
    fi
  fi

  # Clean up temp dir if we created one
  [ -n "$CLEANUP_UPLOAD_DIR" ] && rm -r "$CLEANUP_UPLOAD_DIR" 2>/dev/null || true
fi

# ── Archive artifacts to orchestrator task folder (early — needed for PR desc update) ──
if [ -n "$ORCH_TASK_DIR" ]; then
  mkdir -p "${ORCH_TASK_DIR}/artifacts"
  if is_local "$HOST" "$MACHINE"; then
    cp -r "${ARTIFACT_BASE}/"* "${ORCH_TASK_DIR}/artifacts/" 2>/dev/null || true
  else
    rsync -az "${SSH_TARGET}:${ARTIFACT_BASE}/" "${ORCH_TASK_DIR}/artifacts/" 2>/dev/null || true
  fi
  echo "Artifacts archived to: ${ORCH_TASK_DIR}/artifacts/" >&2

  # ── Write meta.json for fine-tuning data collection ────────────────────────
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

print(json.dumps({'runner': runner, 'model': model, 'started_at': started_at, 'completed_at': completed_at, 'validate_exit': validate_exit, 'outcome': outcome}, indent=2))
" > "${ORCH_TASK_DIR}/artifacts/meta.json" 2>/dev/null || true
  echo "meta.json written: ${ORCH_TASK_DIR}/artifacts/meta.json" >&2
fi

# ── Update PR description with real artifact URLs ─────────────────────────────
PR_DESC_FILE="${ORCH_TASK_DIR:+${ORCH_TASK_DIR}/artifacts/pr-description.md}"
if [ -n "$PR_DESC_FILE" ] && [ -f "$PR_DESC_FILE" ] && { [ -n "$BEFORE_URL" ] || [ -n "$AFTER_URL" ]; }; then
  python3 - "$PR_DESC_FILE" "$BEFORE_URL" "$AFTER_URL" "$BEFORE_SIZE" "$AFTER_SIZE" <<'PYEOF'
import sys, re
fpath, before_url, after_url, before_size, after_size = sys.argv[1:6]
content = open(fpath).read()
if before_url:
    label = "before.mp4 ({})".format(before_size) if before_size else "before.mp4"
    content = re.sub(r'See `?\.task/[^`\n]+/before\.mp4`?[^\n]*', '[{}]({})'.format(label, before_url), content)
if after_url:
    label = "after.mp4 ({})".format(after_size) if after_size else "after.mp4"
    content = re.sub(r'See `?\.task/[^`\n]+/after\.mp4`?[^\n]*', '[{}]({})'.format(label, after_url), content)
open(fpath, 'w').write(content)
print("pr-description.md updated with artifact URLs")
PYEOF
  if [ "$DRY_RUN" = false ]; then
    echo "Updating PR #${PR_NUMBER} description with artifact URLs..."
    unset GH_TOKEN
    gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --body-file "$PR_DESC_FILE"
    echo "PR description updated."
  else
    echo "DRY RUN — PR description not updated. Local file updated at: ${PR_DESC_FILE}"
  fi
fi

# Video links
VIDEO_LINKS=()
if [ -n "$BEFORE_URL" ]; then
  VIDEO_LINKS+=("[before.mp4 (${BEFORE_SIZE})](${BEFORE_URL})")
elif [ -n "$BEFORE_SIZE" ]; then
  VIDEO_LINKS+=("*before.mp4 (${BEFORE_SIZE}) — local only*")
fi
if [ -n "$AFTER_URL" ]; then
  VIDEO_LINKS+=("[after.mp4 (${AFTER_SIZE})](${AFTER_URL})")
elif [ -n "$AFTER_SIZE" ]; then
  VIDEO_LINKS+=("*after.mp4 (${AFTER_SIZE}) — local only*")
fi

if [ ${#VIDEO_LINKS[@]} -gt 0 ]; then
  printf '%s' "${VIDEO_LINKS[0]}" >> "$COMMENT_FILE"
  for ((i=1; i<${#VIDEO_LINKS[@]}; i++)); do
    printf ' | %s' "${VIDEO_LINKS[$i]}" >> "$COMMENT_FILE"
  done
  echo "" >> "$COMMENT_FILE"
else
  echo "*No video evidence recorded.*" >> "$COMMENT_FILE"
fi

# ── Post or dry-run ───────────────────────────────────────────────
echo "Comment file: ${COMMENT_FILE}"
echo "---"
head -20 "$COMMENT_FILE"
echo "..."
echo "---"

if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN — comment NOT posted. Review at: ${COMMENT_FILE}"
  exit 0
fi

echo "Posting comment to ${GH_REPO}#${PR_NUMBER}..."
unset GH_TOKEN
gh pr comment "$PR_NUMBER" --repo "$GH_REPO" --body-file "$COMMENT_FILE"
echo "Comment posted successfully."

# ── Save posted comment to orchestrator task folder ───────────────
if [ -n "$ORCH_TASK_DIR" ] && [ -d "$ORCH_TASK_DIR" ]; then
  cp "$COMMENT_FILE" "${ORCH_TASK_DIR}/artifacts/comment.md" 2>/dev/null || true
  echo "Comment saved to: ${ORCH_TASK_DIR}/artifacts/comment.md"
else
  echo "WARN: Could not determine orchestrator task folder — comment not archived locally"
fi

# Cleanup temp file
rm -f "$COMMENT_FILE"
