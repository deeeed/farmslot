import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  applyRecipeParamDefaults,
  digestRecipeDocument,
  OFFICIAL_RECIPE_ACTIONS,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
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
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : [];
  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const sampleValue = (property: Record<string, unknown>): unknown => {
    if (property.default !== undefined) return property.default;
    if (Array.isArray(property.enum) && property.enum.length > 0) return property.enum[0];
    if (property.type === 'integer' || property.type === 'number') return 1;
    if (property.type === 'boolean') return true;
    if (property.type === 'array') return [];
    if (property.type === 'object') return {};
    return 'example';
  };
  const params = Object.fromEntries(
    required.map((name) => [name, sampleValue(properties[name] ?? {})]),
  );
  return {
    $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
    actions: {
      call: {
        description: 'Invoke a named child recipe.',
        examples: [
          {
            action: 'call',
            intent: 'Reuse the shared account check.',
            ref: 'account.check',
            params: {},
            next: 'done',
          },
        ],
      },
      end: {
        description: 'Finish recipe execution.',
        examples: [{ action: 'end', status: 'pass' }],
      },
      [action]: {
        description: 'Read deterministic demo state.',
        schema,
        execution_capabilities: [],
        ...(resultCases ? { result_cases: resultCases } : {}),
        examples: [
          {
            action,
            intent: 'Read deterministic demo state.',
            ...params,
            next: 'done',
          },
        ],
      },
    },
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

test('publishes one identical Action Manifest v1 schema', async () => {
  const packaged = await readFile(
    path.join(repoRoot, 'packages/protocol/schemas/action-manifest-v1.schema.json'),
    'utf8',
  );
  const docs = await readFile(
    path.join(repoRoot, 'apps/docs/static/schemas/action-manifest-v1.schema.json'),
    'utf8',
  );
  assert.equal(docs, packaged);
});

function missingPropertyDescriptions(schema: Record<string, unknown>): string[] {
  const missing: string[] = [];
  const visit = (value: unknown, pathPrefix: string): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (node.properties && typeof node.properties === 'object') {
      for (const [name, property] of Object.entries(node.properties as Record<string, unknown>)) {
        const propertyNode = property as Record<string, unknown>;
        const propertyPath = pathPrefix ? `${pathPrefix}.${name}` : name;
        if (
          typeof propertyNode.$ref !== 'string' &&
          (typeof propertyNode.description !== 'string' ||
            propertyNode.description.trim().length === 0)
        ) {
          missing.push(propertyPath);
        }
        visit(propertyNode, propertyPath);
      }
    }
    if (node.$defs && typeof node.$defs === 'object') {
      for (const [name, definition] of Object.entries(node.$defs as Record<string, unknown>)) {
        visit(definition, `$defs.${name}`);
      }
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      const variants = node[keyword];
      if (!Array.isArray(variants)) continue;
      variants.forEach((variant, index) => visit(variant, `${pathPrefix}.${keyword}[${index}]`));
    }
    visit(node.items, `${pathPrefix}[]`);
  };

  visit(schema, '');
  return missing;
}

