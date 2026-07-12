import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  mergeRecipeValidationResults,
  RECIPE_PROTOCOL_SCHEMA_URL,
  type RecipeArtifactManifestDocument,
  recipeProtocolSchemaUrlForVersion,
  validateArtifactManifestDocument,
  validateRecipeActionManifestDocument,
  validateRecipeArtifactPackage,
  validateRecipeDocument,
  validateRecipeWithManifest,
} from '../../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf-8')) as unknown;
}

async function readUtf8(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), 'utf-8');
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const absoluteRoot = path.join(repoRoot, root);
  const output: string[] = [];

  async function visit(relativeDir: string): Promise<void> {
    const entries = await readdir(path.join(absoluteRoot, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        output.push(relativePath.split(path.sep).join('/'));
      }
    }
  }

  await visit('');
  return output.sort();
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label);
}

function readTraceEntries(trace: unknown, label: string): Record<string, unknown>[] {
  const entries = Array.isArray(trace)
    ? trace
    : (() => {
        assertRecord(trace, `${label} trace should be an array or an envelope object`);
        assert.ok(Array.isArray(trace.entries), `${label} trace envelope should include entries`);
        return trace.entries;
      })();

  return entries.map((traceEntry, index) => {
    assertRecord(traceEntry, `${label} trace entry ${index} should be an object`);
    return traceEntry;
  });
}

test('validates video artifact recording metadata', () => {
  const result = validateArtifactManifestDocument({
    version: 1,
    artifacts: [
      {
        path: 'videos/recipe-run.mp4',
        type: 'video',
        record: 'full_run',
        maxFps: 24,
        recorder: {
          name: 'capture-helper',
          version: '0.1.8',
          platform: 'macos',
          target: { selector: 'pid', value: '123' },
        },
      },
    ],
  });
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);

  const invalidResult = validateArtifactManifestDocument({
    version: 1,
    artifacts: [
      {
        path: 'videos/recipe-run.mp4',
        type: 'video',
        record: 42,
        maxFps: 0,
        recorder: { target: { selector: '', value: '' } },
      },
    ],
  });
  assert.equal(invalidResult.status, 'invalid');
  assert.ok(
    invalidResult.findings.some((finding) => finding.code === 'artifact_manifest.invalid_record'),
  );
  assert.ok(
    invalidResult.findings.some((finding) => finding.code === 'artifact_manifest.invalid_max_fps'),
  );
  assert.ok(
    invalidResult.findings.some(
      (finding) => finding.code === 'artifact_manifest.invalid_recorder_target_field',
    ),
  );

  const proofWindowResult = validateArtifactManifestDocument({
    version: 1,
    artifacts: [
      {
        path: 'videos/proof-window.mp4',
        type: 'video',
        record: 'proof_window',
      },
      {
        path: 'videos/proof-window-dash.mp4',
        type: 'video',
        record: 'proof-window',
      },
    ],
  });
  assert.equal(proofWindowResult.status, 'invalid');
  assert.equal(
    proofWindowResult.findings.filter(
      (finding) => finding.code === 'artifact_manifest.invalid_record',
    ).length,
    2,
  );
});

test('validates portable backend and UI v1 example recipes', async () => {
  for (const recipePath of [
    'docs/examples/recipes/backend-command-v1.recipe.json',
    'docs/examples/recipes/ui-live-v1.recipe.json',
  ]) {
    const result = validateRecipeDocument(await readJson(recipePath));
    assert.equal(result.status, 'valid', recipePath);
    assert.deepEqual(result.findings, []);
  }
});

test('publishes the same Recipe v1 JSON Schema in protocol package and docs static', async () => {
  assert.equal(recipeProtocolSchemaUrlForVersion(1), RECIPE_PROTOCOL_SCHEMA_URL);
  assert.equal(
    await readUtf8('packages/protocol/schemas/recipe-v1.schema.json'),
    await readUtf8('apps/docs/static/schemas/recipe-v1.schema.json'),
  );
});

test('validates runner action manifests and rejects undeclared recipe actions', async () => {
  const recipe = await readJson('docs/examples/recipes/backend-command-v1.recipe.json');
  const manifest = await readJson('docs/examples/recipes/farmslot-v1.action-manifest.json');
  const manifestResult = validateRecipeActionManifestDocument(manifest);
  const recipeResult = validateRecipeWithManifest(recipe, manifest);

  assert.equal(manifestResult.status, 'valid');
  assert.deepEqual(manifestResult.findings, []);
  assert.ok(
    manifest.supported_official_actions.includes('app.hud'),
    'farmslot-v1 manifest must declare app.hud for Command Center proof HUD',
  );
  assert.equal(recipeResult.status, 'valid');
  assert.deepEqual(recipeResult.findings, []);

  const restrictedManifest = {
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['end'],
  };
  const restrictedResult = validateRecipeWithManifest(recipe, restrictedManifest);
  assert.equal(restrictedResult.status, 'invalid');
  assert.ok(
    restrictedResult.findings.some(
      (finding) => finding.code === 'recipe.action_not_declared_by_manifest',
    ),
  );
});

