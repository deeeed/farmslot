import assert from 'node:assert/strict';
import test from 'node:test';

import { currentProjectSources } from '@farmslot/slot-config';

import { getAllRuns } from '../runs/store.js';

import {
  planProspectiveSlotSources,
  type ProspectiveSlotPlanningDependencies,
} from './slot-planning.js';
import { sourceTestLock, sourceTestMaterialization } from './source.test-support.js';

const slots = [
  { slot: 'a', machine: 'node-a', project: 'demo' },
  { slot: 'b', machine: 'node-b', project: 'demo' },
];

function fixture() {
  const contexts: Array<{ project: string; runId?: string; nodeId?: string }> = [];
  const deps: ProspectiveSlotPlanningDependencies = {
    authority: {
      lock: async (context) => {
        contexts.push(context);
        return sourceTestLock(context.nodeId, null);
      },
    },
    gatewayMaterialization: async (lock) => sourceTestMaterialization(lock, 'gateway'),
    plan: async (slotId) => {
      const nodeId = currentProjectSources()!.materialization.lock.context.nodeId;
      if (nodeId === 'node-a') throw new Error('Requested QA preset is unavailable in this pack');
      return {
        params: {
          project: 'demo',
          flowType: 'qa',
          ticketOrPr: 'TASK-1',
          qaProfileId: 'experiment-only',
          slotId,
        },
        workflowExecution: undefined,
        reviewQa: undefined,
        qaAfterReview: undefined,
        directReviewPublication: undefined,
        executionTemplateSnapshot: undefined,
        workspaceAdmission: undefined,
      };
    },
    params: (plan) => ({ ...plan.params, slotId: undefined }),
    projectConfigs: async () => ({ demo: { defaultBranch: 'main' } }),
  };
  return { deps, contexts };
}

test('prospective planning accepts a node-only QA request without a farm plan or synthetic run', async () => {
  const f = fixture();
  const registered = getAllRuns().map((run) => run.id);
  const plans = await planProspectiveSlotSources('demo', slots, f.deps);
  assert.deepEqual(plans.get('a'), { refusal: 'Requested QA preset is unavailable in this pack' });
  const ready = plans.get('b')!;
  assert('creationPlan' in ready);
  assert.equal(ready.params.qaProfileId, 'experiment-only');
  assert.equal(ready.params.slotId, undefined);
  assert.equal(ready.creationPlan.params.slotId, 'b');
  assert(f.contexts.every((context) => context.runId === undefined));
  assert.deepEqual(
    getAllRuns().map((run) => run.id),
    registered,
  );
});

test('an unverified prospective materialization cannot read executable pack configuration', async () => {
  const f = fixture();
  f.deps.gatewayMaterialization = async (lock) => sourceTestMaterialization(lock, 'wrong-node');
  f.deps.plan = async () => {
    throw new Error('config must not be read');
  };
  const plans = await planProspectiveSlotSources('demo', slots, f.deps);
  assert(
    [...plans.values()].every(
      (plan) => 'refusal' in plan && !plan.refusal.includes('config must not be read'),
    ),
  );
});
