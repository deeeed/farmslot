import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import { latestResolvedHumanGateDecision } from './decision-replay.js';
import { executeFinalizeStep, type FinalizeStepContext } from './finalize-step.js';
import {
  assertPublicationFinalization,
  publicationFinalizationAction,
} from './publication-finalization.js';
import { deleteTestRunIfPresent, makeRun } from './test-fixtures.js';

function decision(action: string, id = action): RunDecision {
  return {
    id,
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: '',
    actions: [],
    createdAt: '2026-10-14T16:00:00Z',
    resolvedAt: '2026-10-14T16:01:00Z',
    resolvedAction: action,
  };
}

for (const action of ['continue-review-fix', 'request-review', 'hold', 'superseded']) {
  test(`${action} does not fulfill publication or resurrect an older approval`, () => {
    const run = makeRun({
      flowType: 'dev',
      mode: 'autonomous',
      decisions: [decision('approve-publish'), decision(action)],
      engineState: { publishGate: { publicationStatus: 'published_ready' } },
    });
    assert.equal(publicationFinalizationAction(run), undefined);
    assert.throws(
      () => assertPublicationFinalization(run, 'finalize'),
      (error) => error instanceof GatewayMethodError && error.code === 'RUN_GATE_NOT_READY',
    );
  });
}

test('an unresolved publication gate blocks finalization despite an older approval', () => {
  const pending = decision('approve-publish', 'pending');
  delete pending.resolvedAt;
  delete pending.resolvedAction;
  const run = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    decisions: [decision('approve-publish'), pending],
  });
  assert.throws(() => assertPublicationFinalization(run, 'finalize'), /requires approve-publish/);
});

test('approval permits finalize but DONE requires a linked published PR', () => {
  const run = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    decisions: [decision('approve-publish')],
  });
  assert.doesNotThrow(() => assertPublicationFinalization(run, 'finalize'));
  assert.throws(() => assertPublicationFinalization(run, 'complete'), /has not completed/);
  for (const publicationStatus of ['published_ready', 'published_draft'] as const) {
    run.engineState = { publishGate: { publicationStatus } };
    assert.doesNotThrow(() => assertPublicationFinalization(run, 'complete'));
  }
  run.prNumber = undefined;
  assert.throws(() => assertPublicationFinalization(run, 'complete'), /has not completed/);
});

test('close-as-shipped and non-publication flows retain their existing settlement authority', () => {
  const shipped = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    prNumber: undefined,
    decisions: [decision('close-as-shipped')],
  });
  assert.doesNotThrow(() => assertPublicationFinalization(shipped, 'complete'));
  for (const run of [
    makeRun({ flowType: 'dev', mode: 'autonomous', completionPolicy: 'artifact-only' }),
    makeRun({ flowType: 'qa' }),
    makeRun({ flowType: 'review-pr' }),
  ])
    assert.doesNotThrow(() => assertPublicationFinalization(run, 'complete'));
});

test('unapproved finalize refuses before any finalization effect and retains active review-fix', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    mode: 'autonomous',
    ticketOrPr: 'TAT-4129',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'completing',
    slotId: 'owned-test-slot',
    decisions: [decision('continue-review-fix')],
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Review fix',
        status: 'working',
        runId: run.id,
        slotId: 'owned-test-slot',
      },
    ],
  });
  const retained = structuredClone(getRun(run.id));
  const context: FinalizeStepContext = {
    broadcastFn: () => assert.fail('no finalization effects before approval'),
    latestResolvedHumanGateDecision,
    loadProjectVarsOrNull: async () => assert.fail('no project or slot effects before approval'),
    readPreparedPackage: async () =>
      assert.fail('no package or publication effects before approval'),
    refreshRunLinks: async () => assert.fail('no publication effects before approval'),
    stepPartialIO: new Map(),
  };
  await assert.rejects(executeFinalizeStep(run.id, context), /requires approve-publish/);
  assert.deepEqual(getRun(run.id), retained);
});
