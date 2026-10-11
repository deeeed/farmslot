import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RecipeConformanceReport } from '@farmslot/protocol';

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