test('describes every Recipe and Action Manifest v1 property for editor help', async () => {
  for (const schemaPath of [
    'packages/protocol/schemas/recipe-v1.schema.json',
    'packages/protocol/schemas/action-manifest-v1.schema.json',
  ]) {
    const schema = (await readJson(schemaPath)) as Record<string, unknown>;
    assert.deepEqual(missingPropertyDescriptions(schema), [], schemaPath);
  }
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

test('validates every tracked action manifest and its copyable examples', async () => {
  const publicSchema = await readJson('packages/protocol/schemas/action-manifest-v1.schema.json');
  const validatePublicSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
    publicSchema,
  );
  for (const manifestPath of [
    'apps/companion/scripts/agentic/recipe/action-manifest.json',
    'docs/examples/recipes/example-browser-v1.action-manifest.json',
    'docs/examples/recipes/example-mobile-v1.action-manifest.json',
    'docs/examples/recipes/farmslot-v1.action-manifest.json',
    'packages/expo-recipe/templates/scripts/agentic/recipe/action-manifest.json',
    'packages/expo-recipe/templates/scripts/agentic/recipe/action-manifest.with-bridge.json',
  ]) {
    const document = await readJson(manifestPath);
    assert.equal(
      validatePublicSchema(document),
      true,
      `${manifestPath}: ${JSON.stringify(validatePublicSchema.errors)}`,
    );
    const result = validateRecipeActionManifestDocument(document);
    assert.equal(result.status, 'valid', `${manifestPath}: ${JSON.stringify(result.findings)}`);
  }
});

test('requires the canonical root shape and human intent on every non-terminal node', () => {
  const validRecipe = recipe({
    read: { action: 'demo.read', intent: 'Read the selected account balance.', next: 'done' },
    done: { action: 'end', status: 'pass' },
  });
  const valid = validateRecipeDocument(validRecipe, { skipRecipeCallResolution: true });
  assert.equal(valid.status, 'valid');
  const withoutDescription = structuredClone(validRecipe);
  delete withoutDescription.description;
  assert.equal(
    validateRecipeDocument(withoutDescription, { skipRecipeCallResolution: true }).status,
    'valid',
  );
  const nullDescription = structuredClone(validRecipe);
  nullDescription.description = null;
  assert.equal(
    validateRecipeDocument(nullDescription, { skipRecipeCallResolution: true }).status,
    'invalid',
  );

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

test('keeps visual review relationships out of adapter params and validates their graph', async () => {
  const actionManifest = manifest('ui.capture_surface', {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  });
  const screenshotManifest = manifest('ui.screenshot', {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  });
  Object.assign(
    actionManifest.actions as Record<string, unknown>,
    screenshotManifest.actions as Record<string, unknown>,
  );
  const document = recipe({
    overview: {
      action: 'ui.capture_surface',
      intent: 'Preserve the complete overview for visual feedback.',
      path: 'overview.png',
      next: 'detail',
    },
    detail: {
      action: 'ui.screenshot',
      intent: 'Preserve the complete detail workspace for visual feedback.',
      path: 'detail.png',
      visual_review: {
        parent: 'overview',
        navigation: [{ from: 'overview', kind: 'push' }],
        related: ['overview'],
      },
      next: 'done',
    },
    done: { action: 'end', status: 'pass' },
  });

  assert.equal(validateRecipeWithManifest(document, actionManifest).status, 'valid');
  const publicSchema = (await readJson(
    'packages/protocol/schemas/recipe-v1.schema.json',
  )) as Record<string, unknown>;
  const validatePublicSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
    publicSchema,
  );
  assert.equal(validatePublicSchema(document), true, JSON.stringify(validatePublicSchema.errors));

  const invalidNavigation = structuredClone(document);
  const invalidNavigationNodes = (
    invalidNavigation.workflow as { nodes: Record<string, Record<string, unknown>> }
  ).nodes;
  invalidNavigationNodes.detail.visual_review = {
    parent: 'overview',
    navigation: [{ from: 'overview', kind: 'drawer' }],
  };
  assert.ok(
    validateRecipeWithManifest(invalidNavigation, actionManifest).findings.some(
      (finding) => finding.code === 'workflow.invalid_visual_review_navigation',
    ),
  );

  const cyclic = structuredClone(document);
  const nodes = (cyclic.workflow as { nodes: Record<string, Record<string, unknown>> }).nodes;
  nodes.overview.visual_review = { parent: 'detail' };
  assert.ok(
    validateRecipeWithManifest(cyclic, actionManifest).findings.some(
      (finding) => finding.code === 'workflow.cyclic_visual_review_parent',
    ),
  );

  const missing = structuredClone(document);
  const missingNodes = (
    missing.workflow as {
      nodes: Record<string, Record<string, unknown>>;
    }
  ).nodes;
  missingNodes.detail.visual_review = { parent: 'missing-capture' };
  assert.ok(
    validateRecipeWithManifest(missing, actionManifest).findings.some(
      (finding) => finding.code === 'workflow.missing_visual_review_surface',
    ),
  );

  const unannotatedScreenshotTarget = structuredClone(document);
  const unannotatedNodes = (
    unannotatedScreenshotTarget.workflow as {
      nodes: Record<string, Record<string, unknown>>;
    }
  ).nodes;
  unannotatedNodes.overview.action = 'ui.screenshot';
  assert.ok(
    validateRecipeWithManifest(unannotatedScreenshotTarget, actionManifest).findings.some(
      (finding) => finding.code === 'workflow.missing_visual_review_surface',
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
  for (const [name, customAction] of [
    [
      'read',
      {
        description: 'Read state.',
        schema: { type: 'object', additionalProperties: false },
        execution_capabilities: [],
        examples: [{ action: 'read', intent: 'Read state.', next: 'done' }],
      },
    ],
    [
      'demo.read',
      {
        description: 'Read state.',
        execution_capabilities: [],
        examples: [{ action: 'demo.read', intent: 'Read state.', next: 'done' }],
      },
    ],
    [
      'demo.read',
      {
        description: 'Read state.',
        schema: { type: 'object', additionalProperties: false },
        examples: [{ action: 'demo.read', intent: 'Read state.', next: 'done' }],
      },
    ],
  ]) {
    const invalid = {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: { [name as string]: customAction },
    };
    assert.equal(validateRecipeActionManifestDocument(invalid).status, 'invalid');
  }

  const unknownField = manifest();
  unknownField.owner = 'unused';
  assert.ok(
    validateRecipeActionManifestDocument(unknownField).findings.some(
      (finding) => finding.code === 'action_manifest.unsupported_field',
    ),
  );

  const nullCapabilities = manifest();
  (
    (nullCapabilities.actions as Record<string, Record<string, unknown>>)['demo.read'] as Record<
      string,
      unknown
    >
  ).execution_capabilities = null;
  assert.equal(validateRecipeActionManifestDocument(nullCapabilities).status, 'invalid');

  for (const field of ['schema', 'result_cases'] as const) {
    const nullOptional = manifest();
    (
      (nullOptional.actions as Record<string, Record<string, unknown>>)['demo.read'] as Record<
        string,
        unknown
      >
    )[field] = null;
    assert.equal(validateRecipeActionManifestDocument(nullOptional).status, 'invalid', field);
  }

  const nullObservers = manifest();
  nullObservers.observers = null;
  assert.equal(validateRecipeActionManifestDocument(nullObservers).status, 'invalid');
});

test('manifest examples use only declared result cases', () => {
  const actionManifest = manifest('demo.branch', { type: 'object', additionalProperties: false }, [
    'ready',
  ]);
  const action = (actionManifest.actions as Record<string, Record<string, unknown>>)['demo.branch'];
  action.examples = [
    {
      action: 'demo.branch',
      intent: 'Route from the observed state.',
      cases: { other: 'done' },
      default: 'done',
    },
  ];
  assert.ok(
    validateRecipeActionManifestDocument(actionManifest).findings.some(
      (finding) => finding.code === 'recipe.action_case_not_declared',
    ),
  );
});

test('action-manifest JSON Schema rejects examples the runtime cannot execute', async () => {
  const publicSchema = await readJson('packages/protocol/schemas/action-manifest-v1.schema.json');
  const validatePublicSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
    publicSchema,
  );
  const malformedExamples = [
    {
      action: 'demo.read',
      intent: 'Read the requested state.',
      next: 'done',
      cases: { ready: 'done' },
      default: 'done',
    },
    {
      action: 'call',
      intent: 'Reuse the requested state check.',
      ref: 'state.check',
      cases: { ready: 'done' },
      default: 'done',
    },
    {
      action: 'call',
      intent: 'Reuse the requested state check.',
      ref: 'state.check',
      next: 'done',
      extra: true,
    },
    {
      action: 'call',
      intent: 'Reuse the selected state check.',
      ref: '{{params.child}}',
      next: 'done',
    },
  ];

  for (const example of malformedExamples) {
    const action = example.action;
    const document = {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        [action]: {
          description: 'Exercise an invalid example.',
          ...(action === 'call'
            ? {}
            : {
                schema: { type: 'object', additionalProperties: false },
                execution_capabilities: [],
              }),
          examples: [example],
        },
      },
    };
    assert.equal(validatePublicSchema(document), false, JSON.stringify(example));
    assert.equal(validateRecipeActionManifestDocument(document).status, 'invalid');
  }
});

test('observers apply only to executable action nodes', async () => {
  const publicSchema = await readJson('packages/protocol/schemas/action-manifest-v1.schema.json');
  const validatePublicSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
    publicSchema,
  );
  for (const action of ['call', 'end']) {
    const document = {
      ...manifest(),
      observers: [{ ref: 'ui.screen', default_for: [action] }],
    };
    assert.equal(validatePublicSchema(document), false, action);
    assert.equal(validateRecipeActionManifestDocument(document).status, 'invalid', action);
  }
});

test('runtime rejects optional nulls rejected by Recipe JSON Schema', () => {
  const invalidRecipes = [
    {
      ...recipe({ done: { action: 'end', status: 'pass' } }),
      proofTargets: null,
    },
    {
      ...recipe({ done: { action: 'end', status: 'pass' } }),
      workflow: {
        entry: 'done',
        teardown: null,
        nodes: { done: { action: 'end', status: 'pass' } },
      },
    },
    recipe({
      read: {
        action: 'demo.read',
        intent: 'Read the selected state.',
        proves: null,
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    }),
    recipe({
      branch: {
        action: 'demo.read',
        intent: 'Route from the selected state.',
        cases: { ready: 'done' },
        default: null,
      },
      done: { action: 'end', status: 'pass' },
    }),
    recipe({
      call: {
        action: 'call',
        intent: 'Reuse the shared state check.',
        ref: 'state.check',
        params: null,
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    }),
  ];
  for (const invalid of invalidRecipes) {
    assert.equal(
      validateRecipeDocument(invalid, {
        externalRecipeIds: new Set(['state.check']),
      }).status,
      'invalid',
    );
  }
});

test('parameter schema null handling matches both published JSON Schemas', async () => {
  const recipeSchema = await readJson('packages/protocol/schemas/recipe-v1.schema.json');
  const manifestSchema = await readJson('packages/protocol/schemas/action-manifest-v1.schema.json');
  const validateRecipeSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
    recipeSchema,
  );
  const validateManifestSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
    manifestSchema,
  );
  const invalidSchemas = [
    { type: 'object', additionalProperties: false, properties: null },
    { type: 'object', additionalProperties: false, required: null },
    {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string', description: null } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string', enum: null } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: 'object', additionalProperties: null },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'array', items: null } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string', items: null } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string', properties: null } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string', required: null } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string', additionalProperties: null } },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: 'object', additionalProperties: false, items: null },
      },
    },
  ];

  for (const paramsSchema of invalidSchemas) {
    const recipeDocument = recipe({ done: { action: 'end', status: 'pass' } }, { paramsSchema });
    assert.equal(validateRecipeSchema(recipeDocument), false, JSON.stringify(paramsSchema));
    assert.equal(
      validateRecipeDocument(recipeDocument, { skipRecipeCallResolution: true }).status,
      'invalid',
      JSON.stringify(paramsSchema),
    );

    const actionManifest = manifest('demo.read', paramsSchema);
    assert.equal(validateManifestSchema(actionManifest), false, JSON.stringify(paramsSchema));
    assert.equal(
      validateRecipeActionManifestDocument(actionManifest).status,
      'invalid',
      JSON.stringify(paramsSchema),
    );
  }
});

