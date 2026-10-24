import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  type ReadyGatePayload,
  type RunDecision,
} from '@farmslot/protocol';

import {
  isReadyPublicationApproval,
  readyActionRequiresConfirmation,
  readyDecisionActionStateKey,
  readyDecisionSubmittingMessage,
  readyDecisionSuccessMessage,
  readyRefreshPublishPackageFeedback,
  readyResolveSelectionData,
  refreshedReadyEvidenceSelection,
} from './ready-workspace-action-model.js';

function payload(overrides: Record<string, unknown>): ReadyGatePayload {
  return overrides as unknown as ReadyGatePayload;
}

test('ready workspace action model derives decision state keys and messages', () => {
  assert.equal(isReadyPublicationApproval(APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION, true), true);
  assert.equal(
    readyActionRequiresConfirmation(APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION, true),
    true,
  );
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
  assert.equal(readyActionRequiresConfirmation('request-review', true), false);
  assert.equal(isReadyPublicationApproval(APPROVE_PUBLISH_UNRESOLVED_ACTION, true), true);
  assert.equal(readyActionRequiresConfirmation(APPROVE_PUBLISH_UNRESOLVED_ACTION, true), true);
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
      extraSelectionData: {
        reviewRequest: { runner: 'codex', model: null, effort: null, mode: 'cold' },
      },
    }),
    {
      publicationTarget: 'draft',
      selectedEvidenceKeys: ['after.png'],
      packageId: 'pkg-1',
      packageHash: 'abcdef',
      packageHeadSha: '123456',
      reviewRequest: { runner: 'codex', model: null, effort: null, mode: 'cold' },
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
