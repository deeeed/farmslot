import assert from 'node:assert/strict';
import test from 'node:test';

import type { EvidenceReviewOccurrence } from '@farmslot/adapter-sdk/evidence';

import {
  formatProofStepExpectation,
  OTHER_PROOF_STEPS,
  proofStepGroups,
} from './proof-step-groups.js';

function step(traceIndex: number, proves: string[], ok = true): EvidenceReviewOccurrence {
  return {
    traceIndex,
    nodeId: `n${traceIndex}`,
    action: 'assert',
    intent: '',
    ok,
    proves,
    artifacts: [],
  };
}

test('proofStepGroups gathers each criterion in id order and leaves unproving steps last', () => {
  const groups = proofStepGroups([
    step(0, []),
    step(1, ['AC-10']),
    step(2, ['AC-2', 'AC-10'], false),
    step(3, []),
    step(4, ['AC-2']),
  ]);
  assert.deepEqual(
    groups.map(({ label, steps, failed }) => [label, steps.map((s) => s.traceIndex), failed]),
    [
      ['AC-2', [2, 4], 1],
      ['AC-10', [1, 2], 1],
      [OTHER_PROOF_STEPS, [0, 3], 0],
    ],
  );
});

test('formatProofStepExpectation writes one key: value line per field, JSON for non-strings', () => {
  assert.equal(
    formatProofStepExpectation({ contains: 'PROOF trade present', expected: { rows: 20 } }),
    'contains: PROOF trade present\nexpected: {"rows":20}',
  );
});
