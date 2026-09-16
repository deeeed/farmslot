import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveDispatchWizardBlockingState } from './dispatch-wizard-blockers.js';
import {
  canDispatch,
  dispatchBlockedReason,
  isDispatchBlocked,
  isQueueBlocked,
  queueBlockedReason,
  validationHint,
} from './dispatch-wizard-validation.js';

test('canDispatch and validationHint explain missing draft fields', () => {
  assert.equal(
    canDispatch({
      flowType: 'fix-bug',
      ticketId: 'PROJ-1',
      project: 'mobile',
      comparisonFlow: false,
      comparisonParentRunId: '',
    }),
    true,
  );
  assert.equal(
    validationHint({
      flowType: null,
      ticketId: '',
      project: '',
      matchingProject: false,
      comparisonFlow: false,
      comparisonParentRunId: '',
    }),
    'Select a flow type',
  );
  assert.equal(
    validationHint({
      flowType: 'fix-bug',
      ticketId: '',
      project: '',
      matchingProject: false,
      comparisonFlow: false,
      comparisonParentRunId: '',
    }),
    'Enter a ticket or PR number',
  );
  assert.equal(
    validationHint({
      flowType: 'fix-bug',
      ticketId: 'PROJ-1',
      project: '',
      matchingProject: true,
      comparisonFlow: false,
      comparisonParentRunId: '',
    }),
    'Matching project...',
  );
  assert.equal(
    validationHint({
      flowType: 'fix-bug',
      ticketId: 'PROJ-1',
      project: 'mobile',
      matchingProject: false,
      comparisonFlow: true,
      comparisonParentRunId: '',
    }),
    'Pick a baseline run for this comparison sibling',
  );
});

test('dispatchBlockedReason reports unavailable selected slot and empty filtered candidates', () => {
  assert.equal(
    dispatchBlockedReason({
      machineFilterActive: false,
      slotOverride: 'slot-1',
      selectedCandidate: { slotId: 'slot-1', free: false } as never,
      dispatchableCandidateCount: 1,
    }),
    'Selected slot slot-1 is not free — choose a free slot or use Queue.',
  );
  assert.equal(
    dispatchBlockedReason({
      machineFilterActive: true,
      slotOverride: '',
      selectedCandidate: null,
      dispatchableCandidateCount: 0,
    }),
    'No free slots on the filtered machines — drop the filter or use Queue.',
  );
});

test('isDispatchBlocked aggregates transient and validation blockers', () => {
  assert.equal(
    isDispatchBlocked({
      canDispatch: true,
      dispatching: false,
      connectionStale: false,
      hydrating: false,
      bootstrapFailed: false,
      loadingCandidates: false,
      candidateRefreshFailed: false,
      activeRunConflict: false,
      variantInputBlocked: false,
      dispatchBlockedReason: null,
    }),
    false,
  );
  assert.equal(
    isDispatchBlocked({
      canDispatch: true,
      dispatching: false,
      connectionStale: false,
      hydrating: false,
      bootstrapFailed: false,
      loadingCandidates: true,
      candidateRefreshFailed: false,
      activeRunConflict: false,
      variantInputBlocked: false,
      dispatchBlockedReason: null,
    }),
    true,
  );
  assert.equal(
    isDispatchBlocked({
      canDispatch: true,
      dispatching: false,
      connectionStale: false,
      hydrating: false,
      bootstrapFailed: false,
      loadingCandidates: false,
      candidateRefreshFailed: false,
      activeRunConflict: true,
      variantInputBlocked: false,
      dispatchBlockedReason: null,
    }),
    true,
  );
});

test('queue blockers protect stale connection and empty allowed slot filters', () => {
  assert.equal(
    queueBlockedReason({
      canDispatch: false,
      validationHint: 'Select a project',
      connectionStale: false,
      machineFilterActive: false,
      allowedSlots: undefined,
    }),
    'Select a project',
  );
  assert.equal(
    queueBlockedReason({
      canDispatch: true,
      validationHint: '',
      connectionStale: true,
      machineFilterActive: false,
      allowedSlots: undefined,
    }),
    'Gateway connection is stale.',
  );
  assert.equal(
    queueBlockedReason({
      canDispatch: true,
      validationHint: '',
      connectionStale: false,
      machineFilterActive: true,
      allowedSlots: [],
    }),
    'No slots match the active machine filter for this project.',
  );
  assert.equal(
    isQueueBlocked({ queueBlockedReason: null, canDispatch: true, connectionStale: false }),
    false,
  );
});

test('static review admission ignores device-slot availability while QA retains slot admission', () => {
  const input = {
    flowType: 'review-pr' as const,
    ticketId: 'owner/repo#1',
    project: 'static-farm',
    matchingProject: false,
    slotOverride: '',
    candidates: [],
    machineFilters: ['review-node'],
    fleetSlots: [],
    dispatching: false,
    connectionStale: false,
    hydrating: false,
    bootstrapFailed: false,
    loadingCandidates: true,
    candidateRefreshFailed: true,
    activeRunConflict: false,
    variantInputBlocked: false,
    comparisonFlow: false,
    comparisonParentRunId: '',
    pressureOverrideReady: false,
  };
  const review = deriveDispatchWizardBlockingState(input);
  assert.equal(review.dispatchBlocked, false);
  assert.equal(review.queueBlocked, false);
  assert.equal(review.allowedSlots, undefined);
  const qa = deriveDispatchWizardBlockingState({ ...input, flowType: 'qa' });
  assert.equal(qa.dispatchBlocked, true);
  assert.equal(qa.queueBlocked, true);
});

test('a pinned slot outside the actual machine filter is refused, not replaced', () => {
  const result = deriveDispatchWizardBlockingState({
    flowType: 'qa',
    ticketId: 'owner/repo#1',
    project: 'farm',
    matchingProject: false,
    slotOverride: 'opaque-slot',
    candidates: [],
    machineFilters: ['allowed-machine'],
    fleetSlots: [],
    dispatching: false,
    connectionStale: false,
    hydrating: false,
    bootstrapFailed: false,
    loadingCandidates: false,
    candidateRefreshFailed: false,
    activeRunConflict: false,
    variantInputBlocked: false,
    comparisonFlow: false,
    comparisonParentRunId: '',
    pressureOverrideReady: false,
  });
  assert.equal(result.dispatchBlocked, true);
  assert.equal(result.queueBlocked, true);
  assert.match(result.dispatchBlockedReason ?? '', /outside the active/);
});