test('validates runtime capability declarations in runner action manifests', () => {
  const supportedResult = validateRecipeActionManifestDocument({
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['end'],
    capabilities: [
      {
        capability: 'record.video',
        status: 'supported',
        provider: 'capture-helper',
        platforms: ['macos'],
        modes: ['full_run'],
        artifactTypes: ['video/mp4'],
      },
    ],
  });
  assert.equal(supportedResult.status, 'valid');
  assert.deepEqual(supportedResult.findings, []);

  const invalidResult = validateRecipeActionManifestDocument({
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['end'],
    capabilities: [{ capability: '', status: 'maybe', modes: ['full_run', 42] }],
  });
  assert.equal(invalidResult.status, 'invalid');
  assert.ok(
    invalidResult.findings.some(
      (finding) => finding.code === 'action_manifest.invalid_capability_name',
    ),
  );
  assert.ok(
    invalidResult.findings.some(
      (finding) => finding.code === 'action_manifest.invalid_capability_status',
    ),
  );
  assert.ok(
    invalidResult.findings.some(
      (finding) => finding.code === 'action_manifest.invalid_capability_field',
    ),
  );
});

test('validates observer declarations in runner action manifests', () => {
  const result = validateRecipeActionManifestDocument({
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['ui.press', 'end'],
    observers: [
      {
        ref: 'ui.screen',
        description: 'Current screen digest.',
        default_for: ['ui.press'],
        cost: 'cheap',
        redaction: 'none',
      },
      {
        ref: 'ui.visible',
        description: 'Visible authoring targets.',
        default_for: ['ui.press'],
        cost: 'cheap',
        redaction: 'labels-only',
      },
    ],
  });
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);

  const invalid = validateRecipeActionManifestDocument({
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['end'],
    observers: [{ ref: '', description: '', default_for: ['ui.press'], cost: 42 }],
  });
  assert.equal(invalid.status, 'invalid');
  assert.ok(
    invalid.findings.some((finding) => finding.code === 'action_manifest.invalid_observer_ref'),
  );
  assert.ok(
    invalid.findings.some(
      (finding) => finding.code === 'action_manifest.invalid_observer_default_for',
    ),
  );
});

