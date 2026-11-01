import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';
import { currentProjectSources } from '@farmslot/slot-config';

import { makeRun } from '../../run-engine/test-fixtures.js';
import type { RunSlotSourcePlans, SourceSlotPlans } from '../../sources/slot-planning.js';
import {
  sourceTestLock,
  sourceTestMaterialization,
  sourceTestPlan,
} from '../../sources/source.test-support.js';

const core = await import('../../core/index.js');
const fleet = await import('../../fleet/state.js');
const recipe = await import('../../tasks/recipe-dispatch-check.js');
const ticket = await import('../../run-engine/ticket-data.js');
const branch = await import('./branch-checkout.js');
const pressure = await import('./pressure-admission.js');
const target = await import('./target-branch.js');
const runtime = await import('../../sources/runtime.js');
let prospective: SourceSlotPlans | undefined;
mock.module('../../sources/runtime.js', {
  namedExports: { ...runtime, planSourceRequestSlots: async () => prospective },
});

const slots = [
  { slot: 'a', machine: 'node-a' },
  { slot: 'b', machine: 'node-b' },
].map((identity) => ({
  ...identity,
  project: 'demo',
  lifecycle: 'ready',
  agent: 'idle',
  branch: 'main',
  platform: 'ios',
  health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
})) as SlotStatus[];
const observed: Array<{ action: string; nodeId?: string }> = [];
const observe = (action: string) => {
  const nodeId = currentProjectSources()?.materialization.lock.context.nodeId;
  observed.push({ action, nodeId });
  assert.equal(nodeId, 'node-b');
};
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    loadProjectVars: async () => {
      observe('project-vars');
      return { projectName: 'demo', projectJson: {} };
    },
    loadSlotVars: async () => {
      observe('slot-vars');
      return { slotId: 'b', platform: 'ios' };
    },
  },
});
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({ slots }),
    loadProjectConfig: async () => {
      observe('project-config');
      return { name: 'demo' };
    },
    loadProjectConfigs: async () => {
      throw new Error('Floating project configs must not be loaded');
    },
  },
});
mock.module('../../tasks/recipe-dispatch-check.js', {
  namedExports: {
    ...recipe,
    checkRecipeDispatchRequirements: async () => {
      observe('recipe');
      return { status: 'compatible' };
    },
  },
});
mock.module('../../run-engine/ticket-data.js', {
  namedExports: {
    ...ticket,
    fetchTicketData: async () => {
      observe('ticket');
      return null;
    },
  },
});
mock.module('./branch-checkout.js', {
  namedExports: { ...branch, inspectReleasableBranchHolders: async () => new Set() },
});
mock.module('./pressure-admission.js', {
  namedExports: { ...pressure, capturePressureAdmissionDecisions: async () => new Map() },
});
mock.module('./target-branch.js', {
  namedExports: { ...target, resolveDispatchTargetBranch: async () => undefined },
});
const { dispatchPreview } = await import('./preview.js');

function readyPlans(): RunSlotSourcePlans {
  const plans: RunSlotSourcePlans = new Map();
  for (const slot of slots) {
    const lock = sourceTestLock(slot.machine);
    const run = makeRun({ id: 'run-1', project: 'demo', flowType: 'dev', slotId: null });
    run.sourcePlan = sourceTestPlan(lock);
    plans.set(slot.slot, {
      run,
      sources: {
        project: 'demo',
        pack: lock.packBindings.demo,
        materialization: sourceTestMaterialization(lock, 'gateway'),
        packs: lock.packBindings,
      },
      params: {
        project: 'demo',
        flowType: 'dev',
        ticketOrPr: 'TAT-1',
        mode: 'autonomous',
        prepareProfile: slot.slot === 'a' ? 'sandbox-companion' : 'plain',
        runner: 'codex',
        model: 'selected-model',
      },
    });
  }
  return plans;
}

test('actual preview selects the node plan and performs final reads within its verified context', async () => {
  const plans = readyPlans();
  const result = await dispatchPreview(
    { project: 'demo', flowType: 'dev', ticketOrPr: 'TAT-1' },
    { sourcePlans: plans, includeProfileFit: false },
  );
  assert.equal(result.preview.slotId, 'b');
  assert.equal(result.preview.model, 'selected-model');
  assert(observed.some((entry) => entry.action === 'recipe'));
  assert(observed.every((entry) => entry.nodeId === 'node-b'));
  assert.equal(currentProjectSources(), undefined);
});

test('public preview bootstraps prospective plans without a caller-supplied internal map', async (t) => {
  prospective = readyPlans();
  t.after(() => {
    prospective = undefined;
  });
  const result = await dispatchPreview({ project: 'demo', flowType: 'dev', ticketOrPr: 'TAT-1' });
  assert.equal(result.preview.slotId, 'b');
  assert.equal(result.preview.model, 'selected-model');
});

test('an RPC-shaped sourcePlans field cannot forge gateway planning authority', async () => {
  await assert.rejects(
    dispatchPreview({
      project: 'demo',
      flowType: 'dev',
      ticketOrPr: 'TAT-1',
      sourcePlans: {},
    } as Parameters<typeof dispatchPreview>[0]),
    /gateway-owned/,
  );
});

test('an artifact-only dispatch that turns the pipeline review off sees it on the preview', async () => {
  const result = await dispatchPreview(
    {
      project: 'demo',
      flowType: 'dev',
      ticketOrPr: 'TAT-1',
      completionPolicy: 'artifact-only',
      pipelineReview: 'none',
    },
    { sourcePlans: readyPlans(), includeProfileFit: false },
  );
  assert.deepEqual(result.preview.pipelineReview, {
    policy: 'none',
    reason: 'Pipeline review is off for this artifact-only run (pipelineReview none).',
  });
  // Without artifact-only, or on a flow that pushes, the request is refused before any preview work.
  await assert.rejects(
    dispatchPreview({
      project: 'demo',
      flowType: 'dev',
      ticketOrPr: 'TAT-1',
      pipelineReview: 'none',
    }),
    /pipelineReview none is only for artifact-only runs: set completionPolicy artifact-only/,
  );
  await assert.rejects(
    dispatchPreview({
      project: 'demo',
      flowType: 'update-branch',
      ticketOrPr: 'org/repo#1',
      completionPolicy: 'artifact-only',
      pipelineReview: 'none',
    }),
    /only for dev and fix-bug runs; update-branch runs/,
  );
  const plain = await dispatchPreview(
    { project: 'demo', flowType: 'dev', ticketOrPr: 'TAT-1' },
    { sourcePlans: readyPlans(), includeProfileFit: false },
  );
  assert.equal(plain.preview.pipelineReview, undefined);
});
