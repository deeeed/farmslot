import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { QaAfterReview } from '@farmslot/protocol';
import { withProjectSources } from '@farmslot/slot-config';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from '../run-engine/test-fixtures.js';
import { getAllRuns } from '../runs/store.js';
import { runWithWorkOriginator, type WorkOriginator } from '../security/work-originator.js';

import {
  sourceTestLock,
  sourceTestMaterialization,
  sourceTestPlan,
} from './source.test-support.js';

const methods = await import('../methods/run.js');
const validated: Array<string | undefined> = [];
let plannedQaAfterReview: QaAfterReview | undefined;
mock.module('../methods/run.js', {
  namedExports: {
    ...methods,
    planRunCreation: async (params: Parameters<typeof methods.planRunCreation>[0]) => {
      validated.push(params.slotId);
      return {
        params,
        workflowExecution: undefined,
        reviewQa: undefined,
        qaAfterReview: structuredClone(plannedQaAfterReview),
        directReviewPublication: undefined,
        executionTemplateSnapshot: undefined,
        workspaceAdmission: undefined,
      };
    },
  },
});
const { replanSourceRun } = await import('./runtime.js');

test('candidate validation never turns automatic placement into an explicit request', async () => {
  const run = makeRun({
    id: 'run-1',
    project: 'demo',
    flowType: 'dev',
    status: 'slot-finding',
    slotId: null,
    mode: 'autonomous',
  });
  run.sourcePlan = sourceTestPlan();
  run.dispatchRequest = {
    project: 'demo',
    flowType: 'dev',
    ticketOrPr: 'TAT-1',
    mode: 'autonomous',
  };
  const lock = sourceTestLock('node-1');
  const sources = {
    project: 'demo',
    pack: lock.packBindings.demo,
    materialization: sourceTestMaterialization(lock, 'gateway'),
    packs: lock.packBindings,
  };
  const registered = getAllRuns().map((current) => current.id);
  const next = await withProjectSources(sources, () =>
    replanSourceRun(run, { nodeId: 'node-1', slotId: 'candidate' }),
  );
  assert.equal(validated.at(-1), 'candidate');
  assert.equal(next.id, run.id);
  assert.equal(next.slotId, null);
  assert.deepEqual(next.dispatchRequest, run.dispatchRequest);
  assert.equal(next.sourcePlan?.lock.context.nodeId, 'node-1');
  assert.equal(next.sourcePlan?.validatedSlotId, 'candidate');
  assert.equal(next.sourceProvenance, undefined);
  assert.deepEqual(
    getAllRuns().map((current) => current.id),
    registered,
  );
});

test('an explicit request or recorded human pick survives source revalidation', async () => {
  for (const slotId of ['requested', null]) {
    const run = makeRun({
      id: 'run-1',
      project: 'demo',
      flowType: 'dev',
      status: 'slot-finding',
      slotId,
      mode: 'autonomous',
    });
    run.sourcePlan = sourceTestPlan();
    run.dispatchRequest = {
      project: 'demo',
      flowType: 'dev',
      ticketOrPr: 'TAT-1',
      mode: 'autonomous',
      ...(slotId ? { slotId } : {}),
    };
    const lock = sourceTestLock('node-1');
    const sources = {
      project: 'demo',
      pack: lock.packBindings.demo,
      materialization: sourceTestMaterialization(lock, 'gateway'),
      packs: lock.packBindings,
    };
    const next = await withProjectSources(sources, () =>
      replanSourceRun(run, {
        nodeId: 'node-1',
        slotId: slotId ?? 'picked',
        ...(slotId ? {} : { requestedSlotId: 'picked' }),
      }),
    );
    assert.equal(next.slotId, slotId ?? 'picked');
    assert.deepEqual(next.dispatchRequest, run.dispatchRequest);
  }
});

