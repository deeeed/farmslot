#!/usr/bin/env bash
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
PR_JSON="$(mktemp)"
trap 'rm -f "$PR_JSON.raw"' EXIT
for n in 81 82 83 84 85 86; do
  gh pr view "$n" --json number,title,state,mergedAt,mergeCommit,reviews,url,statusCheckRollup,author \
    >>"$PR_JSON.raw"
  echo "---" >>"$PR_JSON.raw"
done
EVIDENCE_DIR="$EVIDENCE_DIR" node --input-type=module -e "
import fs from 'node:fs';
import path from 'node:path';
const evidenceDir = process.env.EVIDENCE_DIR ?? '.';
const raw = fs.readFileSync(process.argv[1], 'utf8');
const chunks = raw.split('---\\n').map((c) => c.trim()).filter(Boolean);
if (chunks.length !== 6) {
  console.error('pr-chain-audit: expected 6 gh pr view payloads, got', chunks.length);
  process.exit(1);
}
const prs = chunks.map((c) => JSON.parse(c));
for (const p of prs) {
  const author = p.author?.login ?? null;
  const approved = (p.reviews ?? []).some(
    (r) => r.state === 'APPROVED' && r.author?.login && r.author.login !== author,
  );
  if (!approved) {
    console.error('pr-chain-audit: PR', p.number, 'missing independent APPROVED gh review');
    process.exit(1);
  }
}
const out = {
  harvestedAt: new Date().toISOString(),
  mainSha: process.argv[2],
  prs: prs.map((p) => ({
    ...p,
    crossReviewArtifact:
      p.number <= 84
        ? path.join(evidenceDir, \`pr\${p.number}-CROSS-REVIEW-LOOP.json\`)
        : null,
    independentApproveReview: (p.reviews ?? []).find(
      (r) => r.state === 'APPROVED' && r.author?.login !== p.author?.login,
    )?.author?.login ?? null,
  })),
};
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2) + '\\n');
" "$PR_JSON.raw" "$(git -C "$ROOT" rev-parse HEAD)" "$EVIDENCE_DIR/pr-chain-audit.json"

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

node --input-type=module -e "
import fs from 'node:fs';
const note = {
  pr: 82,
  mergeCommit: process.argv[1],
  disclosure:
    'PR #82 merged while Farmslot Quality jobs were still IN_PROGRESS on the pre-merge head; post-merge CI on the merge commit later reported SUCCESS (see pr82-postmerge-ci.json). This does not retroactively change merge-time state but documents eventual green validation.',
  premergeEvidenceHint: 'archive pr82-premerge.json in operator scratch if historical IN_PROGRESS capture is required',
};
fs.writeFileSync(process.argv[2], JSON.stringify(note, null, 2) + '\\n');
" "$(gh pr view 82 --json mergeCommit -q .mergeCommit.oid)" "$EVIDENCE_DIR/pr82-merge-timing-note.json"

echo "ADR-032 goal evidence harvest complete -> ${EVIDENCE_DIR}"