#!/usr/bin/env bash
# Deterministic ADR-032 goal evidence assertions. Fails fast with one error per criterion.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="${1:-${ADR032_EVIDENCE_DIR:-$ROOT/docs/operations/evidence/adr032}}"

fail() {
  echo "ASSERT FAIL: $*" >&2
  exit 1
}

require_file() {
  local f="$1"
  [[ -f "$f" ]] || fail "missing file: $f"
}

require_grep() {
  local pattern="$1"
  local file="$2"
  local label="$3"
  grep -qE "$pattern" "$file" || fail "${label}: pattern '${pattern}' not found in ${file}"
}

echo "== assert ADR-032 goal evidence (${EVIDENCE_DIR}) =="

require_file "$EVIDENCE_DIR/e2e-first-run.log"
require_grep 'E2E_EXIT:0' "$EVIDENCE_DIR/e2e-first-run.log" 'e2e-first-run'

require_file "$EVIDENCE_DIR/gate-first-run.log"
require_grep 'GATE_EXIT:0' "$EVIDENCE_DIR/gate-first-run.log" 'gate-first-run'

require_file "$EVIDENCE_DIR/cc-typecheck.log"
require_grep 'TYPECHECK_EXIT:0' "$EVIDENCE_DIR/cc-typecheck.log" 'cc-typecheck'

require_file "$EVIDENCE_DIR/registry-safe-send-run.log"
require_grep 'SAFE_SEND_EXIT:0' "$EVIDENCE_DIR/registry-safe-send-run.log" 'safe-send tests'
require_grep '# fail 0' "$EVIDENCE_DIR/registry-safe-send-run.log" 'runner obs tests no failures'
if grep -q '# pass 15' "$EVIDENCE_DIR/registry-safe-send-run.log"; then
  require_grep '# pass 15' "$EVIDENCE_DIR/registry-safe-send-run.log" 'combined registry obs tests 15/15'
else
  require_grep '# pass 4' "$EVIDENCE_DIR/registry-safe-send-run.log" 'registry-safe-send 4/4'
  require_grep '# pass 11' "$EVIDENCE_DIR/registry-safe-send-run.log" 'observability-decision 11/11'
fi

require_file "$EVIDENCE_DIR/pr-chain-audit.json"
node --input-type=module -e "
import fs from 'node:fs';
const p = process.argv[1];
const audit = JSON.parse(fs.readFileSync(p, 'utf8'));
const expected = [81, 82, 83, 84, 85, 86];
if (!Array.isArray(audit.prs) || audit.prs.length !== expected.length) {
  console.error('pr-chain-audit: expected', expected.length, 'PR entries');
  process.exit(1);
}
for (const pr of audit.prs) {
  if (pr.state !== 'MERGED') {
    console.error('pr-chain-audit: PR', pr.number, 'state', pr.state, '!= MERGED');
    process.exit(1);
  }
  if (!pr.crossReviewArtifact && pr.number <= 84) {
    console.error('pr-chain-audit: PR', pr.number, 'missing crossReviewArtifact');
    process.exit(1);
  }
  const author = pr.author?.login ?? null;
  const approved = (pr.reviews ?? []).some(
    (r) => r.state === 'APPROVED' && r.author?.login && r.author.login !== author,
  );
  if (!approved) {
    console.error('pr-chain-audit: PR', pr.number, 'missing independent APPROVED review');
    process.exit(1);
  }
}
console.log('ok pr-chain-audit:', expected.length, 'MERGED PRs with independent APPROVED reviews');
" "$EVIDENCE_DIR/pr-chain-audit.json" || fail 'pr-chain-audit.json validation'

for n in 81 82 83 84; do
  require_file "$EVIDENCE_DIR/pr${n}-CROSS-REVIEW-LOOP.json"
done
node "$ROOT/scripts/validate-cross-review-loop-json.mjs" \
  "$EVIDENCE_DIR/pr81-CROSS-REVIEW-LOOP.json" \
  "$EVIDENCE_DIR/pr82-CROSS-REVIEW-LOOP.json" \
  "$EVIDENCE_DIR/pr83-CROSS-REVIEW-LOOP.json" \
  "$EVIDENCE_DIR/pr84-CROSS-REVIEW-LOOP.json" \
  || fail 'cross-review JSON schema validation'

for n in 81 82 83 84; do
  node --input-type=module -e "
import fs from 'node:fs';
const doc = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (doc.finalVerdict !== 'clean' || doc.status !== 'clean' || doc.blockingFindingsOpen !== 0) {
  console.error(process.argv[1], 'finalVerdict/status/blockingFindingsOpen not clean');
  process.exit(1);
}
" "$EVIDENCE_DIR/pr${n}-CROSS-REVIEW-LOOP.json" || fail "pr${n} cross-review not clean"
done

require_file "$EVIDENCE_DIR/phase2-decision-grep.txt"
require_grep 'resolvePendingInstructionObsFirst' "$ROOT/services/gateway/src/runners/registry.ts" 'registry.ts'
require_grep 'sendRunnerInstructionWhenPaneClear' "$ROOT/services/gateway/src/runners/registry.ts" 'registry.ts'
require_grep 'selectPendingFromObservabilityAndPane' "$EVIDENCE_DIR/phase2-decision-grep.txt" 'phase2-decision-grep'
require_grep 'selectIdleFromObservabilityAndPane' "$EVIDENCE_DIR/phase2-decision-grep.txt" 'phase2-decision-grep idle'

require_file "$EVIDENCE_DIR/pr82-postmerge-ci.json"
require_file "$EVIDENCE_DIR/pr82-merge-timing-note.json"
node --input-type=module -e "
import fs from 'node:fs';
const runs = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (!Array.isArray(runs) || runs.length === 0) process.exit(1);
const quality = runs.find((r) => r.name === 'Farmslot Quality' || String(r.name).includes('Quality'));
if (!quality || String(quality.conclusion).toLowerCase() !== 'success') process.exit(1);
" "$EVIDENCE_DIR/pr82-postmerge-ci.json" || fail 'pr82-postmerge-ci.json missing SUCCESS quality run'

echo "ASSERT PASS: all ADR-032 goal evidence criteria satisfied"