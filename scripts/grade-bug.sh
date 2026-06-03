#!/bin/bash
# grade-bug.sh — LLM grading of bug difficulty with schema validation.
#
# Reads bug_input + heuristic from a score file, calls claude CLI for
# structured assessment, validates output, computes deterministic final
# scoring, and writes llm + final sections back to the score file.
#
# Usage:
#   bash scripts/grade-bug.sh --score-file <path> [--model <model>]
#
# Requires: claude CLI, python3

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECTS_DIR="${PROJECTS_DIR:-${SCRIPT_DIR}/../projects}"

# ── Parse args ────────────────────────────────────────────────────
SCORE_FILE=""
MODEL="sonnet"
PROJECT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --score-file) SCORE_FILE="$2"; shift 2;;
    --model)      MODEL="$2"; shift 2;;
    --project)    PROJECT="$2"; shift 2;;
    -h|--help)
      echo "Usage: bash scripts/grade-bug.sh --score-file <path> [--model <model>] [--project <name>]"
      echo ""
      echo "LLM difficulty grading. Adds 'llm' + 'final' sections to score file."
      echo "Requires 'bug_input' and 'heuristic' sections to exist."
      echo "Loads prompt template from project.json scoring.grade_prompt."
      echo "Skips silently if no grade_prompt configured."
      exit 0;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 1;;
  esac
done

[ -z "$SCORE_FILE" ] && { echo "ERROR: --score-file required" >&2; exit 1; }
[ -f "$SCORE_FILE" ] || { echo "ERROR: score file not found: $SCORE_FILE" >&2; exit 1; }

# ── Auto-detect project from score file path ─────────────────────
if [ -z "$PROJECT" ]; then
  PROJECT=$(echo "$SCORE_FILE" | sed -n 's|.*projects/\([^/]*\)/.*|\1|p')
fi
[ -z "$PROJECT" ] && { echo "ERROR: --project required (could not auto-detect from path)" >&2; exit 1; }

PROJECT_CONFIG="${PROJECTS_DIR}/${PROJECT}/project.json"
[ -f "$PROJECT_CONFIG" ] || { echo "ERROR: project config not found: $PROJECT_CONFIG" >&2; exit 1; }
PROJECT_DIR="${PROJECTS_DIR}/${PROJECT}"

# ── Load prompt template from project config ─────────────────────
GRADE_PROMPT_REL=$(python3 -c "
import json
d = json.load(open('${PROJECT_CONFIG}'))
print(d.get('scoring', {}).get('grade_prompt', ''))
")

if [ -z "$GRADE_PROMPT_REL" ]; then
  echo "INFO: No scoring.grade_prompt configured in ${PROJECT_CONFIG} — skipping LLM grading." >&2
  exit 0
fi

GRADE_PROMPT_FILE="${PROJECT_DIR}/${GRADE_PROMPT_REL}"
if [ ! -f "$GRADE_PROMPT_FILE" ]; then
  echo "ERROR: grade prompt file not found: $GRADE_PROMPT_FILE" >&2
  exit 1
fi

# ── Idempotency check ────────────────────────────────────────────
HAS_LLM=$(python3 -c "
import json
d = json.load(open('${SCORE_FILE}'))
print('yes' if 'llm' in d and 'final' in d else 'no')
")

if [ "$HAS_LLM" = "yes" ]; then
  echo "LLM grading already complete in ${SCORE_FILE} — skipping." >&2
  echo "Delete the 'llm' key to force re-run." >&2
  exit 0
fi

# ── Validate prerequisites ───────────────────────────────────────
python3 -c "
import json, sys
d = json.load(open('${SCORE_FILE}'))
if 'bug_input' not in d or not d['bug_input']:
    print('ERROR: score file missing bug_input section', file=sys.stderr)
    sys.exit(1)
" || exit 1

# ── Check if heuristic exists ────────────────────────────────────
HAS_HEURISTIC=$(python3 -c "
import json
d = json.load(open('${SCORE_FILE}'))
print('yes' if 'heuristic' in d and d['heuristic'] else 'no')
")

# ── Extract bug data for prompt ──────────────────────────────────
if [ "$HAS_HEURISTIC" = "yes" ]; then
  read -r TITLE DESCRIPTION LABELS COMPONENTS SCREENSHOT_COUNT \
    H_DIFFICULTY H_SCORE H_CATEGORY H_CAT_CONF H_PROB < <(python3 -c "
import json

d = json.load(open('${SCORE_FILE}'))
bi = d['bug_input']
h = d['heuristic']

# Use tab as separator for safe multi-word fields
sep = '\t'
print(sep.join([
    bi.get('title', ''),
    bi.get('description', '')[:3000],
    ', '.join(bi.get('labels', [])),
    ', '.join(bi.get('components', [])),
    str(len(bi.get('screenshots', []))),
    h.get('difficulty', ''),
    str(h.get('difficulty_score', 0)),
    h.get('category', ''),
    h.get('category_confidence', ''),
    str(h.get('one_shot_probability', 0)),
]))
" 2>/dev/null) || true

  # Fallback: extract fields individually if tab parsing failed
  if [ -z "$TITLE" ]; then
    TITLE=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('title',''))")
    DESCRIPTION=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('description','')[:3000])")
    LABELS=$(python3 -c "import json; print(', '.join(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('labels',[])))")
    COMPONENTS=$(python3 -c "import json; print(', '.join(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('components',[])))")
    SCREENSHOT_COUNT=$(python3 -c "import json; print(len(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('screenshots',[])))")
    H_DIFFICULTY=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('heuristic',{}).get('difficulty',''))")
    H_SCORE=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('heuristic',{}).get('difficulty_score',0))")
    H_CATEGORY=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('heuristic',{}).get('category',''))")
    H_CAT_CONF=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('heuristic',{}).get('category_confidence',''))")
    H_PROB=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('heuristic',{}).get('one_shot_probability',0))")
  fi
