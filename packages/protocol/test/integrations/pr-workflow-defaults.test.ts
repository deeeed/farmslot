import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectWorkflowDefaults, PRWorkflowPolicy } from '../../src/contracts/config.js';
import type {
  PRSlotExecutionProfile,
  PRWorkspaceExecutionProfile,
} from '../../src/contracts/pr-monitoring.js';
import {
  normalizeProjectWorkflowDefaults,
  resolvePRWorkflowDefaults,
} from '../../src/integrations/pr-workflow-defaults.js';

const workspace: PRWorkspaceExecutionProfile = {
  workspacePolicy: { kind: 'pool', allowedMachines: ['one', 'two'] },
  transport: 'native',
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high', allowedMachines: ['two'] }],
};
const slots: PRSlotExecutionProfile = {
  slotPolicy: { kind: 'exact', slotId: 'runtime' },
  models: [{ runner: 'runner', model: 'model' }],
};
const farm: ProjectWorkflowDefaults = {
  'review-pr': {
    execution: workspace,
    review: { sessionIntent: 'reset', scope: 'full', validationDepth: 'static-code' },
  },
};

test('static farm defaults retain their source and do not supply slots for full-live', () => {
  const selected = resolvePRWorkflowDefaults({ farm });
  assert.deepEqual(selected.execution, workspace);
  assert.deepEqual(selected.review, farm['review-pr']!.review);
  assert.deepEqual(selected.sources, { execution: 'farm', review: 'farm' });
  const runtime = resolvePRWorkflowDefaults({ validationDepth: 'full-live', farm });
  assert.equal(runtime.execution, undefined);
  assert.equal(runtime.review.validationDepth, 'full-live');
  assert.deepEqual(runtime.sources, { execution: null, review: 'built-in' });
});

test('higher-priority policies keep their targets, runner and model without merging farm choices', () => {
  const layers = ['request', 'rule', 'repository', 'team'] as const;
  const configured: Partial<Record<(typeof layers)[number], PRWorkflowPolicy>> = {};
  for (const layer of [...layers].reverse()) {
    const execution: PRWorkspaceExecutionProfile = {
      workspacePolicy: { kind: 'exact', machine: layer },
      models: [{ runner: layer, model: `${layer}-model` }],
      transport: 'native',
    };
    configured[layer] = {
      execution,
      review: {
        sessionIntent: 'resume',
        scope: 'incremental',
        validationDepth: 'static-code',
        busySession: 'fresh',
      },
    };
    const selected = resolvePRWorkflowDefaults({ ...configured, farm });
    assert.deepEqual(selected.execution, execution);
    assert.deepEqual(selected.sources, { execution: layer, review: layer });
  }
  const pinned = resolvePRWorkflowDefaults({ request: { execution: slots }, farm });
  assert.deepEqual(
    pinned.execution,
    slots,
    'A static slot pin needs explicit migration, never a silent machine substitution',
  );
});

test('every inherited full-live policy keeps its runtime execution and skips static defaults', () => {
  for (const layer of ['request', 'rule', 'repository', 'team'] as const) {
    const result = resolvePRWorkflowDefaults({
      [layer]: {
        execution: slots,
        review: { sessionIntent: 'reset', scope: 'full', validationDepth: 'full-live' },
      },
      farm,
    });
    assert.deepEqual(result.execution, slots);
    assert.equal(result.review.validationDepth, 'full-live');
    assert.deepEqual(result.sources, { execution: layer, review: layer });
  }
  assert.throws(
    () =>
      resolvePRWorkflowDefaults({
        validationDepth: 'static-code',
        request: {
          review: { sessionIntent: 'reset', scope: 'full', validationDepth: 'full-live' },
        },
        farm,
      }),
    /conflicts/,
  );
});

test('static defaults reject runtime policies and return detached configuration', () => {
  for (const value of [
    null,
    [],
    { qa: {} },
    { 'review-pr': {} },
    { 'review-pr': { execution: slots } },
    {
      'review-pr': {
        review: { sessionIntent: 'reset', scope: 'full', validationDepth: 'full-live' },
      },
    },
  ])
    assert.throws(() => normalizeProjectWorkflowDefaults(value));
  const result = resolvePRWorkflowDefaults({ farm });
  result.execution!.models[0].runner = 'changed';
  result.review.scope = 'incremental';
  assert.equal(farm['review-pr']!.execution!.models[0].runner, 'codex');
  assert.equal(farm['review-pr']!.review!.scope, 'full');
});