function automaticQaSnapshot(): QaAfterReview {
  return {
    version: 1,
    capturedAt: '2026-10-12T00:00:00Z',
    selection: {
      profile: { id: 'smoke', title: 'Smoke', template_id: 'qa' },
      inputs: { target: 'demo' },
    },
    execution: { slotPolicy: { kind: 'pool', allowedSlots: ['candidate'] }, models: [] },
    review: { mode: 'cold', workflow: 'qa', qaProfileId: 'smoke' },
    state: 'submitted',
    teamId: 'team-1',
    submissionId: 'submission-1',
    intentId: 'intent-1',
    checkedAt: '2026-10-12T01:00:00Z',
    error: 'retained-diagnostic',
  };
}

function automaticQaRun(snapshot = automaticQaSnapshot()) {
  const run = makeRun({
    id: 'run-1',
    project: 'demo',
    flowType: 'review-pr',
    status: 'slot-finding',
    slotId: null,
  });
  run.sourcePlan = sourceTestPlan();
  run.qaAfterReview = snapshot;
  run.dispatchRequest = {
    project: 'demo',
    flowType: 'review-pr',
    ticketOrPr: 'https://github.com/example/demo/pull/1',
  };
  return run;
}

test('automatic QA replan retains the original timestamp and every operational field', async (t) => {
  t.after(() => {
    plannedQaAfterReview = undefined;
  });
  const run = automaticQaRun();
  plannedQaAfterReview = {
    ...structuredClone(run.qaAfterReview!),
    capturedAt: '2026-10-13T00:00:00Z',
    state: 'pending',
    teamId: undefined,
    submissionId: undefined,
    intentId: undefined,
    checkedAt: undefined,
    error: undefined,
  };
  const lock = sourceTestLock('node-1');
  const next = await withProjectSources(
    {
      project: 'demo',
      pack: lock.packBindings.demo,
      materialization: sourceTestMaterialization(lock, 'gateway'),
      packs: lock.packBindings,
    },
    () => replanSourceRun(run, { nodeId: 'node-1' }),
  );
  assert.equal(next.sourcePlan?.lock.digest, lock.digest);
  assert.deepEqual(next.qaAfterReview, run.qaAfterReview);
  assert.notEqual(next.qaAfterReview, run.qaAfterReview);
});

for (const field of ['selection', 'execution', 'review', 'removed', 'added'] as const) {
  test(`automatic QA replan refuses ${field} contract changes`, async (t) => {
    t.after(() => {
      plannedQaAfterReview = undefined;
    });
    const run = automaticQaRun();
    plannedQaAfterReview = automaticQaSnapshot();
    if (field === 'selection') plannedQaAfterReview.selection.inputs.target = 'other';
    else if (field === 'execution') plannedQaAfterReview.execution = undefined;
    else if (field === 'review') plannedQaAfterReview.review.qaProfileId = 'other';
    else if (field === 'removed') plannedQaAfterReview = undefined;
    else run.qaAfterReview = undefined;
    await assert.rejects(
      replanSourceRun(run, { nodeId: 'node-1' }),
      /Automatic QA admission contract changed/,
    );
  });
}

test('source revalidation keeps the creator generation under any actor', async () => {
  const lock = sourceTestLock('node-1');
  const sources = {
    project: 'demo',
    pack: lock.packBindings.demo,
    materialization: sourceTestMaterialization(lock, 'gateway'),
    packs: lock.packBindings,
  };
  const actors: WorkOriginator[] = [
    { kind: 'system' },
    { kind: 'principal', principalId: 'creator', principalGeneration: 1 },
    { kind: 'principal', principalId: 'admin', principalGeneration: 2 },
  ];
  for (const [generation, actor] of [
    ...actors.map((actor) => [1, actor] as const),
    [undefined, actors[2]] as const,
  ]) {
    const run = makeRun({ id: 'run-1', project: 'demo', flowType: 'dev', status: 'slot-finding' });
    run.sourcePlan = sourceTestPlan();
    run.dispatchRequest = { project: 'demo', flowType: 'dev', ticketOrPr: 'TAT-1' };
    run.createdByPrincipalId = 'creator';
    run.createdByPrincipalGeneration = generation;
    const next = await runWithWorkOriginator(actor, () =>
      withProjectSources(sources, () => replanSourceRun(run, { nodeId: 'node-1' })),
    );
    assert.equal(next.createdByPrincipalId, 'creator');
    assert.equal(next.createdByPrincipalGeneration, generation);
  }
});
