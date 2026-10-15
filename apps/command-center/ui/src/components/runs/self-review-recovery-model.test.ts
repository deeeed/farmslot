import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { mockSelfReviewRecoveryRun } from '../../dev/mock-data.js';

import { isRecoverableSelfReviewRun } from './blocked-run-recovery-model.js';

const at = '2026-10-15T10:00:00Z';
const run: Run = mockSelfReviewRecoveryRun();

test('review recovery is actionable without a pending decision or failed step flag', () => {
  assert.equal(isRecoverableSelfReviewRun(run), true);
  assert.equal(isRecoverableSelfReviewRun({ ...run, status: 'review-failed' }), true);
});

test('healthy, terminal and read-only runs never offer a self-review restart', () => {
  for (const status of ['reviewing', 'done', 'cancelled', 'monitoring'] as const)
    assert.equal(isRecoverableSelfReviewRun({ ...run, status }), false);
  assert.equal(isRecoverableSelfReviewRun({ ...run, readOnly: true }), false);
  assert.equal(isRecoverableSelfReviewRun({ ...run, engineState: {} }), false);
  assert.equal(isRecoverableSelfReviewRun({ ...run, slotId: null }), false);
  assert.equal(isRecoverableSelfReviewRun({ ...run, taskFile: null }), false);
  assert.equal(isRecoverableSelfReviewRun({ ...run, steps: [] }), false);
  assert.equal(
    isRecoverableSelfReviewRun({ ...run, reviewWorkspaceTarget: { machine: 'host' } }),
    false,
  );
});

test('pending decisions and force-completed execution keep their existing authority', () => {
  assert.equal(
    isRecoverableSelfReviewRun({
      ...run,
      decisions: [
        {
          id: 'pending',
          type: 'engine_human_gate',
          title: 'Pending',
          description: 'Pending',
          actions: [],
          createdAt: at,
        },
      ],
    }),
    false,
  );
  assert.equal(
    isRecoverableSelfReviewRun({
      ...run,
      engineState: { ...run.engineState, operatorForceCompleted: true },
    }),
    false,
  );
});
