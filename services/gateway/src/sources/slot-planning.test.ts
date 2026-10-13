import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';
import { currentProjectSources } from '@farmslot/slot-config';

import { makeRun } from '../run-engine/test-fixtures.js';

import { planRunSlotSources, type RunSlotPlanningDependencies } from './slot-planning.js';
import {
  sourceTestLock,
  sourceTestMaterialization,
  sourceTestPlan,
} from './source.test-support.js';

const slots = [
  { slot: 'a-1', machine: 'node-a', project: 'demo' },
  { slot: 'a-2', machine: 'node-a', project: 'demo' },
  { slot: 'b-1', machine: 'node-b', project: 'demo' },
];

function fixture() {
  const run = makeRun({ id: 'run-1', project: 'demo', status: 'slot-finding', slotId: null });
  run.sourcePlan = sourceTestPlan();
  let current: Run = run;
  const fetched: string[] = [];
  const materialized: string[] = [];
  const deps: RunSlotPlanningDependencies = {
    getRun: () => current,
    authority: {
      lock: async ({ nodeId }) => {
        fetched.push(nodeId!);
        return sourceTestLock(nodeId);
      },
    },
    gatewayMaterialization: async (lock) => {
      materialized.push(lock.context.nodeId!);
      return sourceTestMaterialization(lock, 'gateway');
    },
    replan: async (original, target) => {
      const lock = currentProjectSources()!.materialization.lock;
      await Promise.resolve();
      assert.equal(currentProjectSources()!.materialization.lock.context.nodeId, target.nodeId);
      return {
        ...original,
        prepareProfile: target.nodeId === 'node-a' ? 'sandbox-companion' : 'plain',
        sourcePlan: { ...sourceTestPlan(lock), validatedSlotId: target.slotId },
      };
    },
    params: (planned) => ({
      project: planned.project,
      ticketOrPr: planned.ticketOrPr,
      flowType: planned.flowType,
      prepareProfile: planned.prepareProfile,
    }),
    projectConfigs: async () => ({
      demo: {
        defaultBranch:
          currentProjectSources()!.materialization.lock.context.nodeId === 'node-a'
            ? 'experiment-base'
            : 'main',
      },
    }),
  };
  return {
    run,
    deps,
    fetched,
    materialized,
    cancel: () => {
      current = { ...current, status: 'cancelled' };
    },
  };
}

test('candidate plans use each node closure once and retain automatic slot intent without publishing', async () => {
  const f = fixture();
  const plans = await planRunSlotSources(f.run, slots, f.deps);
  assert.deepEqual(f.fetched.sort(), ['node-a', 'node-b']);
  assert.deepEqual(f.materialized.sort(), ['node-a', 'node-b']);
  for (const slot of slots) {
    const plan = plans.get(slot.slot)!;
    assert('params' in plan);
    assert.equal(plan.sources.materialization.lock.context.nodeId, slot.machine);
    assert.equal(
      plan.params.prepareProfile,
      slot.machine === 'node-a' ? 'sandbox-companion' : 'plain',
    );
    assert.equal(plan.run.slotId, null);
    assert.equal(plan.run.sourceProvenance, undefined);
  }
  assert.equal(f.run.sourcePlan?.lock.context.nodeId, undefined);
  assert.equal(f.run.sourceProvenance, undefined);
});

test('one unavailable node closure refuses its slots while a different node remains selectable', async () => {
  const f = fixture();
  const resolve = f.deps.authority.lock;
  f.deps.authority.lock = async (context) => {
    if (context.nodeId === 'node-a') throw new Error('node-a branch unavailable');
    return resolve(context);
  };
  const plans = await planRunSlotSources(f.run, slots, f.deps);
  assert.deepEqual(plans.get('a-1'), { refusal: 'node-a branch unavailable' });
  assert.deepEqual(plans.get('a-2'), { refusal: 'node-a branch unavailable' });
  assert('params' in plans.get('b-1')!);
});

test('cancellation during planning refuses the whole obsolete placement without provenance', async () => {
  const f = fixture();
  const materialize = f.deps.gatewayMaterialization;
  f.deps.gatewayMaterialization = async (lock) => {
    f.cancel();
    return materialize(lock);
  };
  await assert.rejects(
    planRunSlotSources(f.run, slots, f.deps),
    /Run ownership or source plan changed/,
  );
  assert.equal(f.run.sourceProvenance, undefined);
});

for (const mutation of ['replay', 'plan', 'ownership'] as const) {
  test(`in-place ${mutation} during candidate planning refuses obsolete placements`, async () => {
    const f = fixture();
    const materialize = f.deps.gatewayMaterialization;
    f.deps.gatewayMaterialization = async (lock) => {
      if (mutation === 'replay') f.run.engineState = { ...f.run.engineState, generation: 1 };
      else if (mutation === 'plan') f.run.sourcePlan!.validatedSlotId = 'replayed-slot';
      else f.run.createdByPrincipalId = 'different-owner';
      return materialize(lock);
    };
    await assert.rejects(
      planRunSlotSources(f.run, slots, f.deps),
      /Run ownership or source plan changed/,
    );
    assert.equal(f.deps.getRun(f.run.id), f.run);
    assert.equal(f.run.sourceProvenance, undefined);
  });
}

test('a mismatched gateway receipt cannot supply candidate configuration', async () => {
  const f = fixture();
  f.deps.gatewayMaterialization = async (lock) => sourceTestMaterialization(lock, 'another-node');
  f.deps.replan = async () => {
    throw new Error('unverified configuration must not be read');
  };
  const plans = await planRunSlotSources(f.run, slots, f.deps);
  assert([...plans.values()].every((plan) => 'refusal' in plan));
  assert(
    [...plans.values()].every(
      (plan) => 'refusal' in plan && !plan.refusal.includes('configuration must not be read'),
    ),
  );
});