test('permits node-level observe policy in recipe documents', () => {
  const result = validateRecipeDocument({
    schema_version: 1,
    title: 'Observe policy',
    description: 'Node-level observe is runner-owned passive context.',
    validate: {
      workflow: {
        entry: 'press',
        nodes: {
          press: {
            action: 'ui.press',
            intent: 'Open the visible target for the next authoring step.',
            text: 'Open',
            observe: ['ui.visible'],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);
});

test('rejects recipe observers not declared by the runner manifest', () => {
  const recipe = {
    schema_version: 1,
    validate: {
      workflow: {
        entry: 'press',
        nodes: {
          press: {
            action: 'ui.press',
            intent: 'Open the target.',
            observe: ['ui.visible', 'custom.missing'],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };
  const result = validateRecipeWithManifest(recipe, {
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['ui.press', 'end'],
    observers: [
      {
        ref: 'ui.visible',
        description: 'Visible controls.',
        default_for: ['ui.press'],
        cost: 'cheap',
        redaction: 'labels-only',
      },
    ],
  });

  assert.equal(result.status, 'invalid');
  assert.ok(
    result.findings.some((finding) => finding.code === 'recipe.observer_not_declared_by_manifest'),
  );
});

test('rejects malformed recipe observation policies', () => {
  const result = validateRecipeDocument({
    schema_version: 1,
    validate: {
      workflow: {
        entry: 'press',
        nodes: {
          press: {
            action: 'ui.press',
            intent: 'Open the target.',
            observe: 'ui.visible',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });

  assert.equal(result.status, 'invalid');
  assert.ok(result.findings.some((finding) => finding.code === 'recipe.invalid_observe_policy'));
});

test('rejects duplicate refs in recipe observation policies', () => {
  const result = validateRecipeDocument({
    schema_version: 1,
    validate: {
      workflow: {
        entry: 'press',
        nodes: {
          press: {
            action: 'ui.press',
            intent: 'Open the target.',
            observe: ['ui.visible', 'ui.visible'],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });

  assert.equal(result.status, 'invalid');
  assert.ok(result.findings.some((finding) => finding.code === 'recipe.invalid_observe_policy'));
});

test('ignores action-shaped nested params when validating observation policies', () => {
  const result = validateRecipeDocument({
    schema_version: 1,
    validate: {
      workflow: {
        entry: 'orchestrate',
        nodes: {
          orchestrate: {
            action: 'example.run_plan',
            intent: 'Run a project action whose params embed action-shaped data.',
            plan: {
              steps: [{ action: 'ui.press', observe: 'not-a-policy' }],
              fallback: { action: 'ui.press', expect_observations: 'not-an-array' },
            },
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });

  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);
});

test('permits node-level observation expectations in recipe documents', () => {
  const result = validateRecipeDocument({
    schema_version: 1,
    validate: {
      workflow: {
        entry: 'press',
        nodes: {
          press: {
            action: 'ui.press',
            intent: 'Open the target.',
            expect_observations: ['ui.screen', 'ui.visible'],
            next: 'silent',
          },
          silent: {
            action: 'ui.press',
            intent: 'Open the target without observations.',
            observe: false,
            expect_observations: [],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });

  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);
});

test('rejects malformed or duplicate observation expectations', () => {
  const invalidNodes = [
    { expect_observations: 'ui.visible' },
    { expect_observations: ['ui.visible', 'ui.visible'] },
    { expect_observations: ['ui.visible', 42] },
    { expect_observations: [''] },
  ];
  for (const invalidNode of invalidNodes) {
    const result = validateRecipeDocument({
      schema_version: 1,
      validate: {
        workflow: {
          entry: 'press',
          nodes: {
            press: {
              action: 'ui.press',
              intent: 'Open the target.',
              ...invalidNode,
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    });

    assert.equal(result.status, 'invalid');
    assert.ok(
      result.findings.some((finding) => finding.code === 'recipe.invalid_observation_expectation'),
      `expected invalid_observation_expectation for ${JSON.stringify(invalidNode)}`,
    );
  }
});

test('rejects observation expectations not declared by the runner manifest', () => {
  const recipe = {
    schema_version: 1,
    validate: {
      workflow: {
        entry: 'press',
        nodes: {
          press: {
            action: 'ui.press',
            intent: 'Open the target.',
            expect_observations: ['ui.visible', 'custom.missing'],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };
  const result = validateRecipeWithManifest(recipe, {
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['ui.press', 'end'],
    observers: [
      {
        ref: 'ui.visible',
        description: 'Visible controls.',
        default_for: ['ui.press'],
        cost: 'cheap',
        redaction: 'labels-only',
      },
    ],
  });

  assert.equal(result.status, 'invalid');
  assert.ok(
    result.findings.some((finding) => finding.code === 'recipe.observer_not_declared_by_manifest'),
  );
});

test('validates lifecycle actions against the runner manifest', () => {
  const recipe = {
    schema_version: 1,
    title: 'Lifecycle action validation',
    description: 'Setup/startState/teardown actions must be declared by the runner manifest.',
    startState: { action: 'missing.start_state' },
    validate: {
      workflow: {
        setup: [{ id: 'setup', action: 'missing.setup' }],
        entry: 'done',
        nodes: { done: { action: 'end', status: 'pass' } },
        teardown: [{ id: 'teardown', action: 'missing.teardown' }],
      },
    },
  };

  const result = validateRecipeWithManifest(recipe, {
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['end'],
  });

  assert.equal(result.status, 'invalid');
  assert.equal(
    result.findings.filter((finding) => finding.code === 'recipe.action_not_declared_by_manifest')
      .length,
    3,
  );
});

test('validates workflow preconditions against the runner manifest', () => {
  const recipe = {
    schema_version: 1,
    title: 'Precondition validation',
    description: 'Recipe-level preconditions must be manifest-declared gates.',
    validate: {
      workflow: {
        pre_conditions: [
          'wallet.unlocked',
          { id: 'perps.ready', params: { market: 'BTC' }, required: true },
        ],
        entry: 'done',
        nodes: { done: { action: 'end', status: 'pass' } },
      },
    },
  };

  const validResult = validateRecipeWithManifest(recipe, {
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['end'],
    pre_conditions: [
      { id: 'wallet.unlocked', description: 'Wallet is unlocked.' },
      { id: 'perps.ready', description: 'Perps is ready.' },
    ],
  });
  assert.equal(validResult.status, 'valid');
  assert.deepEqual(validResult.findings, []);

  const invalidResult = validateRecipeWithManifest(recipe, {
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['end'],
    pre_conditions: [{ id: 'wallet.unlocked', description: 'Wallet is unlocked.' }],
  });
  assert.equal(invalidResult.status, 'invalid');
  assert.ok(
    invalidResult.findings.some(
      (finding) => finding.code === 'recipe.precondition_not_declared_by_manifest',
    ),
  );

  const malformedResult = validateRecipeDocument({
    ...recipe,
    validate: {
      workflow: {
        pre_conditions: [{ params: [] }],
        entry: 'done',
        nodes: { done: { action: 'end', status: 'pass' } },
      },
    },
  });
  assert.equal(malformedResult.status, 'invalid');
  assert.ok(
    malformedResult.findings.some(
      (finding) => finding.code === 'workflow.invalid_pre_condition_id',
    ),
  );
});

test('validates typed artifact manifests against recipe node ids and available paths', async () => {
  const recipe = await readJson('docs/examples/recipes/ui-live-v1.recipe.json');
  const manifest = await readJson('docs/examples/recipes/ui-live-v1.artifact-manifest.json');

  const result = validateArtifactManifestDocument(manifest, {
    recipe,
    artifactPaths: [
      'summary.json',
      'trace.json',
      'screenshots/checkout-confirmation.png',
      'logs/browser-console.log',
    ],
  });

  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);
});

test('validates optional runner provenance in typed artifact manifests', async () => {
  const recipe = await readJson('docs/examples/recipes/farmslot/provenance-smoke.recipe.json');
  const manifest = await readJson(
    'docs/examples/recipes/farmslot/artifacts/provenance-smoke/artifact-manifest.json',
  );

  const result = validateArtifactManifestDocument(manifest, {
    recipe,
    artifactPaths: ['summary.json', 'trace.json', 'recipe.json'],
  });

  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);

  for (const { manifest: invalidManifest, expectedPaths } of [
    {
      manifest: { version: 1, provenance: 'runner-a', artifacts: [] },
      expectedPaths: ['provenance'],
    },
    {
      manifest: { version: 1, provenance: { runner: 'runner-a' }, artifacts: [] },
      expectedPaths: ['provenance.runner'],
    },
    {
      manifest: { version: 1, provenance: { runner: { source: '' } }, artifacts: [] },
      expectedPaths: ['provenance.runner.source', 'provenance.runner.git_ref'],
    },
    {
      manifest: {
        version: 1,
        provenance: { runner: { source: 'runner-a', git_ref: 'abc123', name: 1 } },
        artifacts: [],
      },
      expectedPaths: ['provenance.runner.name'],
    },
    {
      manifest: {
        version: 1,
        provenance: { runner: { source: 'runner-a', git_ref: 'abc123', version: 1 } },
        artifacts: [],
      },
      expectedPaths: ['provenance.runner.version'],
    },
  ]) {
    const invalidResult = validateArtifactManifestDocument(invalidManifest, { recipe });

    assert.equal(invalidResult.status, 'invalid');
    for (const expectedPath of expectedPaths) {
      assert.ok(
        invalidResult.findings.some((finding) => finding.path === expectedPath),
        `expected finding for ${expectedPath}`,
      );
    }
  }
});

test('validates Example App v1 example recipes and artifact manifests', async () => {
  for (const { recipePath, manifestPath, artifactPaths } of [
    {
      recipePath: 'docs/examples/recipes/example-mobile-perps-v1.recipe.json',
      manifestPath: 'docs/examples/recipes/example-mobile-perps-v1.artifact-manifest.json',
      artifactPaths: [
        'screenshots/mobile-perps-market.png',
        'recipe-issues-review.md',
        'reports/mobile-state.json',
      ],
    },
    {
      recipePath: 'docs/examples/recipes/example-browser-perps-v1.recipe.json',
      manifestPath: 'docs/examples/recipes/example-browser-perps-v1.artifact-manifest.json',
      artifactPaths: ['screenshots/extension-perps-market.png', 'recipe-issues.json'],
    },
  ]) {
    const recipe = await readJson(recipePath);
    const manifest = await readJson(manifestPath);
    const recipeResult = validateRecipeDocument(recipe);
    const manifestResult = validateArtifactManifestDocument(manifest, {
      recipe,
      artifactPaths,
    });

    assert.equal(recipeResult.status, 'valid', recipePath);
    assert.deepEqual(recipeResult.findings, []);
    assert.equal(manifestResult.status, 'valid', manifestPath);
    assert.deepEqual(manifestResult.findings, []);
  }
});

test('validates Farmslot self-validation recipe packages', async () => {
  const suite = await readJson('docs/examples/recipes/farmslot/self-validation-suite.json');
  assertRecord(suite, 'self-validation suite should be an object');
  assert.equal(suite.schema_version, 1);
  const suiteDescription = suite.description;
  assert.ok(typeof suiteDescription === 'string');
  assert.match(suiteDescription, /Generic Recipe Protocol v1/);
  assert.ok(Array.isArray(suite.recipes));

  const recipes = suite.recipes as unknown[];
  assert.deepEqual(
    recipes.map((entry) => {
      assertRecord(entry, 'suite recipe entry should be an object');
      return entry.id;
    }),
    [
      'command-center-ui',
      'gateway-rpc-api',
      'provenance-smoke',
      'mobile-companion',
      'recipe-player-e2e',
      'documentation-onboarding',
      'demo-red-banner',
    ],
  );
  assert.deepEqual(
    recipes.map((entry) => {
      assertRecord(entry, 'suite recipe entry should be an object');
      return entry.surface;
    }),
    [
      'command-center-web-ui',
      'gateway-rpc-api',
      'runner-provenance',
      'mobile-companion',
      'recipe-player-e2e',
      'documentation-onboarding',
      'command-center-web-ui',
    ],
  );

  for (const entry of recipes) {
    assertRecord(entry, 'suite recipe entry should be an object');
    assert.equal(typeof entry.recipe, 'string');
    assert.equal(typeof entry.artifactDir, 'string');

    const recipePath = `docs/examples/recipes/farmslot/${entry.recipe}`;
    const artifactDir = `docs/examples/recipes/farmslot/${entry.artifactDir}`;
    const recipe = await readJson(recipePath);
    const resolvedRecipe = await readJson(`${artifactDir}/recipe.json`);
    const manifest = await readJson(`${artifactDir}/artifact-manifest.json`);
    const summary = await readJson(`${artifactDir}/summary.json`);
    const trace = await readJson(`${artifactDir}/trace.json`);
    const artifactPaths = await listRelativeFiles(artifactDir);
    assertRecord(manifest, `${entry.id} artifact manifest should be an object`);
    assert.ok(Array.isArray(manifest.artifacts));
    assertRecord(summary, `${entry.id} summary should be an object`);
    const traceRecords = readTraceEntries(trace, String(entry.id));
    const artifactTypes = new Set(
      (manifest.artifacts as unknown[]).map((artifact) => {
        assertRecord(artifact, `${entry.id} manifest artifact should be an object`);
        return artifact.type;
      }),
    );

    assert.deepEqual(resolvedRecipe, recipe, `${entry.id} should copy the executed recipe`);
    for (const requiredPath of [
      'summary.json',
      'trace.json',
      'artifact-manifest.json',
      'recipe.json',
    ]) {
      assert.ok(artifactPaths.includes(requiredPath), `${entry.id} should include ${requiredPath}`);
    }
    if (
      entry.surface === 'command-center-web-ui' ||
      entry.surface === 'mobile-companion' ||
      entry.surface === 'recipe-player-e2e'
    ) {
      assert.ok(artifactTypes.has('screenshot'), `${entry.id} should include visual evidence`);
    }
    assert.equal(
      summary.status,
      manifest.runStatus,
      `${entry.id} summary status should match manifest`,
    );
    assert.equal(
      summary.passed,
      traceRecords.filter((traceEntry) => traceEntry.ok === true).length,
      `${entry.id} summary passed count should match trace`,
    );
    assert.equal(
      summary.failed,
      traceRecords.filter((traceEntry) => traceEntry.ok === false).length,
      `${entry.id} summary failed count should match trace`,
    );

    if (entry.id === 'provenance-smoke') {
      assertRecord(trace, 'provenance-smoke trace should use the provenance envelope');
      const typedManifest = manifest as RecipeArtifactManifestDocument;
      assert.deepEqual(
        (trace.metadata as { runner?: unknown } | undefined)?.runner,
        summary.runner,
        'provenance-smoke trace metadata should match summary runner provenance',
      );
      assert.deepEqual(
        typedManifest.provenance?.runner,
        summary.runner,
        'provenance-smoke manifest provenance should match summary runner provenance',
      );
    }

    const result = mergeRecipeValidationResults([
      validateRecipeDocument(recipe),
      validateRecipeArtifactPackage({ recipe, manifest, artifactPaths }),
    ]);

    assert.equal(result.status, 'valid', `${entry.id}: ${JSON.stringify(result.findings)}`);
    assert.deepEqual(result.findings, []);
  }
});

test('rejects recipe documents without the v1 schema marker', () => {
  const result = validateRecipeDocument({
    title: 'Legacy graph without schema marker',
    validate: {
      workflow: {
        entry: 'run',
        nodes: {
          run: {
            action: 'command',
            intent: 'Run the legacy command before completion',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });

  assert.equal(result.status, 'invalid');
  assert.equal(result.summary.errors, 1);
  assert.ok(result.findings.some((finding) => finding.code === 'recipe.missing_schema_version'));
});

test('accepts v1 recipes without top-level title or description when nodes declare intent', () => {
  const recipe = {
    $schema: RECIPE_PROTOCOL_SCHEMA_URL,
    schema_version: 1,
    validate: {
      workflow: {
        entry: 'run',
        nodes: {
          run: {
            action: 'command',
            intent: 'Run the smoke command before completing the recipe',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };
  const result = validateRecipeDocument(recipe, { requireSchemaRef: true });

  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);
});

test('strict recipe validation requires schema ref to match schema_version', () => {
  const withoutRef = validateRecipeDocument(
    {
      schema_version: 1,
      validate: {
        workflow: {
          entry: 'done',
          nodes: { done: { action: 'end', status: 'pass' } },
        },
      },
    },
    { requireSchemaRef: true },
  );
  assert.equal(withoutRef.status, 'invalid');
  assert.ok(withoutRef.findings.some((finding) => finding.code === 'recipe.missing_schema_ref'));

  const mismatch = validateRecipeDocument(
    {
      $schema: 'https://farmslot.io/schemas/recipe-v2.schema.json',
      schema_version: 1,
      validate: {
        workflow: {
          entry: 'done',
          nodes: { done: { action: 'end', status: 'pass' } },
        },
      },
    },
    { requireSchemaRef: true },
  );
  assert.equal(mismatch.status, 'invalid');
  assert.ok(mismatch.findings.some((finding) => finding.code === 'recipe.unsupported_schema_ref'));
});

test('rejects missing and generic non-terminal node intent', () => {
  const missing = validateRecipeDocument({
    schema_version: 1,
    validate: {
      workflow: {
        entry: 'run',
        nodes: {
          run: { action: 'command', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });
  const generic = validateRecipeDocument({
    schema_version: 1,
    validate: {
      workflow: {
        entry: 'run',
        nodes: {
          run: { action: 'command', intent: 'run', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });

  assert.equal(missing.status, 'invalid');
  assert.ok(missing.findings.some((finding) => finding.code === 'workflow.invalid_intent'));
  assert.equal(generic.status, 'invalid');
  assert.ok(generic.findings.some((finding) => finding.code === 'workflow.invalid_intent'));
});

test('rejects missing transition targets and malformed playback metadata', () => {
  const result = validateRecipeDocument({
    schema_version: 1,
    title: 'Broken graph',
    description: 'Demonstrates structural failures.',
    validate: {
      workflow: {
        entry: 'run',
        nodes: {
          run: { action: 'command', next: 'missing' },
          done: { action: 'end', status: 'pass' },
        },
        playback: { mode: 'auto', slow_ms: 99 },
      },
    },
  });

  assert.equal(result.status, 'invalid');
  assert.ok(result.findings.some((finding) => finding.code === 'workflow.missing_target'));
  assert.ok(result.findings.some((finding) => finding.code === 'workflow.no_reachable_terminal'));
  assert.ok(
    result.findings.some((finding) => finding.code === 'workflow.invalid_playback_slow_ms'),
  );
  assert.ok(result.findings.some((finding) => finding.code === 'workflow.unreachable_node'));
});

test('rejects unresolved call refs and lifecycle transitions', () => {
  const unresolvedCall = validateRecipeDocument({
    schema_version: 1,
    title: 'Unresolved call',
    description: 'Call refs need inline flows or uses catalogs.',
    validate: {
      workflow: {
        entry: 'call-flow',
        nodes: {
          'call-flow': { action: 'call', ref: 'missing.flow', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });
  const lifecycleTransition = validateRecipeDocument({
    schema_version: 1,
    title: 'Lifecycle transition',
    description: 'Lifecycle arrays cannot declare graph transitions.',
    validate: {
      workflow: {
        setup: [{ action: 'wait', ms: 1, next: 'done' }],
        entry: 'done',
        nodes: { done: { action: 'end', status: 'pass' } },
      },
    },
  });

  assert.equal(unresolvedCall.status, 'invalid');
  assert.ok(
    unresolvedCall.findings.some((finding) => finding.code === 'workflow.unresolved_call_ref'),
  );
  assert.equal(lifecycleTransition.status, 'invalid');
  assert.ok(
    lifecycleTransition.findings.some(
      (finding) => finding.code === 'workflow.lifecycle_has_transition',
    ),
  );
});

test('accepts call refs resolvable from declared external flow ids', () => {
  const recipe = {
    schema_version: 1,
    title: 'Library-resolved call',
    description: 'Call refs may resolve from configured recipe library sources.',
    validate: {
      workflow: {
        entry: 'call-flow',
        nodes: {
          'call-flow': {
            action: 'call',
            intent: 'Run a flow resolved from a recipe library source',
            ref: 'library.flow',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };

  const withoutExternal = validateRecipeDocument(recipe);
  assert.equal(withoutExternal.status, 'invalid');
  assert.ok(
    withoutExternal.findings.some((finding) => finding.code === 'workflow.unresolved_call_ref'),
  );

  const withExternal = validateRecipeDocument(recipe, {
    externalFlowIds: new Set(['library.flow']),
  });
  assert.equal(withExternal.status, 'valid');
});

test('artifact package validates recipe envelope-only and resolved recipe in full', () => {
  const authored = {
    schema_version: 1,
    title: 'Composed recipe',
    description: 'Authored recipe whose call.ref resolves from a library at run time.',
    validate: {
      workflow: {
        entry: 'call-flow',
        nodes: {
          'call-flow': {
            action: 'call',
            intent: 'Run a library-resolved flow',
            ref: 'library.flow',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };

  const composed = {
    ...authored,
    flows: {
      'library.flow': {
        entry: 'go',
        nodes: {
          go: { action: 'wait', ms: 1, next: 'inner-done' },
          'inner-done': { action: 'end', status: 'pass' },
        },
      },
    },
  };

  // Passing run, no resolved-recipe.json: the composition is unproven, so recipe.json
  // is validated in full and its unresolved library ref is flagged.
  const unproven = validateRecipeArtifactPackage({ recipe: authored });
  assert.ok(unproven.findings.some((finding) => finding.code === 'workflow.unresolved_call_ref'));

  // Passing run WITH a self-contained resolved-recipe.json: it proves the composition,
  // so recipe.json is envelope-only (no unresolved finding) and the resolved recipe
  // validates clean.
  const proven = validateRecipeArtifactPackage({ recipe: authored, resolvedRecipe: composed });
  assert.ok(!proven.findings.some((finding) => finding.code === 'workflow.unresolved_call_ref'));

  // A resolved-recipe.json that is itself not self-contained is flagged in full.
  const badComposition = validateRecipeArtifactPackage({
    recipe: authored,
    resolvedRecipe: authored,
  });
  assert.ok(
    badComposition.findings.some((finding) => finding.code === 'workflow.unresolved_call_ref'),
  );

  // Failed run: recipe.json stays envelope-only, so a gracefully-failed run with an
  // unresolved library ref is not turned into a rejection.
  const failed = validateRecipeArtifactPackage({ recipe: authored, runPassed: false });
  assert.ok(!failed.findings.some((finding) => finding.code === 'workflow.unresolved_call_ref'));
});

test('artifact package treats uses catalogs as unproven and still checks call shape', () => {
  // A `uses` catalog is not part of the artifact package, so it does not prove the
  // composition: a passing run with `uses` and no resolved-recipe.json is rejected.
  const usesRecipe = {
    schema_version: 1,
    title: 'Uses without resolved',
    description: 'Declares a catalog but ships no resolved-recipe.json.',
    uses: ['flows.json'],
    validate: {
      workflow: {
        entry: 'call-flow',
        nodes: {
          'call-flow': {
            action: 'call',
            intent: 'Call a catalog flow',
            ref: 'trade.seed',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };
  const usesUnproven = validateRecipeArtifactPackage({ recipe: usesRecipe });
  assert.ok(
    usesUnproven.findings.some((finding) => finding.code === 'workflow.unresolved_call_ref'),
  );

  // Envelope-only (resolved present) skips resolution but still checks call shape:
  // a non-object `call.params` is flagged even when resolution is skipped.
  const badShape = {
    schema_version: 1,
    title: 'Bad call params',
    description: 'call.params must be an object.',
    validate: {
      workflow: {
        entry: 'call-flow',
        nodes: {
          'call-flow': {
            action: 'call',
            intent: 'Call with malformed params',
            ref: 'library.flow',
            params: 'not-an-object',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };
  const composedForBadShape = {
    ...badShape,
    flows: {
      'library.flow': {
        entry: 'go',
        nodes: {
          go: { action: 'wait', ms: 1, next: 'inner-done' },
          'inner-done': { action: 'end', status: 'pass' },
        },
      },
    },
  };
  const shapeChecked = validateRecipeArtifactPackage({
    recipe: badShape,
    resolvedRecipe: composedForBadShape,
  });
  assert.ok(
    shapeChecked.findings.some((finding) => finding.code === 'workflow.invalid_call_params'),
  );
});

test('validates inline flow actions, transitions, and cycles', () => {
  const recipe = {
    schema_version: 1,
    title: 'Inline flow validation',
    description: 'Inline flow actions must obey Recipe v1 validation.',
    flows: {
      'example.bad-action': {
        entry: 'run',
        nodes: {
          run: { action: 'custom.missing', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
      'example.bad-transition': {
        entry: 'run',
        nodes: {
          run: { action: 'wait', ms: 1, next: 'missing' },
          done: { action: 'end', status: 'pass' },
        },
      },
      'example.cycle-a': {
        entry: 'call-b',
        nodes: {
          'call-b': { action: 'call', ref: 'example.cycle-b', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
      'example.cycle-b': {
        entry: 'call-a',
        nodes: {
          'call-a': { action: 'call', ref: 'example.cycle-a', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
    validate: {
      workflow: {
        entry: 'call-flow',
        nodes: {
          'call-flow': { action: 'call', ref: 'example.bad-action', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };

  const result = validateRecipeWithManifest(recipe, {
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['call', 'end', 'wait'],
  });

  assert.equal(result.status, 'invalid');
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === 'recipe.action_not_declared_by_manifest' &&
        finding.path === 'flows.example.bad-action.workflow.nodes.run.action',
    ),
  );
  assert.ok(result.findings.some((finding) => finding.code === 'flow.missing_target'));
  assert.ok(result.findings.some((finding) => finding.code === 'flow.no_reachable_terminal'));
  assert.ok(result.findings.some((finding) => finding.code === 'flow.call_cycle'));
});

test('rejects artifact packages without typed manifests', () => {
  const result = validateRecipeArtifactPackage({ artifactPaths: ['summary.json', 'trace.json'] });

  assert.equal(result.status, 'invalid');
  assert.equal(result.summary.errors, 1);
  assert.ok(
    result.findings.some((finding) => finding.code === 'artifact_package.missing_manifest'),
  );
});

test('rejects unsafe artifact manifest paths and unknown node ids', () => {
  const result = validateArtifactManifestDocument(
    {
      version: 1,
      runStatus: 'pass',
      artifacts: [
        { path: '../../src/secret.txt', type: 'log', nodeId: 'not-a-node' },
        { path: '/tmp/screenshot.png', type: 'screenshot' },
      ],
    },
    {
      recipe: {
        schema_version: 1,
        title: 'Recipe',
        description: 'Recipe',
        validate: {
          workflow: {
            entry: 'done',
            nodes: { done: { action: 'end', status: 'pass' } },
          },
        },
      },
    },
  );

  assert.equal(result.status, 'invalid');
  assert.ok(result.findings.some((finding) => finding.code === 'artifact_manifest.unsafe_path'));
  assert.ok(result.findings.some((finding) => finding.code === 'artifact_manifest.unknown_node'));
});

test('rejects enum-shaped arrays instead of stringifying them into valid enum tokens', () => {
  const recipeResult = validateRecipeDocument({
    schema_version: 1,
    title: 'Malformed enums',
    description: 'Enum values must be strings, not arrays that stringify to valid values.',
    validate: {
      workflow: {
        entry: 'done',
        nodes: { done: { action: 'end', status: ['pass'] } },
        playback: { mode: ['auto'], slow_ms: 2000 },
      },
    },
  });
  const manifestResult = validateArtifactManifestDocument({
    version: 1,
    runStatus: ['pass'],
    artifacts: [],
  });

  assert.equal(recipeResult.status, 'invalid');
  assert.ok(
    recipeResult.findings.some((finding) => finding.code === 'workflow.invalid_terminal_status'),
  );
  assert.ok(
    recipeResult.findings.some((finding) => finding.code === 'workflow.invalid_playback_mode'),
  );
  assert.equal(manifestResult.status, 'invalid');
  assert.ok(
    manifestResult.findings.some(
      (finding) => finding.code === 'artifact_manifest.invalid_run_status',
    ),
  );
});

test('uses own-property checks for entry and transition node existence', () => {
  const inheritedEntryResult = validateRecipeDocument({
    schema_version: 1,
    title: 'Inherited entry',
    description: 'Entry must be an own node key.',
    validate: {
      workflow: {
        entry: '__proto__',
        nodes: { done: { action: 'end', status: 'pass' } },
      },
    },
  });
  const inheritedTargetResult = validateRecipeDocument({
    schema_version: 1,
    title: 'Inherited target',
    description: 'Transition targets must be own node keys.',
    validate: {
      workflow: {
        entry: 'run',
        nodes: {
          run: { action: 'command', next: 'constructor' },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });

  assert.equal(inheritedEntryResult.status, 'invalid');
  assert.ok(
    inheritedEntryResult.findings.some((finding) => finding.code === 'workflow.missing_entry_node'),
  );
  assert.equal(inheritedTargetResult.status, 'invalid');
  assert.ok(
    inheritedTargetResult.findings.some((finding) => finding.code === 'workflow.missing_target'),
  );
});

test('preserves own prototype-named node ids when normalizing workflow nodes', () => {
  const result = validateRecipeDocument({
    schema_version: 1,
    title: 'Prototype-named node',
    description: 'Node ids are graph ids, including names that overlap object prototype fields.',
    validate: {
      workflow: {
        entry: '__proto__',
        nodes: { ['__proto__']: { action: 'end', status: 'pass' } },
      },
    },
  });

  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);
});

test('rejects Windows drive-rooted artifact paths as non-relative', () => {
  const result = validateArtifactManifestDocument({
    version: 1,
    runStatus: 'pass',
    artifacts: [
      { path: 'C:/tmp/file.log', type: 'log' },
      { path: 'D:\\tmp\\file.log', type: 'log' },
    ],
  });

  assert.equal(result.status, 'invalid');
  assert.equal(
    result.findings.filter((finding) => finding.code === 'artifact_manifest.unsafe_path').length,
    2,
  );
});

test('merges recipe and artifact package validation results', async () => {
  const recipe = await readJson('docs/examples/recipes/backend-command-v1.recipe.json');
  const manifest = await readJson(
    'docs/examples/recipes/backend-command-v1.artifact-manifest.json',
  );
  const result = mergeRecipeValidationResults([
    validateRecipeDocument(recipe),
    validateRecipeArtifactPackage({
      recipe,
      manifest,
      artifactPaths: [
        'recipe.json',
        'summary.json',
        'trace.json',
        'artifact-manifest.json',
        'reports/api-smoke.json',
        'logs/api-smoke.log',
      ],
    }),
  ]);

  assert.equal(result.status, 'valid');
  assert.deepEqual(result.findings, []);
});
