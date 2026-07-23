import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyRecipeParamDefaults,
  digestRecipeDocument,
  RECIPE_PROTOCOL_SCHEMA_URL,
  validateArtifactManifestDocument,
  validateRecipeActionManifestDocument,
  validateRecipeArtifactPackage,
  validateRecipeDocument,
  validateRecipeParams,
  validateRecipeParamsSchema,
  validateRecipeWithManifest,
} from '../../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8')) as unknown;
}

function recipe(
  nodes: Record<string, Record<string, unknown>>,
  options: {
    entry?: string;
    teardown?: string;
    proofTargets?: Array<{ id: string; claim: string }>;
    paramsSchema?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    $schema: RECIPE_PROTOCOL_SCHEMA_URL,
    description: 'Exercise the Recipe Protocol v1 contract.',
    ...(options.paramsSchema ? { paramsSchema: options.paramsSchema } : {}),
    ...(options.proofTargets ? { proofTargets: options.proofTargets } : {}),
    workflow: {
      entry: options.entry ?? Object.keys(nodes)[0],
      nodes,
      ...(options.teardown ? { teardown: options.teardown } : {}),
    },
  };
}

function manifest(
  action = 'demo.read',
  schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
  },
  resultCases?: string[],
): Record<string, unknown> {
  return {
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['end'],
    action_metadata: {},
    custom_actions: [
      {
        name: action,
        description: 'Read deterministic demo state.',
        schema,
        execution_capabilities: [],
        ...(resultCases ? { result_cases: resultCases } : {}),
      },
    ],
  };
}

test('publishes one identical Recipe v1 schema', async () => {
  const packaged = await readFile(
    path.join(repoRoot, 'packages/protocol/schemas/recipe-v1.schema.json'),
    'utf8',
  );
  const docs = await readFile(
    path.join(repoRoot, 'apps/docs/static/schemas/recipe-v1.schema.json'),
    'utf8',
  );
  assert.equal(docs, packaged);
});

test('recipe digests and structured parameter equality stay canonical', () => {
  assert.equal(
    digestRecipeDocument({ b: 2, a: 1 }),
    'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  );

  const schema = {
    type: 'object',
    properties: {
      selection: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          mode: { type: 'string' },
        },
        additionalProperties: false,
        enum: [{ id: 'example', mode: 'active' }],
        default: { mode: 'active', id: 'example' },
      },
    },
    additionalProperties: false,
  };
  assert.equal(validateRecipeParamsSchema(schema).status, 'valid');
  assert.equal(
    validateRecipeParams({ selection: { mode: 'active', id: 'example' } }, schema).status,
    'valid',
  );

  const duplicateEnum = structuredClone(schema);
  duplicateEnum.properties.selection.enum.push({ mode: 'active', id: 'example' });
  assert.equal(validateRecipeParamsSchema(duplicateEnum).status, 'invalid');
});

test('canonical schema leaves action parameter names to the action manifest', async () => {
  const schema = (await readJson('packages/protocol/schemas/recipe-v1.schema.json')) as Record<
    string,
    unknown
  >;
  const definitions = schema.$defs as Record<string, unknown>;
  const actionNode = definitions.actionNode as Record<string, unknown>;
  const properties = actionNode.properties as Record<string, unknown>;
  assert.equal(Object.hasOwn(properties, 'ref'), false);
  assert.equal(Object.hasOwn(properties, 'params'), false);
  assert.equal(Object.hasOwn(properties, 'status'), false);
});

test('validates portable browser and mobile examples against strict manifests', async () => {
  for (const [recipePath, manifestPath] of [
    [
      'docs/examples/recipes/example-browser-perps-v1.recipe.json',
      'docs/examples/recipes/example-browser-v1.action-manifest.json',
    ],
    [
      'docs/examples/recipes/example-mobile-perps-v1.recipe.json',
      'docs/examples/recipes/example-mobile-v1.action-manifest.json',
    ],
  ]) {
    const result = validateRecipeWithManifest(
      await readJson(recipePath),
      await readJson(manifestPath),
      { skipRecipeCallResolution: true },
    );
    assert.equal(result.status, 'valid', `${recipePath}: ${JSON.stringify(result.findings)}`);
  }
});

