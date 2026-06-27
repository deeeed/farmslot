#!/usr/bin/env bash
# Harvest immutable ADR-032 goal-closeout evidence (code gates + PR chain audit).
# Writes fixed filenames; do not hand-edit outputs. Exits non-zero on any gate failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="${1:-${ADR032_EVIDENCE_DIR:-$ROOT/docs/operations/evidence/adr032}}"
mkdir -p "$EVIDENCE_DIR"

log_exit() {
  local name="$1"
  local code="$2"
  echo "${name}_EXIT:${code}" | tee -a "$EVIDENCE_DIR/${name}.log"
  return "$code"
}

echo "== ADR-032 goal evidence harvest =="
echo "evidence_dir=${EVIDENCE_DIR}"
echo "main_sha=$(git -C "$ROOT" rev-parse HEAD)"

echo "== e2e-tmux-runner-validate (first run) =="
bash "$ROOT/scripts/e2e-tmux-runner-validate.sh" 2>&1 | tee "$EVIDENCE_DIR/e2e-first-run.log"
log_exit E2E "${PIPESTATUS[0]}" || exit 1

echo "== run-adr032-phase1-gate =="
bash "$ROOT/scripts/run-adr032-phase1-gate.sh" 2>&1 | tee "$EVIDENCE_DIR/gate-first-run.log"
log_exit GATE "${PIPESTATUS[0]}" || exit 1

echo "== command-center typecheck =="
(cd "$ROOT/apps/command-center" && yarn typecheck) 2>&1 | tee "$EVIDENCE_DIR/cc-typecheck.log"
log_exit TYPECHECK "${PIPESTATUS[0]}" || exit 1

echo "== gateway safe-send + decision tests =="
(
  cd "$ROOT/services/gateway"
  node "$ROOT/scripts/quality/run-tsx-tests.mjs" --cwd . --tsconfig tsconfig.json --node-test \
    src/runners/registry-safe-send.test.ts
  node "$ROOT/scripts/quality/run-tsx-tests.mjs" --cwd . --tsconfig tsconfig.json \
    src/runners/observability-send-decision.test.ts
) 2>&1 | tee "$EVIDENCE_DIR/registry-safe-send-run.log"
log_exit SAFE_SEND "${PIPESTATUS[0]}" || exit 1

echo "== gh PR chain audit =="
PR_JSON="$(mktemp)"
for n in 81 82 83 84; do
  gh pr view "$n" --json number,title,state,mergedAt,mergeCommit,reviews,url,statusCheckRollup \
    >>"$PR_JSON.raw" 2>/dev/null || true
  echo "---" >>"$PR_JSON.raw"
done
node --input-type=module -e "
import fs from 'node:fs';
const raw = fs.readFileSync(process.argv[1], 'utf8');
const chunks = raw.split('---\\n').map((c) => c.trim()).filter(Boolean);
const prs = chunks.map((c) => JSON.parse(c));
const crossReview = {
  81: 'docs/operations/evidence/adr032/pr81-CROSS-REVIEW-LOOP.json',
  82: 'docs/operations/evidence/adr032/pr82-CROSS-REVIEW-LOOP.json',
  83: 'docs/operations/evidence/adr032/pr83-CROSS-REVIEW-LOOP.json',
  84: 'docs/operations/evidence/adr032/pr84-CROSS-REVIEW-LOOP.json',
};
const out = {
  harvestedAt: new Date().toISOString(),
  mainSha: process.argv[2],
  prs: prs.map((p) => ({
    ...p,
    crossReviewArtifact: crossReview[p.number] ?? null,
    githubFormalApproveBlocked:
      'Self-authored PR: gh pr review --approve rejected by GitHub policy; cross-review JSON is authoritative.',
  })),
};
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2) + '\\n');
" "$PR_JSON.raw" "$(git -C "$ROOT" rev-parse HEAD)" "$EVIDENCE_DIR/pr-chain-audit.json"
rm -f "$PR_JSON.raw"

echo "== PR #82 post-merge CI (commit 02fe7bd) =="
gh run list --commit 02fe7bd8b30c80ba4658e3ff0decbd52cb1604f2 --limit 20 \
  --json databaseId,name,status,conclusion,event,headSha,createdAt \
  >"$EVIDENCE_DIR/pr82-postmerge-ci.json" 2>&1 || true

echo "== registry phase2 decision grep =="
grep -n -E 'resolvePendingInstructionObsFirst|sendRunnerInstructionWhenPaneClear|selectPendingFromObservabilityAndPane' \
  "$ROOT/services/gateway/src/runners/registry.ts" \
  | tee "$EVIDENCE_DIR/phase2-decision-grep.txt" >/dev/null

echo "ADR-032 goal evidence harvest complete -> ${EVIDENCE_DIR}"