import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMarkdownDocument } from '@farmslot/agent-runtime';
import {
  type RecipeConformanceReport,
  type RecipeConformanceScope,
  recipeFlowRequirements,
  recipeProjectCompatibility,
} from '@farmslot/protocol';

const scope: RecipeConformanceScope = {
  project: 'example',
  app: 'app',
  domain: 'payments',
  adapter: 'web',
  target: '/checkout/app',
};
const source = { head: 'revision', status: '', sourceFingerprint: 'fingerprint' };
const report: RecipeConformanceReport = {
  schemaVersion: 1,
  checkedAt: '2026-10-11T00:00:00.000Z',
  status: 'pass',
  mode: 'live',
  identity: { ...scope, checkout: source, provider: source, libraries: [], configuration: [] },
  capabilities: [{ name: 'recipe.execution', status: 'verified' }],
  checks: [
    {
      id: 'recipe.payments/smoke',
      required: true,
      status: 'pass',
      message: 'Verified',
      evidence: {
        plan: {
          schemaVersion: 1,
          digest: 'digest',
          executionContextDigest: 'context',
          source: { kind: 'library', trust: 'trusted' },
          nodes: [
            {
              nodeId: 'read',
              action: 'assert_json',
              capabilities: [],
              origin: { kind: 'library', trust: 'trusted' },
            },
          ],
        },
        live: {
          smokeTarget: 'effect',
          teardownTarget: 'cleanup',
          artifactDir: '/proof',
          artifacts: [{ path: 'trace.json', digest: 'trace' }],
        },
      },
    },
  ],
};

test('requirements use the selected template metadata and static templates need no runtime', () => {
  const { frontmatter } = parseMarkdownDocument(
    '---\nrecipe_checks: [payments/smoke]\nrecipe_actions: [assert_json]\nrecipe_capture: false\nrecipe_params: \'{"expected":"hello, world","items":["one","two"],"nested":{"flag":true}}\'\n---\n# QA',
  );
  const required = recipeFlowRequirements(frontmatter);
  assert.deepEqual(required.recipes, ['payments/smoke']);
  assert.deepEqual(required.actions, ['assert_json']);
  assert.equal(required.capture, false);
  assert.deepEqual(required.params, {
    expected: 'hello, world',
    items: ['one', 'two'],
    nested: { flag: true },
  });
  const staticReview = recipeProjectCompatibility({
    scope,
    registered: false,
    required: recipeFlowRequirements(null),
    resources: [],
  });
  assert.deepEqual(staticReview.missingRequirements, []);
  assert.equal(staticReview.recipeVerified, false);
  assert.throws(() => recipeFlowRequirements({ recipe_checks: 'smoke' }), /array/);
  assert.throws(() => recipeFlowRequirements({ recipe_hud: 'false' }), /boolean/);
});

test('a verified web target does not certify another app, domain, adapter or checkout', () => {
  const required = recipeFlowRequirements({
    recipe_checks: ['payments/smoke'],
    recipe_actions: ['assert_json'],
  });
  const input = { scope, registered: true, required, resources: [], report };
  assert.equal(recipeProjectCompatibility(input).recipeVerified, true);
  assert.equal(
    recipeProjectCompatibility(input).requirements.find(
      (check) => check.name === 'action.assert_json',
    )?.status,
    'declared',
  );
  assert.equal(recipeProjectCompatibility(input).checked?.revision, 'revision');
  for (const key of ['project', 'app', 'domain', 'adapter', 'target'] as const) {
    const result = recipeProjectCompatibility({ ...input, scope: { ...scope, [key]: 'other' } });
    assert.equal(result.recipeVerified, false, key);
    assert.ok(result.missingRequirements.includes('recipe.payments/smoke'), key);
    assert.deepEqual(result.checked?.scope, scope);
  }
});

test('missing handlers and selected smoke checks cannot be hidden by declarations or unrelated proof', () => {
  const required = recipeFlowRequirements({
    recipe_checks: ['payments/other'],
    recipe_actions: ['ui.screenshot'],
    recipe_capture: true,
    recipe_hud: true,
    runtime_capabilities: ['device'],
  });
  const result = recipeProjectCompatibility({
    scope,
    registered: true,
    required,
    resources: [],
    report: {
      ...report,
      resolution: { recipes: [], actions: [{ action: 'ui.screenshot', source: 'declared-only' }] },
    },
  });
  assert.equal(result.registered, true);
  assert.equal(result.recipeVerified, false);
  assert.deepEqual(result.missingRequirements, [
    'recipe.payments/other',
    'action.ui.screenshot',
    'capture',
    'hud',
    'resource.device',
  ]);
  const staticReport = recipeProjectCompatibility({
    scope,
    registered: true,
    required: recipeFlowRequirements({ recipe_checks: ['payments/smoke'] }),
    resources: [],
    report: { ...report, mode: 'static' },
  });
  assert.deepEqual(staticReport.missingRequirements, []);
  assert.equal(staticReport.recipeVerified, false);
});
