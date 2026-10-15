import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  conformanceChecksPass,
  type RecipeConformanceCheck,
  type RecipeConformanceLiveEvidence,
  recipeFlowRequirements,
  recipeProjectCompatibility,
  resolveRecipeProofRequirements,
} from '../src/contracts/recipe-conformance.js';
import type { RuntimeCapabilityProofPlan } from '../src/contracts/runtime-capabilities.js';

const proofRequirement = {
  capabilityId: 'browser',
  reason: 'Observe the application',
  mode: 'visual' as const,
};
const declaration = (entries: unknown = [proofRequirement], resources = ['browser']) => ({
  runtime_capabilities: resources,
  runtime_capability_requirements: JSON.stringify(entries),
});

test('initial proof declarations preserve JSON acquire inputs and require exact resource coverage', () => {
  for (const mode of ['state', 'visual', 'mixed']) {
    const entry = {
      ...proofRequirement,
      mode,
      parameters: { flag: false, value: null, items: [1, 'two'], nested: { count: 3 } },
    };
    assert.deepEqual(recipeFlowRequirements(declaration([entry])).proofRequirements, [entry]);
  }
  assert.deepEqual(recipeFlowRequirements(null).proofRequirements, []);
  assert.deepEqual(recipeFlowRequirements(declaration([], [])).proofRequirements, []);
  assert.deepEqual(
    recipeFlowRequirements({ runtime_capabilities: ['browser'] }).proofRequirements,
    [],
  );
  for (const metadata of [
    { runtime_capabilities: ['browser'], runtime_capability_requirements: [] },
    { runtime_capabilities: ['browser'], runtime_capability_requirements: '{bad' },
    declaration(null),
    declaration({}),
    declaration([]),
    declaration([proofRequirement], []),
    declaration([proofRequirement], ['browser', 'server']),
    declaration([proofRequirement, proofRequirement]),
    ...[
      { capabilityId: '' },
      { capabilityId: ' browser' },
      { reason: '' },
      { reason: 'why ' },
      { mode: 'auto' },
      { parameters: [] },
      { parameters: null },
      { unknown: true },
    ].map((delta) => declaration([{ ...proofRequirement, ...delta }])),
  ])
    assert.throws(() => recipeFlowRequirements(metadata));
});

test('stored proof modes preserve retargets without mutating plans or template defaults', () => {
  const owner = { ownerRunId: 'run', slotId: 'slot' };
  const retained = { ...proofRequirement, parameters: { target: 'retargeted', onlyStored: true } };
  const dependency = {
    capabilityId: 'server',
    reason: 'Dependency',
    mode: 'state' as const,
    parameters: { port: 8080 },
  };
  const plan: RuntimeCapabilityProofPlan = {
    version: 1,
    ...owner,
    createdAt: '2026-10-13T00:00:00Z',
    requirements: [retained, dependency],
  };
  const snapshot = structuredClone(plan);
  const required = recipeFlowRequirements(
    declaration([{ ...proofRequirement, parameters: { target: 'default', onlyDefault: true } }]),
  );
  const first = resolveRecipeProofRequirements({ required });
  assert.deepEqual(first.requirements, required.proofRequirements);
  assert.deepEqual(first.missingRequirements, []);
  const reused = resolveRecipeProofRequirements({ required, owner, plan });
  assert.deepEqual(reused.requirements, [retained]);
  assert.deepEqual(plan, snapshot);
  reused.requirements[0].parameters!.target = 'copy';
  assert.deepEqual(plan, snapshot);
  assert.deepEqual(required.proofRequirements[0].parameters, {
    target: 'default',
    onlyDefault: true,
  });
  const legacy = recipeFlowRequirements({ runtime_capabilities: ['browser'] });
  assert.deepEqual(
    resolveRecipeProofRequirements({ required: legacy, owner, plan }).missingRequirements,
    [],
  );
  assert.deepEqual(resolveRecipeProofRequirements({ required: legacy }).missingRequirements, [
    'resource.browser.proof-mode',
  ]);
  const conflict = recipeFlowRequirements(declaration([{ ...proofRequirement, mode: 'mixed' }]));
  assert.match(
    resolveRecipeProofRequirements({ required: conflict, owner, plan }).diagnostics[0],
    /conflicts.*visual/,
  );
  for (const corrupt of [
    { ...plan, ownerRunId: 'other' },
    { ...plan, slotId: 'other' },
    { ...plan, requirements: [retained, retained] },
  ])
    assert.throws(() => resolveRecipeProofRequirements({ required, owner, plan: corrupt }));
  assert.throws(() => resolveRecipeProofRequirements({ required, plan }));
});

