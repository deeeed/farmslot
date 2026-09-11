import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import {
  familyPublishGateMaximizeLabel,
  familyPublishGateReopenLabel,
  familyReadyGateDecision,
  shouldRestorePublishGateOnEscape,
} from './family-observability-gate-model.js';

function readyDecision(overrides: Partial<RunDecision> = {}): RunDecision {
  return {
    id: 'ready-1',
    type: 'engine_human_gate',
    title: 'Publish gate',
    description: 'Ready',
    actions: [],
    createdAt: '2026-09-08T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: { files: 0, additions: 0, deletions: 0 },
      workerReport: '',
      branch: 'main',
    },
    ...overrides,
  };
}

test('familyReadyGateDecision prefers a pending ready decision over resolved ones', () => {
  const oldResolved = readyDecision({
    id: 'old',
    resolvedAt: '2026-09-08T00:01:00.000Z',
    resolvedAction: 'hold',
  });
  const pending = readyDecision({ id: 'pending' });
  const newestResolved = readyDecision({
    id: 'new',
    resolvedAt: '2026-09-08T00:02:00.000Z',
    resolvedAction: 'approve-publish',
  });
  assert.equal(
    familyReadyGateDecision({ decisions: [oldResolved, pending, newestResolved] }),
    pending,
  );
  assert.equal(
    familyReadyGateDecision({ decisions: [oldResolved, newestResolved] }),
    newestResolved,
  );
  assert.equal(familyReadyGateDecision({ decisions: [] }), null);
  assert.equal(familyReadyGateDecision(null), null);
});

test('familyPublishGateReopenLabel distinguishes pending, resolved, and open', () => {
  const pending = readyDecision();
  const resolved = readyDecision({
    resolvedAt: '2026-09-08T00:02:00.000Z',
    resolvedAction: 'approve-publish',
  });
  assert.equal(
    familyPublishGateReopenLabel({ decision: pending, gateOpen: false }),
    'Open publish gate',
  );
  assert.equal(
    familyPublishGateReopenLabel({ decision: resolved, gateOpen: false }),
    'Reopen publish gate',
  );
  assert.equal(
    familyPublishGateReopenLabel({ decision: resolved, gateOpen: true }),
    'Close publish gate',
  );
});

test('familyPublishGateMaximizeLabel toggles maximize and restore', () => {
  assert.equal(familyPublishGateMaximizeLabel(false), 'Maximize');
  assert.equal(familyPublishGateMaximizeLabel(true), 'Restore');
});

test('shouldRestorePublishGateOnEscape yields to family diff and workspace overlays', () => {
  assert.equal(
    shouldRestorePublishGateOnEscape({
      familyDiffOpen: false,
      gateMaximized: true,
      workspaceOverlayOpen: false,
    }),
    true,
  );
  assert.equal(
    shouldRestorePublishGateOnEscape({
      familyDiffOpen: true,
      gateMaximized: true,
      workspaceOverlayOpen: false,
    }),
    false,
  );
  assert.equal(
    shouldRestorePublishGateOnEscape({
      familyDiffOpen: false,
      gateMaximized: true,
      workspaceOverlayOpen: true,
    }),
    false,
  );
});
