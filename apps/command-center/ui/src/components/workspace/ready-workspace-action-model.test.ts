import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload, RunDecision } from '@farmslot/protocol';

import {
  applyReadyPackageRefreshResult,
  isReadyPublicationApproval,
  readyActionRequiresConfirmation,
  readyDecisionActionStateKey,
  readyDecisionSubmittingMessage,
  readyDecisionSuccessMessage,
  readyRefreshPublishPackageFeedback,
  readyResolveSelectionData,
  refreshedReadyDecision,
  refreshedReadyEvidenceSelection,
} from './ready-workspace-action-model.js';

function payload(overrides: Record<string, unknown>): ReadyGatePayload {
  return overrides as unknown as ReadyGatePayload;
}

test('ready workspace action model derives decision state keys and messages', () => {
  assert.equal(
    readyDecisionActionStateKey({
      id: 'd1',
      resolvedAt: 'now',
      resolvedAction: 'ready',
    } as RunDecision),
    'd1:now:ready',
  );
  assert.equal(isReadyPublicationApproval('approve-publish', false), true);
  assert.equal(isReadyPublicationApproval('ready', true), true);
  assert.equal(isReadyPublicationApproval('ready', false), false);
  assert.equal(readyActionRequiresConfirmation('approve-publish', true), true);
  assert.equal(readyActionRequiresConfirmation('ready', true), true);
  assert.equal(readyActionRequiresConfirmation('request-extra-review', true), false);
  assert.equal(readyDecisionSubmittingMessage(true), 'Submitting publication decision…');
  assert.equal(
    readyDecisionSuccessMessage(false),
    'Decision submitted — waiting for the pipeline to continue…',
  );
});

test('ready workspace action model builds package and non-package selection data', () => {
  const packagePayload = payload({
    prPackage: { id: 'pkg-1', packageHash: 'abcdef', headSha: '123456' },
  });
  assert.deepEqual(
    readyResolveSelectionData({
      payload: packagePayload,
      publicationTarget: 'draft',
      selectedEvidenceKeys: ['after.png'],
      extraSelectionData: { reviewRequest: { extraLoopsRequested: 1 } },
    }),
    {
      publicationTarget: 'draft',
      selectedEvidenceKeys: ['after.png'],
      packageId: 'pkg-1',
      packageHash: 'abcdef',
      packageHeadSha: '123456',
      reviewRequest: { extraLoopsRequested: 1 },
    },
  );
  assert.equal(
    readyResolveSelectionData({
      payload: payload({}),
      publicationTarget: 'ready',
      selectedEvidenceKeys: [],
    }),
    undefined,
  );
  assert.deepEqual(
    readyResolveSelectionData({
      payload: payload({}),
      publicationTarget: 'ready',
      selectedEvidenceKeys: [],
      extraSelectionData: { reason: 'needs-review' },
    }),
    { reason: 'needs-review' },
  );
});

test('ready workspace action model summarizes refreshed package results', () => {
  const result = {
    packageHash: 'abcdef1234567890',
    preservedEvidenceKeys: ['after.png'],
    addedEvidenceKeys: ['new.png'],
    droppedEvidenceKeys: ['old.mp4'],
    droppedEvidence: [{ key: 'old.mp4', reason: 'missing' }],
  };
  assert.deepEqual(refreshedReadyEvidenceSelection(result), ['after.png', 'new.png']);
  assert.deepEqual(readyRefreshPublishPackageFeedback(result), {
    message:
      'Package refreshed · abcdef123456 · 1 selection dropped: missing · 1 new evidence item',
    tone: 'error',
  });
  assert.deepEqual(readyRefreshPublishPackageFeedback({ addedEvidenceKeys: ['new.png'] }), {
    message: 'Package refreshed · 1 new evidence item',
    tone: 'success',
  });
});

test('ready workspace adopts the refreshed decision before publication approval', () => {
  const priorDecision = {
    id: 'decision-1',
    payload: payload({ prPackage: { id: 'pkg-old', packageHash: 'hash-old' } }),
  } as RunDecision;
  const refreshedDecision = {
    ...priorDecision,
    payload: payload({ prPackage: { id: 'pkg-new', packageHash: 'hash-new' } }),
  };

  const refreshedRun = { decisions: [refreshedDecision] };
  let activeRun = { decisions: [priorDecision] };
  let activeDecision = priorDecision;
  let selectedEvidenceKeys = ['old.png'];
  let confirmationCleared = false;
  applyReadyPackageRefreshResult(
    {
      run: refreshedRun as never,
      packageId: 'pkg-new',
      packageHash: 'hash-new',
      preservedEvidenceKeys: ['new.png'],
      droppedEvidence: [],
      droppedEvidenceKeys: [],
      addedEvidenceKeys: [],
    },
    priorDecision.id,
    {
      setRun: (run) => {
        activeRun = run;
      },
      setDecision: (decision) => {
        activeDecision = decision;
      },
      clearConfirmation: () => {
        confirmationCleared = true;
      },
      setSelectedEvidenceKeys: (keys) => {
        selectedEvidenceKeys = keys;
      },
    },
  );

  assert.equal(activeRun, refreshedRun);
  assert.equal(activeDecision, refreshedDecision);
  assert.equal(confirmationCleared, true);
  assert.deepEqual(selectedEvidenceKeys, ['new.png']);
  assert.equal(
    readyResolveSelectionData({
      payload: activeDecision.payload as ReadyGatePayload,
      publicationTarget: 'ready',
      selectedEvidenceKeys,
    })?.packageId,
    'pkg-new',
  );
  assert.equal(refreshedReadyDecision({ decisions: [] }, priorDecision.id), null);
});
