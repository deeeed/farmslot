import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { withProjectSources } from '@farmslot/slot-config';

import { makeRun } from '../run-engine/test-fixtures.js';
import { getAllRuns } from '../runs/store.js';

import {
  sourceTestLock,
  sourceTestMaterialization,
  sourceTestPlan,
} from './source.test-support.js';

const methods = await import('../methods/run.js');
const validated: Array<string | undefined> = [];
mock.module('../methods/run.js', {
  namedExports: {
    ...methods,
    planRunCreation: async (params: Parameters<typeof methods.planRunCreation>[0]) => {
      validated.push(params.slotId);
      return {
        params,
        workflowExecution: undefined,
        reviewQa: undefined,
        qaAfterReview: undefined,
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