test('published Recipe JSON Schema and runtime both reject dynamic call refs', async () => {
  const publicSchema = await readJson('packages/protocol/schemas/recipe-v1.schema.json');
  const validatePublicSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
    publicSchema,
  );
  const document = recipe({
    call: {
      action: 'call',
      intent: 'Reuse the selected child recipe.',
      ref: '{{params.child}}',
      next: 'done',
    },
    done: { action: 'end', status: 'pass' },
  });
  assert.equal(validatePublicSchema(document), false);
  assert.ok(
    validateRecipeDocument(document, { skipRecipeCallResolution: true }).findings.some(
      (finding) => finding.code === 'workflow.dynamic_call_ref',
    ),
  );
});

test('action-manifest JSON Schema and runtime validator agree on action names', async () => {
  const schema = (await readJson('packages/protocol/schemas/action-manifest-v1.schema.json')) as {
    properties: {
      actions: {
        properties: Record<string, { $ref: string }>;
        additionalProperties: { $ref: string };
        propertyNames: {
          anyOf: Array<{ enum?: string[]; pattern?: string }>;
        };
      };
    };
    $defs: {
      actionWithSchema: {
        allOf: Array<{ $ref?: string; required?: string[] }>;
      };
      customAction: {
        allOf: Array<{ required?: string[] }>;
      };
      observer: {
        properties: {
          ref: {
            anyOf: Array<{ enum?: string[]; pattern?: string }>;
          };
        };
      };
    };
  };
  assert.deepEqual(Object.keys(schema.properties.actions.properties), [...OFFICIAL_RECIPE_ACTIONS]);
  for (const action of OFFICIAL_RECIPE_ACTIONS) {
    assert.equal(
      schema.properties.actions.properties[action].$ref,
      action === 'call' || action === 'end' ? '#/$defs/action' : '#/$defs/actionWithSchema',
      action,
    );
  }
  assert.deepEqual(
    schema.$defs.actionWithSchema.allOf.flatMap((rule) => rule.required ?? []),
    ['schema'],
  );
  assert.equal(schema.properties.actions.additionalProperties.$ref, '#/$defs/customAction');
  assert.deepEqual(
    schema.$defs.customAction.allOf.flatMap((rule) => rule.required ?? []),
    ['schema', 'execution_capabilities'],
  );
  assert.deepEqual(schema.$defs.observer.properties.ref.anyOf, [
    { enum: ['ui.screen', 'ui.visible'] },
    { pattern: '\\.' },
  ]);
  const rules = schema.properties.actions.propertyNames.anyOf;
  const schemaAccepts = (name: string): boolean =>
    rules.some(
      (rule) =>
        rule.enum?.includes(name) ||
        (rule.pattern !== undefined && new RegExp(rule.pattern, 'u').test(name)),
    );

  for (const name of [
    ...OFFICIAL_RECIPE_ACTIONS,
    'demo.read',
    'demo-read',
    'demo_read',
    'read',
    'UI.read',
    'demo/read',
    '.demo',
    'demo.',
  ]) {
    const example =
      name === 'end'
        ? { action: 'end', status: 'pass' }
        : name === 'call'
          ? {
              action: 'call',
              intent: 'Reuse the shared account check.',
              ref: 'account.check',
              params: {},
              next: 'done',
            }
          : {
              action: name,
              intent: 'Read the requested application state.',
              next: 'done',
            };
    const document = {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        [name]: {
          description: 'Read state.',
          schema: { type: 'object', additionalProperties: false },
          execution_capabilities: [],
          examples: [example],
        },
      },
    };
    assert.equal(
      schemaAccepts(name),
      validateRecipeActionManifestDocument(document).status === 'valid',
      name,
    );
  }
});

