#!/usr/bin/env bash
# DEPRECATED for goal closeout — use scripts/assert-adr032-goal-evidence.sh instead.
# This harvester + pr-chain-audit path is retained for historical reference only.
# Harvest immutable ADR-032 goal-closeout evidence (code gates + PR chain audit).
# Writes fixed filenames; do not hand-edit outputs. Exits non-zero on any gate failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="${1:-${ADR032_EVIDENCE_DIR:-$ROOT/docs/operations/evidence/adr032}}"
mkdir -p "$EVIDENCE_DIR"

append_exit_marker() {
  local marker="$1"
  local log_file="$2"
  local code="$3"
  echo "${marker}_EXIT:${code}" >>"$log_file"
  return "$code"
}

echo "== ADR-032 goal evidence harvest =="
echo "evidence_dir=${EVIDENCE_DIR}"
echo "main_sha=$(git -C "$ROOT" rev-parse HEAD)"

echo "== e2e-tmux-runner-validate (first run) =="
bash "$ROOT/scripts/e2e-tmux-runner-validate.sh" 2>&1 | tee "$EVIDENCE_DIR/e2e-first-run.log"
append_exit_marker E2E "$EVIDENCE_DIR/e2e-first-run.log" "${PIPESTATUS[0]}" || exit 1

echo "== run-adr032-phase1-gate =="
bash "$ROOT/scripts/run-adr032-phase1-gate.sh" 2>&1 | tee "$EVIDENCE_DIR/gate-first-run.log"
append_exit_marker GATE "$EVIDENCE_DIR/gate-first-run.log" "${PIPESTATUS[0]}" || exit 1

echo "== command-center typecheck =="
(cd "$ROOT/apps/command-center" && yarn typecheck) 2>&1 | tee "$EVIDENCE_DIR/cc-typecheck.log"
append_exit_marker TYPECHECK "$EVIDENCE_DIR/cc-typecheck.log" "${PIPESTATUS[0]}" || exit 1

echo "== gateway safe-send + decision tests =="
(
  cd "$ROOT/services/gateway"
  node "$ROOT/scripts/quality/run-tsx-tests.mjs" --cwd . --tsconfig tsconfig.json --node-test \
    src/runners/registry-safe-send.test.ts
  node "$ROOT/scripts/quality/run-tsx-tests.mjs" --cwd . --tsconfig tsconfig.json \
    src/runners/observability-send-decision.test.ts
) 2>&1 | tee "$EVIDENCE_DIR/registry-safe-send-run.log"
append_exit_marker SAFE_SEND "$EVIDENCE_DIR/registry-safe-send-run.log" "${PIPESTATUS[0]}" || exit 1

echo "== gh PR chain audit =="
PR_JSON="$(mktemp).raw"
trap 'rm -f "$PR_JSON"' EXIT
for n in 81 82 83 84 85 86; do
  gh pr view "$n" --json number,title,state,mergedAt,mergeCommit,reviews,url,statusCheckRollup,author \
    >>"$PR_JSON"
  echo "---" >>"$PR_JSON"
done
node "$ROOT/scripts/harvest-adr032-pr-chain-audit.mjs" \
  "$PR_JSON" \
  "$(git -C "$ROOT" rev-parse HEAD)" \
  "$EVIDENCE_DIR" \
  "$EVIDENCE_DIR/pr-chain-audit.json"

PR82_SHA="$(gh pr view 82 --json mergeCommit -q .mergeCommit.oid)"
echo "== PR #82 post-merge CI (commit ${PR82_SHA}) =="
gh run list --commit "$PR82_SHA" --limit 20 \
  --json databaseId,name,status,conclusion,event,headSha,createdAt \
  >"$EVIDENCE_DIR/pr82-postmerge-ci.json"
node --input-type=module -e "
import fs from 'node:fs';
const runs = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (!Array.isArray(runs) || runs.length === 0) {
  console.error('pr82-postmerge-ci: no workflow runs found');
  process.exit(1);
}
const quality = runs.find((r) => r.name === 'Farmslot Quality' || String(r.name).includes('Quality'));
if (!quality || String(quality.conclusion).toLowerCase() !== 'success') {
  console.error('pr82-postmerge-ci: expected Farmslot Quality SUCCESS');
  process.exit(1);
}
" "$EVIDENCE_DIR/pr82-postmerge-ci.json"

echo "== registry phase2 decision grep =="
grep -n -E 'resolvePendingInstructionObsFirst|sendRunnerInstructionWhenPaneClear|selectPendingFromObservabilityAndPane|selectIdleFromObservabilityAndPane|runnerShowsPromptDeliveryAccepted' \
  "$ROOT/services/gateway/src/runners/registry.ts" \
  | tee "$EVIDENCE_DIR/phase2-decision-grep.txt" >/dev/null

require_merge_notes() {
  for n in 81 82; do
    [[ -f "$EVIDENCE_DIR/pr${n}-merge-timing-note.json" ]] || {
      echo "missing pr${n}-merge-timing-note.json in evidence dir" >&2
      exit 1
    }
  done
}
require_merge_notes

echo "ADR-032 goal evidence harvest complete -> ${EVIDENCE_DIR}"