test('requires the canonical root shape and human intent on every non-terminal node', () => {
  const valid = validateRecipeDocument(
    recipe({
      read: { action: 'demo.read', intent: 'Read the selected account balance.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    }),
    { skipRecipeCallResolution: true },
  );
  assert.equal(valid.status, 'valid');

  for (const invalid of [
    { ...recipe({ done: { action: 'end', status: 'pass' } }), $schema: undefined },
    { ...recipe({ done: { action: 'end', status: 'pass' } }), schema_version: 1 },
    recipe({
      read: { action: 'demo.read', next: 'done' },
      done: { action: 'end', status: 'pass' },
    }),
    recipe({
      read: { action: 'demo.read', intent: 'read', next: 'done' },
      done: { action: 'end', status: 'pass' },
    }),
    recipe({
      read: { action: 'demo.read', intent: 'Perform status for the recipe', next: 'done' },
      done: { action: 'end', status: 'pass' },
    }),
  ]) {
    assert.equal(
      validateRecipeDocument(invalid, { skipRecipeCallResolution: true }).status,
      'invalid',
    );
  }
});

test('rejects ambiguous parameter boundaries and dotted reference names', () => {
  const looseParams = recipe(
    {
      read: { action: 'demo.read', intent: 'Read the selected account balance.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    },
    {
      paramsSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
      },
    },
  );
  assert.ok(
    validateRecipeDocument(looseParams, { skipRecipeCallResolution: true }).findings.some(
      (finding) => finding.code === 'recipe.missing_params_additional_properties',
    ),
  );

  const dottedParam = structuredClone(looseParams);
  (dottedParam.paramsSchema as Record<string, unknown>).additionalProperties = false;
  ((dottedParam.paramsSchema as Record<string, unknown>).properties as Record<string, unknown>)[
    'account.name'
  ] = { type: 'string' };
  assert.ok(
    validateRecipeDocument(dottedParam, { skipRecipeCallResolution: true }).findings.some(
      (finding) => finding.code === 'recipe.invalid_param_name',
    ),
  );

  const dottedNode = recipe({
    'read.balance': {
      action: 'demo.read',
      intent: 'Read the selected account balance.',
      next: 'done',
    },
    done: { action: 'end', status: 'pass' },
  });
  assert.equal(
    validateRecipeDocument(dottedNode, { skipRecipeCallResolution: true }).status,
    'invalid',
  );
});

test('requires UI intent to describe the visible outcome instead of interaction mechanics', () => {
  const valid = validateRecipeDocument(
    recipe({
      buy: {
        action: 'ui.press',
        selector: '[data-testid="buy"]',
        intent: 'Open the purchase path for the selected asset.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    }),
    { skipRecipeCallResolution: true },
  );
  assert.equal(valid.status, 'valid');

  for (const [action, intent] of [
    ['ui.press', 'Press buy.'],
    ['ui.press', 'Click the selector.'],
    ['ui.navigate', 'Navigate with raw extension hash.'],
    ['ui.wait_for', 'Wait for the test id.'],
    ['ui.screenshot', 'Capture a screenshot.'],
  ]) {
    const result = validateRecipeDocument(
      recipe({
        interaction: { action, intent, next: 'done' },
        done: { action: 'end', status: 'pass' },
      }),
      { skipRecipeCallResolution: true },
    );
    assert.equal(result.status, 'invalid', intent);
    assert.ok(result.findings.some((finding) => finding.code === 'workflow.invalid_intent'));
  }
});

test('enforces acyclic, reachable, disjoint main and teardown graphs', () => {
  const valid = validateRecipeDocument(
    recipe(
      {
        read: { action: 'demo.read', intent: 'Read current state.', next: 'done' },
        done: { action: 'end', status: 'pass' },
        restore: { action: 'demo.read', intent: 'Restore the original state.', next: 'restored' },
        restored: { action: 'end', status: 'pass' },
      },
      { teardown: 'restore' },
    ),
    { skipRecipeCallResolution: true },
  );
  assert.equal(valid.status, 'valid');

  const cyclic = validateRecipeDocument(
    recipe({
      one: { action: 'demo.read', intent: 'Read the first state.', next: 'two' },
      two: { action: 'demo.read', intent: 'Read the second state.', next: 'one' },
    }),
    { skipRecipeCallResolution: true },
  );
  assert.ok(cyclic.findings.some((finding) => finding.code === 'workflow.cycle'));

  const shared = validateRecipeDocument(
    recipe(
      {
        read: { action: 'demo.read', intent: 'Read current state.', next: 'done' },
        done: { action: 'end', status: 'pass' },
      },
      { teardown: 'done' },
    ),
    { skipRecipeCallResolution: true },
  );
  assert.ok(shared.findings.some((finding) => finding.code === 'workflow.overlapping_teardown'));
});

test('validates result cases while the recipe owns every destination', () => {
  const branchingRecipe = recipe({
    branch: {
      action: 'demo.branch',
      intent: 'Choose the matching visible state.',
      cases: { match: 'matched' },
      default: 'missing',
    },
    matched: { action: 'end', status: 'pass' },
    missing: { action: 'end', status: 'unknown' },
  });
  assert.equal(
    validateRecipeWithManifest(
      branchingRecipe,
      manifest(
        'demo.branch',
        {
          type: 'object',
          additionalProperties: false,
        },
        ['match'],
      ),
    ).status,
    'valid',
  );
  const invalid = validateRecipeWithManifest(
    branchingRecipe,
    manifest('demo.branch', { type: 'object', additionalProperties: false }, ['ready']),
  );
  assert.ok(invalid.findings.some((finding) => finding.code === 'recipe.action_case_not_declared'));
});

test('enforces strict action schemas while allowing typed runtime references', () => {
  const actionSchema = {
    type: 'object',
    properties: {
      count: { type: 'integer' },
      label: { type: 'string' },
    },
    required: ['count'],
    additionalProperties: false,
  };
  const valid = recipe(
    {
      read: {
        action: 'demo.read',
        intent: 'Read the requested number of entries.',
        count: '{{params.count}}',
        label: 'Account {{params.count}}',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    },
    {
      paramsSchema: {
        type: 'object',
        properties: { count: { type: 'integer', default: 1 } },
        additionalProperties: false,
      },
    },
  );
  assert.equal(
    validateRecipeWithManifest(valid, manifest('demo.read', actionSchema)).status,
    'valid',
  );

  const invalid = structuredClone(valid);
  (invalid.workflow as Record<string, unknown>).nodes = {
    read: {
      action: 'demo.read',
      intent: 'Read the requested number of entries.',
      count: 1,
      guessed: true,
      next: 'done',
    },
    done: { action: 'end', status: 'pass' },
  };
  assert.ok(
    validateRecipeWithManifest(invalid, manifest('demo.read', actionSchema)).findings.some(
      (finding) => finding.code === 'recipe.unknown_param',
    ),
  );
});

test('allows manifest-defined action parameters that share call and terminal field names', () => {
  const document = recipe({
    read: {
      action: 'demo.read',
      intent: 'Read the requested external state.',
      ref: 'account-primary',
      params: { scope: 'selected' },
      status: 'ready',
      next: 'done',
    },
    done: { action: 'end', status: 'pass' },
  });
  const actionManifest = manifest('demo.read', {
    type: 'object',
    properties: {
      ref: { type: 'string' },
      params: { type: 'object', additionalProperties: true },
      status: { type: 'string' },
    },
    required: ['ref', 'params', 'status'],
    additionalProperties: false,
  });
  assert.equal(validateRecipeWithManifest(document, actionManifest).status, 'valid');
});

test('rejects call-only fields and branching transitions outside the call contract', () => {
  const invalid = recipe({
    child: {
      action: 'call',
      intent: 'Reuse the child account check.',
      ref: 'account.check',
      params: {},
      cases: { ready: 'done' },
      default: 'done',
      guessed: true,
    },
    done: { action: 'end', status: 'pass' },
  });
  const result = validateRecipeDocument(invalid, {
    externalRecipeIds: new Set(['account.check']),
  });
  assert.equal(result.status, 'invalid');
  assert.ok(result.findings.some((finding) => finding.code === 'workflow.invalid_call_field'));
});

test('treats call as a protocol node rather than an adapter action', () => {
  const composed = recipe({
    child: {
      action: 'call',
      intent: 'Reuse the shared account check.',
      ref: 'account.check',
      params: {},
      next: 'done',
    },
    done: { action: 'end', status: 'pass' },
  });
  assert.equal(
    validateRecipeWithManifest(composed, manifest(), {
      externalRecipeIds: new Set(['account.check']),
    }).status,
    'valid',
  );
});

test('requires namespaced custom actions, strict schemas, and explicit capabilities', () => {
  assert.equal(validateRecipeActionManifestDocument(manifest()).status, 'valid');
  for (const customAction of [
    { name: 'read', schema: { type: 'object' }, execution_capabilities: [] },
    { name: 'demo.read', execution_capabilities: [] },
    { name: 'demo.read', schema: { type: 'object' } },
  ]) {
    const invalid = {
      runner_protocol_version: 1,
      action_registry_version: 1,
      supported_official_actions: ['end'],
      custom_actions: [customAction],
    };
    assert.equal(validateRecipeActionManifestDocument(invalid).status, 'invalid');
  }

  const duplicatedMetadata = manifest();
  duplicatedMetadata.action_metadata = {
    'demo.read': { description: 'Duplicate custom-action metadata.' },
  };
  assert.equal(validateRecipeActionManifestDocument(duplicatedMetadata).status, 'invalid');
});

test('validates semantic proof targets and node coverage', () => {
  const valid = recipe(
    {
      capture: {
        action: 'demo.read',
        intent: 'Capture the visible account state.',
        proves: ['account-visible'],
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    },
    { proofTargets: [{ id: 'account-visible', claim: 'The selected account is visible.' }] },
  );
  assert.equal(validateRecipeDocument(valid, { skipRecipeCallResolution: true }).status, 'valid');

  const malformed = { ...valid, proofTargets: 42 };
  assert.equal(
    validateRecipeDocument(malformed, { skipRecipeCallResolution: true }).status,
    'invalid',
  );
  const uncovered = { ...valid, proofTargets: [{ id: 'other', claim: 'Another claim.' }] };
  const findings = validateRecipeDocument(uncovered, { skipRecipeCallResolution: true }).findings;
  assert.ok(findings.some((finding) => finding.code === 'recipe.undeclared_proof_target'));
  assert.ok(findings.some((finding) => finding.code === 'recipe.uncovered_proof_target'));
});

test('applies parameter defaults and validates structured values', () => {
  const schema = {
    type: 'object',
    properties: {
      market: { type: 'string', enum: ['ETH', 'BTC'], default: 'ETH' },
      labels: { type: 'array', items: { type: 'string' }, default: ['primary'] },
      selection: {
        type: 'object',
        properties: { count: { type: 'integer', default: 1 } },
        additionalProperties: false,
        default: {},
      },
    },
    additionalProperties: false,
  };
  assert.equal(validateRecipeParamsSchema(schema).status, 'valid');
  assert.deepEqual(applyRecipeParamDefaults({}, schema), {
    market: 'ETH',
    labels: ['primary'],
    selection: { count: 1 },
  });
  assert.equal(validateRecipeParams({ market: 'DOGE' }, schema).status, 'invalid');
});

test('validates artifact manifests and complete packages', () => {
  const document = recipe({ done: { action: 'end', status: 'pass' } });
  const artifactManifest = {
    version: 1,
    runStatus: 'pass',
    artifacts: [
      { path: 'recipe.json', type: 'recipe', label: 'Executed recipe', category: 'system' },
      { path: 'summary.json', type: 'summary', label: 'Run summary', category: 'system' },
      { path: 'trace.json', type: 'trace', label: 'Execution trace', category: 'system' },
    ],
  };
  assert.equal(
    validateArtifactManifestDocument(artifactManifest, { recipe: document }).status,
    'valid',
  );
  const result = validateRecipeArtifactPackage({
    recipe: document,
    manifest: artifactManifest,
    artifactPaths: [
      ...artifactManifest.artifacts.map((entry) => entry.path),
      'artifact-manifest.json',
      'recipe-resolution.json',
    ],
    recipeResolution: {
      schema_version: 1,
      root: { ref: 'root', digest: digestRecipeDocument(document) },
      dependencies: [],
      edges: [],
    },
    resolvedRecipes: {},
  });
  assert.equal(result.status, 'valid', JSON.stringify(result.findings));
});
