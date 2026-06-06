import assert from 'node:assert/strict';
import test from 'node:test';

import type { FamilyObservabilityArtifact } from '@farmslot/protocol';

import { familyDiffModalState } from './family-observability-diff-modal.js';

function artifact(overrides: Partial<FamilyObservabilityArtifact>): FamilyObservabilityArtifact {
  return {
    runId: 'run-1',
    familyId: 'family-1',
    path: 'artifacts/diff.txt',
    purpose: 'diff',
    source: 'task-artifact',
    ...overrides,
  };
}

test('familyDiffModalState labels reviewed input snapshots without duplicated prefixes', () => {
  assert.equal(
    familyDiffModalState(
      'reviewed PR input +8 -3',
      artifact({ path: 'inputs/diff.txt', source: 'task-input' }),
    ).title,
    'Reviewed PR input snapshot · +8 -3 · diff.txt',
  );
});

test('familyDiffModalState labels produced code deltas without duplicated prefixes', () => {
  assert.equal(
    familyDiffModalState(
      'Produced code delta +12 -1',
      artifact({ path: 'artifacts/diff.txt', source: 'task-artifact' }),
    ).title,
    'Produced code delta · +12 -1 · diff.txt',
  );
});

test('familyDiffModalState falls back to generic diff artifact titles', () => {
  assert.equal(
    familyDiffModalState(
      'custom review diff',
      artifact({ path: 'logs/custom.diff', source: 'step-output' }),
    ).title,
    'Diff artifact · custom review diff · custom.diff',
  );
});
