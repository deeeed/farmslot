#!/usr/bin/env bash
# Fail if deprecated ADR-032 goal paths reappear in the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="$ROOT/docs/operations/evidence/adr032"

fail() {
  echo "INVALID-PATHS FAIL: $*" >&2
  exit 1
}

for script in \
  harvest-adr032-goal-evidence.sh \
  harvest-adr032-pr-chain-audit.mjs \
  assert-adr032-pr-chain.mjs; do
  [[ -f "$ROOT/scripts/$script" ]] && fail "deprecated script present: scripts/$script"
done

for pattern in pr82 pr83 pr84 pr85 pr86; do
  if compgen -G "$EVIDENCE/${pattern}-*" >/dev/null; then
    fail "out-of-scope evidence present: $EVIDENCE/${pattern}-*"
  fi
done

[[ -d "$EVIDENCE/replay" ]] && fail "misleading replay dir present: $EVIDENCE/replay"
[[ -f "$EVIDENCE/pr-chain-audit.json" ]] && fail "pr-chain-audit.json present"

OPS_EVIDENCE="$ROOT/docs/operations/evidence"
for pattern in \
  'adr032-phase1-agreement-*.json' \
  'runner-validate-*-busy-composer.json' \
  'runner-validate-*-mode-switch.json' \
  'runner-validate-*-prompt-accepted.json' \
  'runner-validate-*-turn-boundary.json' \
  'runner-validate-*-grok-*.json' \
  'runner-validate-*-cursor-*.json'; do
  if compgen -G "$OPS_EVIDENCE/$pattern" >/dev/null; then
    fail "optional harness evidence present (not committed): $OPS_EVIDENCE/$pattern"
  fi
done

echo "INVALID-PATHS PASS: only canonical ADR-032 goal evidence/scripts on disk"