test('action-manifest JSON Schema and runtime validator reject invalid parameter schemas', async () => {
  const publicSchema = await readJson('packages/protocol/schemas/action-manifest-v1.schema.json');
  const validatePublicSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
    publicSchema,
  );
  const parameterSchemas = [
    {
      label: 'open root',
      schema: { type: 'object', additionalProperties: true },
    },
    {
      label: 'non-object root',
      schema: { type: 'string', additionalProperties: false },
    },
    {
      label: 'unsupported root keyword',
      schema: { type: 'object', additionalProperties: false, title: 'Unsupported' },
    },
    {
      label: 'malformed nested property',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { market: 'string' },
      },
    },
    {
      label: 'array without items',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { markets: { type: 'array' } },
      },
    },
  ];

  for (const fixture of parameterSchemas) {
    const document = manifest('demo.read', fixture.schema as Record<string, unknown>);
    assert.equal(validatePublicSchema(document), false, `public schema: ${fixture.label}`);
    assert.equal(
      validateRecipeActionManifestDocument(document).status,
      'invalid',
      `runtime: ${fixture.label}`,
    );
  }
});

test('action-manifest runtime validates parameter-schema relationships beyond editor structure', () => {
  const semanticSchemas = [
    {
      type: 'object',
      properties: {},
      required: ['missing'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { market: { type: 'string', enum: [1] } },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { count: { type: 'integer', default: 'one' } },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        selection: {
          type: 'object',
          properties: {},
          required: ['missing'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  ];

  for (const schema of semanticSchemas) {
    assert.equal(
      validateRecipeActionManifestDocument(manifest('demo.read', schema)).status,
      'invalid',
    );
  }
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
    trace: [{ nodeId: 'done', action: 'end', ok: true, artifacts: [] }],
    summary: {
      status: 'pass',
      total: 1,
      passed: 1,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    },
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

test('validates trace failure causes against summary rollups', () => {
  const document = recipe({ done: { action: 'end', status: 'fail' } });
  const manifest = {
    version: 1,
    runStatus: 'fail',
    artifacts: [
      { path: 'recipe.json', type: 'recipe' },
      { path: 'summary.json', type: 'summary' },
      { path: 'trace.json', type: 'trace' },
    ],
  };
  const trace = [{ nodeId: 'done', action: 'end', ok: false, cause_class: 'unknown' }];
  const summary = {
    status: 'fail',
    total: 1,
    passed: 0,
    failed: 1,
    cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 1 },
  };
  const validate = (overrides: { trace?: unknown; summary?: unknown } = {}) =>
    validateRecipeArtifactPackage({
      recipe: document,
      trace: overrides.trace ?? trace,
      summary: overrides.summary ?? summary,
      manifest,
      artifactPaths: [
        'recipe.json',
        'summary.json',
        'trace.json',
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

  assert.equal(validate().status, 'valid');
  assert.equal(validate({ trace: [{ ...trace[0], cause_class: undefined }] }).status, 'invalid');
  assert.equal(
    validate({ trace: [{ ...trace[0], ok: true, cause_class: null }] }).status,
    'invalid',
  );
  assert.equal(validate({ trace: [{ ...trace[0], ok: true }] }).status, 'invalid');
  assert.equal(
    validate({
      summary: {
        ...summary,
        cause_counts: { subject: 1, harness: 0, environment: 0, unknown: 0 },
      },
    }).status,
    'invalid',
  );
  assert.equal(validate({ summary: { ...summary, failed: 0 } }).status, 'invalid');
});

test('rejects invalid traces without relying on retained recipe validation', () => {
  const result = validateRecipeArtifactPackage({
    trace: {},
    summary: {
      status: 'pass',
      total: 0,
      passed: 0,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    },
    manifest: { version: 1, runStatus: 'pass', artifacts: [] },
  });

  assert.equal(result.status, 'invalid');
  assert.equal(
    result.findings.some((finding) => finding.code === 'artifact_package.invalid_trace'),
    true,
  );
});

test('rejects an empty trace even when its summary claims a passing zero-step run', () => {
  const result = validateRecipeArtifactPackage({
    trace: [],
    summary: {
      status: 'pass',
      total: 0,
      passed: 0,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    },
    manifest: { version: 1, runStatus: 'pass', artifacts: [] },
  });

  assert.equal(result.status, 'invalid');
  assert.equal(
    result.findings.some((finding) => finding.code === 'artifact_package.invalid_trace'),
    true,
  );
});

test('rejects retained traces that no longer match their recipe or artifact attribution', () => {
  const document = recipe({
    capture: {
      action: 'ui.screenshot',
      intent: 'Record the rendered account summary for reviewer confirmation.',
      next: 'index-report',
    },
    'index-report': {
      action: 'index_artifacts',
      intent: 'Publish the generated account report for reviewer confirmation.',
      artifacts: ['reports/account.json'],
      next: 'done',
    },
    done: { action: 'end', status: 'pass' },
  });
  const artifactManifest = {
    version: 1,
    runStatus: 'pass',
    artifacts: [
      { path: 'recipe.json', type: 'recipe' },
      { path: 'summary.json', type: 'summary' },
      { path: 'trace.json', type: 'trace' },
      { path: 'screenshots/account.png', type: 'screenshot', nodeId: 'capture' },
      { path: 'reports/account.json', type: 'report', nodeId: 'index-report' },
    ],
  };
  const result = validateRecipeArtifactPackage({
    recipe: document,
    trace: [
      {
        id: 'capture',
        action: 'ui.screenshot',
        ok: true,
        artifacts: ['screenshots/account.png'],
        intent: 'Record the rendered account summary for reviewer confirmation.',
      },
      {
        id: 'index-report',
        action: 'index_artifacts',
        ok: true,
        artifacts: ['screenshots/account.png', 'reports/account.json'],
        intent: 'Publish the screenshot and report.',
      },
      { id: 'done', action: 'end', ok: true, artifacts: [] },
    ],
    summary: {
      status: 'pass',
      total: 3,
      passed: 3,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    },
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
  assert.equal(result.status, 'invalid');
  assert.ok(
    result.findings.some((finding) => finding.code === 'artifact_package.trace_intent_mismatch'),
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.code === 'artifact_package.trace_artifact_node_mismatch',
    ),
  );
});
