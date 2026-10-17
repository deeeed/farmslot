import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload, SlotPickerPayload } from '../../src/contracts/runs.js';
import { SEND_BACK_TO_AGENT_ACTION } from '../../src/recipe/repair.js';
import {
  buildRunDecisionActionRequest,
  buildRunResolveDecisionParams,
  improvementApplyOutcome,
  readyResolveSelectionData,
  slotPickerViewModel,
} from '../../src/runs/decision-resolution.js';

const payload = {
  kind: 'ready',
  publicationTarget: 'pull_request',
  prPackage: {
    id: 'pkg-1',
    packageHash: 'hash-1',
    headSha: 'abc123',
    publicationTarget: 'pull_request',
    selectedEvidenceKeys: ['evidence/result.json'],
  },
} as ReadyGatePayload;

test('ready gate selection binds the exact package identity', () => {
  assert.deepEqual(readyResolveSelectionData({ payload }), {
    publicationTarget: 'pull_request',
    selectedEvidenceKeys: ['evidence/result.json'],
    packageId: 'pkg-1',
    packageHash: 'hash-1',
    packageHeadSha: 'abc123',
  });
});

test('ready gate selection lets an interactive surface override draft choices', () => {
  assert.deepEqual(
    readyResolveSelectionData({
      payload,
      publicationTarget: 'none',
      selectedEvidenceKeys: [],
      extraSelectionData: { operatorNote: 'hold evidence' },
    }),
    {
      publicationTarget: 'none',
      selectedEvidenceKeys: [],
      packageId: 'pkg-1',
      packageHash: 'hash-1',
      packageHeadSha: 'abc123',
      operatorNote: 'hold evidence',
    },
  );
});

test('Send back resolves the frozen gate decision with no selection data', () => {
  assert.deepEqual(
    buildRunResolveDecisionParams({
      runId: 'run-1',
      decision: { id: 'decision-1', payload },
      actionId: SEND_BACK_TO_AGENT_ACTION,
    }),
    { runId: 'run-1', decisionId: 'decision-1', actionId: SEND_BACK_TO_AGENT_ACTION },
  );
});

test('run decision params preserve action selection and bind ready package identity', () => {
  assert.deepEqual(
    buildRunResolveDecisionParams({
      runId: 'run-1',
      decision: { id: 'decision-1', payload },
      actionId: 'approve-publish',
      publicationTarget: 'draft',
      selectedEvidenceKeys: [],
      selectionData: { operatorNote: 'reviewed' },
    }),
    {
      runId: 'run-1',
      decisionId: 'decision-1',
      actionId: 'approve-publish',
      selectionData: {
        publicationTarget: 'draft',
        selectedEvidenceKeys: [],
        packageId: 'pkg-1',
        packageHash: 'hash-1',
        packageHeadSha: 'abc123',
        operatorNote: 'reviewed',
      },
    },
  );
});

test('run decision params stay minimal for actions without selection data', () => {
  assert.deepEqual(
    buildRunResolveDecisionParams({
      runId: 'run-1',
      decision: { id: 'decision-1' },
      actionId: 'continue',
    }),
    {
      runId: 'run-1',
      decisionId: 'decision-1',
      actionId: 'continue',
    },
  );
});

const slotPayload: SlotPickerPayload = {
  kind: 'slot_picker',
  project: 'test-project',
  reason: 'all_stale',
  candidates: [
    {
      slotId: 'available-slot',
      score: 1000,
      branch: 'previous-task',
      lifecycle: 'ready',
      machine: 'test-node',
      health: { ssh: 'OK', device: '-', devserver: 'OFF', cdp: 'OFF', fixtures: 'OK' },
    },
    {
      slotId: 'busy-slot',
      score: -1,
      branch: 'active-task',
      lifecycle: 'busy',
      machine: 'test-node',
      health: { ssh: 'OK', device: '-', devserver: 'OFF', cdp: 'OFF', fixtures: 'OK' },
    },
  ],
};

test('slot picker offers stale free candidates, excludes busy slots and requires a choice', () => {
  const view = slotPickerViewModel(slotPayload);
  assert.deepEqual(
    view.candidates.map((candidate) => candidate.slotId),
    ['available-slot'],
  );
  assert.equal(view.unavailableCount, 1);
  assert.equal(view.selectedSlotId, null);
  assert.equal(slotPickerViewModel(slotPayload, 'busy-slot').selectedSlotId, null);
  assert.equal(slotPickerViewModel(slotPayload, 'old-slot').selectedSlotId, null);
});

test('selected candidate becomes selectionData.slotId on the run decision request', () => {
  const view = slotPickerViewModel(slotPayload, 'available-slot');
  assert.equal(view.selectedSlotId, 'available-slot');
  assert.deepEqual(
    buildRunDecisionActionRequest({
      runId: 'run-1',
      decision: { id: 'slot-decision', type: 'engine_no_suitable_slot', payload: slotPayload },
      actionId: 'pick',
      selectionData: { slotId: view.selectedSlotId },
    }),
    {
      method: 'run.resolveDecision',
      params: {
        runId: 'run-1',
        decisionId: 'slot-decision',
        actionId: 'pick',
        selectionData: { slotId: 'available-slot' },
      },
    },
  );
});

test('candidate refresh clears a removed or newly busy selection', () => {
  assert.equal(
    slotPickerViewModel({ ...slotPayload, candidates: [] }, 'available-slot').selectedSlotId,
    null,
  );
  const busy = { ...slotPayload.candidates[0], score: -1, lifecycle: 'busy' };
  assert.equal(
    slotPickerViewModel({ ...slotPayload, candidates: [busy] }, 'available-slot').selectedSlotId,
    null,
  );
});

test('improvement Apply uses the write-and-validate endpoint, while dismiss uses run resolution', () => {
  const input = { runId: 'run-1', decision: { id: 'improvement-1', type: 'improvement' } };
  assert.deepEqual(buildRunDecisionActionRequest({ ...input, actionId: 'apply' }), {
    method: 'improvement.apply',
    params: { runId: 'run-1', decisionId: 'improvement-1' },
  });
  assert.deepEqual(buildRunDecisionActionRequest({ ...input, actionId: 'dismiss' }), {
    method: 'run.resolveDecision',
    params: { runId: 'run-1', decisionId: 'improvement-1', actionId: 'dismiss' },
  });
});

test('shared request retains ready-package identity and resource-posture selection', () => {
  const request = buildRunDecisionActionRequest({
    runId: 'run-1',
    decision: { id: 'ready-1', type: 'engine_human_gate', payload },
    actionId: 'approve-publish',
    resourcePosture: 'minimize',
  });
  assert.equal(request.method, 'run.resolveDecision');
  assert.deepEqual(request.params, {
    runId: 'run-1',
    decisionId: 'ready-1',
    actionId: 'approve-publish',
    resourcePosture: 'minimize',
    selectionData: readyResolveSelectionData({ payload }),
  });
});

test('improvement outcome keeps refused or validation-failed cards pending', () => {
  assert.equal(improvementApplyOutcome({ applied: [], validationPassed: true }).passed, true);
  const validation = improvementApplyOutcome({
    applied: [],
    validationPassed: false,
    validationOutput: 'Template is invalid',
  });
  assert.equal(validation.passed, false);
  assert.match(validation.message, /Template is invalid/);
  const refused = improvementApplyOutcome({
    applied: [],
    validationPassed: true,
    refused: [{ filePath: 'templates/dev.md', reason: 'stale-anchor' }],
  });
  assert.equal(refused.passed, false);
  assert.match(refused.message, /stale-anchor/);
});
