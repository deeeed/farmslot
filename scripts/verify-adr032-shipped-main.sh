#!/usr/bin/env bash
# ADR-032 shipped-code verifier (plan criteria 1, 4, 5). No gh pr calls.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-${ADR032_SHIPPED_EVIDENCE_DIR:-${SCRATCH:-/tmp}/adr032-shipped}}"
mkdir -p "$OUT_DIR"

fail() {
  echo "SHIPPED-MAIN FAIL: $*" >&2
  exit 1
}

append_exit() {
  local marker="$1"
  local file="$2"
  local code="$3"
  echo "${marker}_EXIT:${code}" >>"$file"
  return "$code"
}

echo "== verify ADR-032 shipped main (evidence -> ${OUT_DIR}) =="
echo "main_sha=$(git -C "$ROOT" rev-parse HEAD)"

echo "== e2e-tmux-runner-validate =="
bash "$ROOT/scripts/e2e-tmux-runner-validate.sh" 2>&1 | tee "$OUT_DIR/e2e-tmux-runner-validate.log"
append_exit E2E "$OUT_DIR/e2e-tmux-runner-validate.log" "${PIPESTATUS[0]}" || fail 'e2e-tmux-runner-validate'

echo "== run-adr032-phase1-gate =="
ADR032_SKIP_E2E=1 bash "$ROOT/scripts/run-adr032-phase1-gate.sh" 2>&1 | tee "$OUT_DIR/run-adr032-phase1-gate.log"
append_exit GATE "$OUT_DIR/run-adr032-phase1-gate.log" "${PIPESTATUS[0]}" || fail 'run-adr032-phase1-gate'

echo "== command-center typecheck =="
(cd "$ROOT/apps/command-center" && yarn typecheck) 2>&1 | tee "$OUT_DIR/cc-typecheck.log"
append_exit TYPECHECK "$OUT_DIR/cc-typecheck.log" "${PIPESTATUS[0]}" || fail 'typecheck'

echo "== gateway obs unit tests =="
(
  cd "$ROOT/services/gateway"
  node "$ROOT/scripts/quality/run-tsx-tests.mjs" --cwd . --tsconfig tsconfig.json --node-test \
    src/runners/registry-safe-send.test.ts \
    src/runners/observability-send-decision.test.ts
) 2>&1 | tee "$OUT_DIR/registry-obs-tests.log"
append_exit OBS_TESTS "$OUT_DIR/registry-obs-tests.log" "${PIPESTATUS[0]}" || fail 'registry obs tests'
grep -q '# fail 0' "$OUT_DIR/registry-obs-tests.log" || fail 'obs tests reported failures'

echo "== phase2 decision grep =="
grep -n -E \
  'getRunnerObservability|resolvePendingInstructionObsFirst|selectIdleFromObservabilityAndPane|runnerShowsPromptDeliveryAccepted|resolveSafeSendTimeoutMs' \
  "$ROOT/services/gateway/src/runners/registry.ts" \
  | tee "$OUT_DIR/phase2-decision-grep.txt" >/dev/null
grep -q 'resolvePendingInstructionObsFirst' "$OUT_DIR/phase2-decision-grep.txt" || fail 'missing obs-first safe-send'
grep -q 'selectIdleFromObservabilityAndPane' "$OUT_DIR/phase2-decision-grep.txt" || fail 'missing post-launch obs-first'

echo "== macwork evidence JSON pass flags =="
node --input-type=module -e "
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[1];

function assertProbeGate(rel) {
  const doc = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const gate = doc.gate ?? {};
  if (gate.runnerTagPass !== true || gate.latencyMedianPass !== true) {
    console.error(rel, 'gate pass flags missing', gate);
    process.exit(1);
  }
}

function assertPassTrue(rel) {
  const doc = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  if (doc.pass !== true) {
    console.error(rel, 'pass !== true');
    process.exit(1);
  }
}

const probes = [
  'docs/operations/evidence/adr032-phase1-probe-macwork-claude.json',
  'docs/operations/evidence/adr032-phase1-probe-macwork-codex.json',
];
const hookSmokes = [
  'docs/operations/evidence/runner-validate-macwork-claude-hook-smoke.json',
  'docs/operations/evidence/runner-validate-macwork-codex-hook-smoke.json',
];

for (const rel of [...probes, ...hookSmokes]) {
  if (!fs.existsSync(path.join(root, rel))) {
    console.error('missing', rel);
    process.exit(1);
  }
}
for (const rel of probes) assertProbeGate(rel);
for (const rel of hookSmokes) assertPassTrue(rel);
console.log('ok evidence JSON for', probes.length, 'probes +', hookSmokes.length, 'hook-smoke artifacts');
" "$ROOT" || fail 'evidence JSON pass flags'

echo "SHIPPED-MAIN PASS: ADR-032 code gates satisfied on $(git -C "$ROOT" rev-parse --short HEAD)"