else
  # No heuristic — extract bug_input fields only, set H_* to n/a
  TITLE=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('title',''))")
  DESCRIPTION=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('description','')[:3000])")
  LABELS=$(python3 -c "import json; print(', '.join(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('labels',[])))")
  COMPONENTS=$(python3 -c "import json; print(', '.join(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('components',[])))")
  SCREENSHOT_COUNT=$(python3 -c "import json; print(len(json.load(open('${SCORE_FILE}')).get('bug_input',{}).get('screenshots',[])))")
  H_DIFFICULTY="n/a"
  H_SCORE="n/a"
  H_CATEGORY="n/a"
  H_CAT_CONF="n/a"
  H_PROB="n/a"
  echo "INFO: No heuristic in score file — grading from bug_input only." >&2
fi

ISSUE_REF=$(python3 -c "import json; print(json.load(open('${SCORE_FILE}')).get('issue_ref',''))")
echo "Grading ${ISSUE_REF}..." >&2

# ── Build prompt from template ────────────────────────────────────
export TITLE DESCRIPTION LABELS COMPONENTS SCREENSHOT_COUNT
export H_DIFFICULTY H_SCORE H_CATEGORY H_CAT_CONF H_PROB
PROMPT=$(envsubst < "$GRADE_PROMPT_FILE")

# ── Call claude CLI ──────────────────────────────────────────────
LLM_RESPONSE=$(claude -p "$PROMPT" --model "$MODEL" --output-format text 2>/dev/null) || {
  echo "ERROR: claude CLI failed" >&2
  exit 1
}

# ── Parse, validate, compute final, and write ────────────────────
python3 -c "
import json, sys
from datetime import datetime, timezone

response_text = sys.argv[1].strip()

# Strip markdown code fences if present
if response_text.startswith('\`\`\`'):
    response_text = response_text.split('\n', 1)[-1].rsplit('\`\`\`', 1)[0].strip()

try:
    llm = json.loads(response_text)
except json.JSONDecodeError as e:
    print(f'ERROR: could not parse LLM response as JSON: {e}', file=sys.stderr)
    print(f'Response was: {response_text[:200]}', file=sys.stderr)
    sys.exit(1)

# ── Validate llm section against schema rules ────────────────────
valid_difficulties = ['low', 'medium', 'high', 'extreme']
valid_complexities = ['single-file change', 'multi-file change', 'architectural change', 'unknown']

errors = []