test('compatibility displays authored proof mode as declared and refuses IDs-only first dispatch', () => {
  const scope = {
    project: 'example',
    app: null,
    domain: null,
    adapter: 'web',
    target: '/checkout',
  };
  const result = recipeProjectCompatibility({
    scope,
    registered: true,
    required: recipeFlowRequirements(declaration()),
    resources: [],
  });
  assert.ok(
    result.requirements.some(
      (entry) => entry.name === 'resource.browser.proof-mode.visual' && entry.status === 'declared',
    ),
  );
  assert.deepEqual(result.missingRequirements, ['resource.browser']);
  assert.equal(result.recipeVerified, false);
  const missing = recipeProjectCompatibility({
    scope,
    registered: true,
    required: recipeFlowRequirements({ runtime_capabilities: ['browser'] }),
    resources: [],
  });
  assert.ok(missing.missingRequirements.includes('resource.browser.proof-mode'));
  assert.match(missing.diagnostics![0], /authored state\/visual\/mixed/);
});

test('selected recipe parameters preserve JSON values and require a smoke before execution', () => {
  const params = {
    text: 'true',
    number: 2,
    flag: false,
    value: null,
    items: ['a,b'],
    nested: { x: 'y=z' },
  };
  assert.deepEqual(
    recipeFlowRequirements({ recipe_checks: ['smoke'], recipe_params: JSON.stringify(params) })
      .params,
    params,
  );
  assert.deepEqual(recipeFlowRequirements(null).params, {});
  for (const recipe_params of ['[1]', 'null', '2', '"text"', '{invalid', {}, true]) {
    assert.throws(
      () => recipeFlowRequirements({ recipe_checks: ['smoke'], recipe_params }),
      /recipe_params/,
    );
  }
  for (const metadata of [
    { recipe_params: '{}' },
    { recipe_actions: ['example.read'] },
    { recipe_hud: true },
    { recipe_capture: true },
  ])
    assert.throws(() => recipeFlowRequirements(metadata), /recipe_checks/);
});

const check: RecipeConformanceCheck = {
  id: 'recipe.smoke',
  status: 'pass',
  required: true,
  message: 'Checked',
  evidence: {
    plan: {
      schemaVersion: 1,
      digest: 'recipe',
      executionContextDigest: 'context',
      source: { kind: 'library', trust: 'trusted' },
      nodes: [],
    },
  },
};

test('conformance needs positive evidence for every required check', () => {
  assert.equal(conformanceChecksPass([]), false);
  assert.equal(conformanceChecksPass([{ ...check, required: false }]), false);
  assert.equal(conformanceChecksPass([check]), true);
  for (const status of ['missing', 'skipped', 'unsupported', 'fail'] as const) {
    assert.equal(conformanceChecksPass([check, { ...check, id: 'other', status }]), false);
  }
  assert.equal(conformanceChecksPass([{ ...check, evidence: undefined }]), false);
});

test('live conformance requires retained smoke and authored teardown evidence', () => {
  assert.equal(conformanceChecksPass([check], 'live'), false);
  const live = {
    smokeTarget: 'effect',
    teardownTarget: 'cleanup',
    artifactDir: '/proof',
    artifacts: [{ path: 'trace.json', digest: 'digest' }],
  };
  const withLive = (value: RecipeConformanceLiveEvidence) => ({
    ...check,
    evidence: { ...check.evidence!, live: value },
  });
  assert.equal(conformanceChecksPass([withLive(live)], 'live'), true);
  assert.equal(conformanceChecksPass([withLive({ ...live, artifacts: [] })], 'live'), false);
  assert.equal(conformanceChecksPass([withLive({ ...live, teardownTarget: '' })], 'live'), false);
  const supported: RecipeConformanceCheck[] = ['capture', 'hud'].map((name) => ({
    id: `${name}.support`,
    required: false,
    status: 'pass',
    message: 'supported',
  }));
  assert.equal(conformanceChecksPass([withLive(live), ...supported], 'live'), false);
  const captured = {
    ...live,
    captureRequired: true,
    hudRequired: true,
    captures: ['proof.png'],
    artifacts: [...live.artifacts, { path: 'proof.png', digest: 'image' }],
  };
  assert.equal(conformanceChecksPass([withLive(captured), ...supported], 'live'), true);
  assert.equal(
    conformanceChecksPass([withLive({ ...captured, captures: [] }), ...supported], 'live'),
    false,
  );
  assert.equal(
    conformanceChecksPass(
      [withLive({ ...captured, captures: ['missing.png'] }), ...supported],
      'live',
    ),
    false,
  );
  assert.equal(
    conformanceChecksPass([withLive({ ...captured, hudRequired: false }), ...supported], 'live'),
    true,
  );
  assert.equal(
    conformanceChecksPass(
      [
        withLive({ ...captured, hudRequired: false }),
        ...supported,
        {
          id: 'hud.observation',
          status: 'missing',
          required: false,
          message: 'Warning: HUD is recommended',
        },
      ],
      'live',
    ),
    true,
  );
  assert.equal(
    conformanceChecksPass(
      [withLive({ ...captured, captureRequired: false }), ...supported],
      'live',
    ),
    false,
  );
});
