import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  OFFICIAL_RECIPE_ACTIONS,
  officialRecipeActionCapabilities,
  RECIPE_PROTOCOL_SCHEMA_URL,
  type RecipeActionManifestDocument,
  validateRecipeWithManifest,
} from '../../src/index.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

async function companionManifest(): Promise<RecipeActionManifestDocument> {
  return JSON.parse(
    await readFile(
      path.join(repoRoot, 'apps/companion/scripts/agentic/recipe/action-manifest.json'),
      'utf8',
    ),
  ) as RecipeActionManifestDocument;
}

function gestureRecipe(nodes: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    $schema: RECIPE_PROTOCOL_SCHEMA_URL,
    description: 'Prove the continuous gesture action contract.',
    workflow: {
      entry: Object.keys(nodes)[0],
      nodes: {
        ...nodes,
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

test('continuous gesture actions use the inherited trust boundary', () => {
  for (const action of ['ui.swipe', 'ui.pan', 'ui.drag', 'ui.long_press'] as const) {
    assert.equal(OFFICIAL_RECIPE_ACTIONS.includes(action), true);
    assert.deepEqual(officialRecipeActionCapabilities(action), [
      'app-mutation',
      'external-mutation',
    ]);
  }
});

test('gesture manifests accept each typed action shape', async () => {
  const manifest = await companionManifest();
  const result = validateRecipeWithManifest(
    gestureRecipe({
      swipe: {
        action: 'ui.swipe',
        intent: 'Reveal later rows in the requested list.',
        target: 'gesture-list',
        direction: 'up',
        distance: 240,
        duration_ms: 300,
        next: 'pan',
      },
      pan: {
        action: 'ui.pan',
        intent: 'Move across the requested surface.',
        target: { x: 20, y: 40 },
        path: [
          { x: 30, y: 0 },
          { x: 60, y: 10 },
        ],
        duration_ms: 400,
        next: 'drag',
      },
      drag: {
        action: 'ui.drag',
        intent: 'Set the requested slider to a new value.',
        target: 'gesture-slider',
        delta: { x: 120, y: 0 },
        duration_ms: 500,
        next: 'hold',
      },
      hold: {
        action: 'ui.long_press',
        intent: 'Open the requested control state.',
        target: 'gesture-hold',
        holdMs: 700,
        next: 'done',
      },
    }),
    manifest,
    { skipRecipeCallResolution: true },
  );
  assert.equal(result.status, 'valid', JSON.stringify(result.findings));
});

test('gesture manifests reject missing duration, empty path, and unknown direction', async () => {
  const manifest = await companionManifest();
  const invalidCases = [
    {
      node: {
        action: 'ui.swipe',
        intent: 'Reveal later rows in the requested list.',
        target: 'gesture-list',
        direction: 'up',
        distance: 200,
        next: 'done',
      },
      code: 'recipe.missing_param',
    },
    {
      node: {
        action: 'ui.pan',
        intent: 'Move across the requested surface.',
        target: 'gesture-surface',
        path: [],
        duration_ms: 300,
        next: 'done',
      },
      code: 'recipe.param_array_too_short',
    },
    {
      node: {
        action: 'ui.swipe',
        intent: 'Reveal later rows in the requested list.',
        target: 'gesture-list',
        direction: 'diagonal',
        distance: 200,
        duration_ms: 300,
        next: 'done',
      },
      code: 'recipe.invalid_param_value_enum',
    },
  ];

  for (const fixture of invalidCases) {
    const result = validateRecipeWithManifest(gestureRecipe({ gesture: fixture.node }), manifest, {
      skipRecipeCallResolution: true,
    });
    assert.equal(result.status, 'invalid', fixture.code);
    assert.ok(
      result.findings.some((finding) => finding.code === fixture.code),
      JSON.stringify(result.findings),
    );
  }
});

test('pan and drag require exactly one motion source', async () => {
  const manifest = await companionManifest();
  for (const action of ['ui.pan', 'ui.drag']) {
    for (const motion of [{}, { path: [{ x: 20, y: 0 }], delta: { x: 20, y: 0 } }]) {
      const result = validateRecipeWithManifest(
        gestureRecipe({
          gesture: {
            action,
            intent: 'Move the requested control to a new state.',
            target: 'gesture-target',
            duration_ms: 300,
            ...motion,
            next: 'done',
          },
        }),
        manifest,
        { skipRecipeCallResolution: true },
      );
      assert.ok(
        result.findings.some((finding) => finding.code === 'recipe.invalid_gesture_motion'),
        JSON.stringify(result.findings),
      );
    }
  }
});

test('gesture adapter declarations drive plan-time support errors', async () => {
  const manifest = await companionManifest();
  const document = gestureRecipe({
    gesture: {
      action: 'ui.pan',
      intent: 'Move across the requested surface.',
      target: 'gesture-surface',
      delta: { x: 20, y: 0 },
      duration_ms: 300,
      next: 'done',
    },
  });

  assert.equal(
    validateRecipeWithManifest(document, manifest, {
      adapter: 'android',
      skipRecipeCallResolution: true,
    }).status,
    'valid',
  );
  const unsupported = validateRecipeWithManifest(document, manifest, {
    adapter: 'web',
    skipRecipeCallResolution: true,
  });
  assert.deepEqual(
    unsupported.findings.filter(
      (finding) => finding.code === 'recipe.action_not_supported_by_adapter',
    ),
    [
      {
        severity: 'error',
        code: 'recipe.action_not_supported_by_adapter',
        path: 'workflow.nodes.gesture.action',
        message:
          'Adapter web does not support recipe action ui.pan. Supporting adapters: android, ios. Next: farmslot recipe run --adapter android <recipe>',
      },
    ],
  );
});

test('gesture adapter declarations reject empty support lists', async () => {
  const manifest = await companionManifest();
  manifest.actions['ui.pan']!.adapters = [];
  const result = validateRecipeWithManifest(
    gestureRecipe({
      gesture: {
        action: 'ui.pan',
        intent: 'Move across the requested surface.',
        target: 'gesture-surface',
        delta: { x: 20, y: 0 },
        duration_ms: 300,
        next: 'done',
      },
    }),
    manifest,
    { adapter: 'android', skipRecipeCallResolution: true },
  );
  assert.ok(result.findings.some((finding) => finding.code === 'action_manifest.invalid_adapters'));
});

test('one target-only companion recipe validates unchanged against every declaring manifest', async () => {
  const recipePath =
    'apps/companion/scripts/agentic/recipe/recipes/continuous-gestures.recipe.json';
  const document = JSON.parse(await readFile(path.join(repoRoot, recipePath), 'utf8')) as Record<
    string,
    unknown
  >;
  const paramsSchema = document.paramsSchema as {
    properties: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(paramsSchema.properties).sort(), [
    'hold_target',
    'list_target',
    'pan_target',
    'slider_target',
  ]);
  assert.doesNotMatch(JSON.stringify(document), /ui\.(?:ios|android|web)[._-]/u);

  for (const manifestPath of [
    'apps/companion/scripts/agentic/recipe/action-manifest.json',
    'packages/expo-recipe/templates/scripts/agentic/recipe/action-manifest.json',
    'packages/expo-recipe/templates/scripts/agentic/recipe/action-manifest.with-bridge.json',
  ]) {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, manifestPath), 'utf8'),
    ) as RecipeActionManifestDocument;
    const result = validateRecipeWithManifest(document, manifest, {
      skipRecipeCallResolution: true,
    });
    assert.equal(result.status, 'valid', `${manifestPath}: ${JSON.stringify(result.findings)}`);
  }
});
