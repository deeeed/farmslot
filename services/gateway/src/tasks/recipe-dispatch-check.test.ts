import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RecipeConformanceReport, RuntimeCapabilityProofPlan } from '@farmslot/protocol';

import type { ProjectVars, SlotVars } from '../core/config.js';
import { NodeExecUnconfirmedError } from '../fleet/node-rpc.js';

import {
  assertRecipeDispatchRequirements,
  checkRecipeDispatchRequirements,
} from './recipe-dispatch-check.js';

const projectJson = {
  name: 'demo',
  recipe: { provider: { module: './provider.mjs' }, adapter: 'node' },
};
const project: ProjectVars = {
  projectName: 'demo',
  artifactDir: '.task',
  projectConfig: '/registry/demo/project.json',
  projectFixturesDir: '/registry/demo/fixtures',
  projectTemplatesDir: '/registry/demo/templates',
  runtimeDir: '.agent',
  projectJson,
};
const slot = { slotId: 'demo-slot', remoteRepo: '/checkout', platform: 'node' } as SlotVars;
const params = { expected: 'hello, world', items: ['one', 'two'] };
const selected = {
  sha256: 'template-digest',
  frontmatter: { recipe_checks: ['smoke'], recipe_params: JSON.stringify(params) },
};
const source = { head: 'revision', status: '', sourceFingerprint: 'digest' };
const report: RecipeConformanceReport = {
  schemaVersion: 1,
  checkedAt: '2026-10-11T00:00:00.000Z',
  status: 'pass',
  mode: 'static',
  identity: {
    project: 'demo',
    app: null,
    domain: null,
    adapter: 'node',
    target: '/checkout',
    checkout: source,
    provider: source,
    libraries: [],
    configuration: [],
  },
  capabilities: [],
  checks: [
    {
      id: 'recipe.smoke',
      status: 'pass',
      required: true,
      message: 'Passed',
      evidence: {
        plan: {
          schemaVersion: 1,
          digest: 'plan',
          executionContextDigest: 'context',
          source: { kind: 'library', trust: 'trusted' },
          nodes: [],
        },
      },
    },
  ],
};

test('stale retained proof stays unverified while fresh selected preflight uses another report file', async () => {
  const calls: unknown[] = [];
  const result = await checkRecipeDispatchRequirements(
    project,
    slot,
    selected,
    {},
    {
      exists: async (file) => {
        assert.equal(file, '/checkout/.task/conformance/conformance-report.json');
        return true;
      },
      resources: async () => {
        throw new Error('No resource requirement was selected');
      },
      report: async (options) => {
        calls.push(options);
        if (options.checkReport) throw new Error('Retained provider digest changed');
        return report;
      },
    },
  );
  assert.deepEqual(calls, [
    { recipes: ['smoke'], params, checkReport: '.task/conformance/conformance-report.json' },
    { recipes: ['smoke'], params, reportName: 'dispatch-template-digest.json' },
  ]);
  assert.equal(result.recipeVerified, false);
  assert.deepEqual(result.diagnostics, ['Retained provider digest changed']);
  assert.deepEqual(result.missingRequirements, []);
  assertRecipeDispatchRequirements(result);
});

test('failed current handler preflight blocks dispatch with its actionable reason', async () => {
  const result = await checkRecipeDispatchRequirements(
    project,
    slot,
    selected,
    {},
    {
      exists: async () => false,
      resources: async () => [],
      report: async () => {
        throw new Error('No registered adapter for demo.read');
      },
    },
  );
  assert.throws(
    () => assertRecipeDispatchRequirements(result),
    /recipe.smoke.*No registered adapter for demo.read/,
  );
});

test('static flow performs no report, provider or resource operations', async () => {
  const forbidden = async (): Promise<never> => {
    throw new Error('Unexpected runtime operation');
  };
  const result = await checkRecipeDispatchRequirements(
    project,
    slot,
    undefined,
    {},
    {
      exists: forbidden,
      report: forbidden,
      resources: forbidden,
    },
  );
  assert.equal(result.registered, true);
  assert.equal(result.recipeVerified, false);
  assertRecipeDispatchRequirements(result);
});

test('lost closeout never starts a second check', async () => {
  let calls = 0;
  await assert.rejects(
    checkRecipeDispatchRequirements(
      project,
      slot,
      selected,
      {},
      {
        exists: async () => true,
        resources: async () => [],
        report: async () => {
          calls++;
          throw new NodeExecUnconfirmedError('node', 'request', 'disconnected');
        },
      },
    ),
    NodeExecUnconfirmedError,
  );
  assert.equal(calls, 1);
});

test('IDs-only initial admission refuses before provider/report effects; retained run mode permits preflight', async () => {
  const requirement = { capabilityId: 'browser', reason: 'Observe', mode: 'visual' as const };
  const plan: RuntimeCapabilityProofPlan = {
    version: 1,
    ownerRunId: 'run',
    slotId: slot.slotId,
    createdAt: '2026-10-13T00:00:00Z',
    requirements: [requirement],
  };
  const selectedResources = {
    ...selected,
    frontmatter: { ...selected.frontmatter, runtime_capabilities: ['browser'] },
  };
  const calls: string[] = [];
  const deps = {
    exists: async () => {
      calls.push('exists');
      return false;
    },
    report: async (options: unknown) => {
      calls.push('report');
      assert.equal((options as Record<string, unknown>).runId, undefined);
      return report;
    },
    resources: async () => {
      calls.push('catalog');
      return [];
    },
    proofPlan: async (runId: string, slotId: string) => {
      assert.equal(runId, 'run');
      assert.equal(slotId, slot.slotId);
      calls.push('stored-plan');
      return plan;
    },
  };
  const missing = await checkRecipeDispatchRequirements(project, slot, selectedResources, {}, deps);
  assert.deepEqual(calls, ['catalog']);
  assert.throws(() => assertRecipeDispatchRequirements(missing), /browser.*authored/);
  calls.length = 0;
  const retained = await checkRecipeDispatchRequirements(
    project,
    slot,
    selectedResources,
    { runId: 'run' },
    deps,
  );
  assert.deepEqual(calls, ['stored-plan', 'exists', 'report', 'catalog']);
  assert.ok(!retained.missingRequirements.includes('resource.browser.proof-mode'));
  assert.ok(
    retained.requirements.some(
      (item) => item.name === 'resource.browser.proof-mode.visual' && item.status === 'declared',
    ),
  );
  assert.deepEqual(plan.requirements, [requirement]);
  calls.length = 0;
  const conflicting = {
    ...selectedResources,
    frontmatter: {
      ...selectedResources.frontmatter,
      runtime_capability_requirements: JSON.stringify([{ ...requirement, mode: 'mixed' }]),
    },
  };
  const refused = await checkRecipeDispatchRequirements(
    project,
    slot,
    conflicting,
    { runId: 'run' },
    deps,
  );
  assert.deepEqual(calls, ['stored-plan', 'catalog']);
  assert.throws(() => assertRecipeDispatchRequirements(refused), /conflicts.*stored visual/);
});