if llm.get('difficulty') not in valid_difficulties:
    errors.append(f\"difficulty must be one of {valid_difficulties}, got: {llm.get('difficulty')}\")

conf = llm.get('confidence')
if not isinstance(conf, (int, float)) or not (0 <= conf <= 1):
    errors.append(f'confidence must be 0-1, got: {conf}')

prob = llm.get('one_shot_probability')
if not isinstance(prob, (int, float)) or not (0 <= prob <= 1):
    errors.append(f'one_shot_probability must be 0-1, got: {prob}')

if not isinstance(llm.get('reasoning', ''), str) or not llm.get('reasoning'):
    errors.append('reasoning is required and must be a non-empty string')

if llm.get('estimated_complexity') not in valid_complexities:
    errors.append(f\"estimated_complexity must be one of {valid_complexities}, got: {llm.get('estimated_complexity')}\")

if errors:
    print('ERROR: LLM response validation failed:', file=sys.stderr)
    for e in errors:
        print(f'  - {e}', file=sys.stderr)
    sys.exit(1)

# Normalize optional fields
llm.setdefault('risk_factors', [])
llm.setdefault('similar_past_bugs', [])

# Keep only schema-defined fields
llm_clean = {
    'difficulty': llm['difficulty'],
    'confidence': llm['confidence'],
    'one_shot_probability': llm['one_shot_probability'],
    'reasoning': llm['reasoning'],
    'similar_past_bugs': llm.get('similar_past_bugs', []),
    'risk_factors': llm.get('risk_factors', []),
    'estimated_complexity': llm['estimated_complexity'],
}

# ── Compute final scoring (deterministic) ────────────────────────
score = json.load(open('${SCORE_FILE}'))
h = score.get('heuristic')

difficulty_rank = {'low': 0, 'medium': 1, 'high': 2, 'extreme': 3}
l_rank = difficulty_rank[llm_clean['difficulty']]

if h:
    h_rank = difficulty_rank[h['difficulty']]
    if h_rank == l_rank:
        final_difficulty = h['difficulty']
        source = 'agreement'
    else:
        # Conservative: use the harder estimate
        final_difficulty = h['difficulty'] if h_rank > l_rank else llm_clean['difficulty']
        source = 'conservative'
    final_prob = round((h['one_shot_probability'] + llm_clean['one_shot_probability']) / 2, 2)
else:
    # LLM-only: no heuristic to merge with
    final_difficulty = llm_clean['difficulty']
    final_prob = llm_clean['one_shot_probability']
    source = 'llm-only'

# Model recommendation from final difficulty
model_map = {'low': 'sonnet', 'medium': 'sonnet', 'high': 'sonnet', 'extreme': 'opus'}
recommended_model = model_map[final_difficulty]

final = {
    'difficulty': final_difficulty,
    'one_shot_probability': final_prob,
    'recommended_model': recommended_model,
    'source': source,
}

# ── Validate final section ───────────────────────────────────────
valid_sources = ['agreement', 'conservative', 'heuristic-only', 'llm-only', 'none']
f_errors = []

if final['difficulty'] not in valid_difficulties:
    f_errors.append(f\"final difficulty invalid: {final['difficulty']}\")
if not (0 <= final['one_shot_probability'] <= 1):
    f_errors.append(f\"final one_shot_probability out of range: {final['one_shot_probability']}\")
if final['source'] not in valid_sources:
    f_errors.append(f\"final source must be one of {valid_sources}, got: {final['source']}\")

if f_errors:
    print('ERROR: final scoring validation failed:', file=sys.stderr)
    for e in f_errors:
        print(f'  - {e}', file=sys.stderr)
    sys.exit(1)

# ── Write to score file ──────────────────────────────────────────
score['llm'] = llm_clean
score['final'] = final
score['scored_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump(score, open('${SCORE_FILE}', 'w'), indent=2)

# Report
print(f'  LLM: {llm_clean[\"difficulty\"]}@{llm_clean[\"confidence\"]} confidence, p={llm_clean[\"one_shot_probability\"]}', file=sys.stderr)
print(f'  Final: {final[\"difficulty\"]} ({source}), p={final[\"one_shot_probability\"]}, model={recommended_model}', file=sys.stderr)
" "$LLM_RESPONSE"
