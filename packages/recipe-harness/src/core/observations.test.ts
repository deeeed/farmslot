import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { RecipeActionManifestDocument } from '@farmslot/protocol';

import { createRecipeRunner } from './runner.js';
import type { ActionAdapter, TraceEntry } from './types.js';

const manifest: RecipeActionManifestDocument = {
  runner_protocol_version: 1,
  action_registry_version: 1,
  supported_official_actions: ['ui.press', 'call', 'end'],
  action_metadata: {
    'ui.press': {
      description: 'Press one visible control.',
      schema: {
        type: 'object',
        properties: { test_id: { type: 'string' } },
        required: ['test_id'],
        additionalProperties: false,
      },
    },
  },
  observers: [
    {
      ref: 'ui.screen',
      description: 'Current screen.',
      default_for: ['ui.press'],
    },
    {
      ref: 'ui.visible',
      description: 'Visible controls.',
      default_for: ['ui.press'],
    },
  ],
};

function document(ref = 'done'): Record<string, unknown> {
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Exercise passive observations.',
    workflow: {
      entry: 'press',
      nodes: {
        press: {
          action: 'ui.press',
          intent: 'Open the requested screen.',
          test_id: 'next',
          next: ref,
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

function adapter(overrides: Partial<ActionAdapter> = {}): ActionAdapter {
  return {
    action: 'ui.press',
    source: { kind: 'bundled', trust: 'trusted', name: 'observation test' },
    async execute() {
      return { output: { pressed: true } };
    },
    async observe(refs) {
      return {
        observations: Object.fromEntries(
          refs.map((ref) => [ref, ref === 'ui.screen' ? { name: 'Home' } : { labels: ['Next'] }]),
        ),
      };
    },
    ...overrides,
  };
}

async function run(
  recipeDocument: Record<string, unknown>,
  pressAdapter = adapter(),
  librarySources?: Parameters<ReturnType<typeof createRecipeRunner>['run']>[0]['librarySources'],
): Promise<{ status: string; trace: TraceEntry[] }> {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'recipe-observations-'));
  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters: [pressAdapter],
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'observation test' },
    hud: false,
  });
  const result = await runner.run({ artifactsDir, recipeDocument, librarySources });
  return {
    status: result.status,
    trace: JSON.parse(await readFile(result.tracePath, 'utf8')) as TraceEntry[],
  };
}

test('default observers enrich successful UI traces without controlling execution', async () => {
  const { status, trace } = await run(document());
  assert.equal(status, 'pass');
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.deepEqual(press?.output, { pressed: true });
  assert.deepEqual(Object.keys(press?.observations ?? {}).sort(), ['ui.screen', 'ui.visible']);
  assert.equal(press?.next, 'done');
});

test('observer failures remain visible warnings and do not fail the action', async () => {
  const { status, trace } = await run(
    document(),
    adapter({
      async observe() {
        throw new Error('observer unavailable');
      },
    }),
  );
  assert.equal(status, 'pass');
  const warnings = trace.find((entry) => entry.nodeId === 'press')?.observationWarnings ?? [];
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((warning) => warning.message === 'observer unavailable'));
});

test('authored observer policy is rejected instead of changing passive diagnostics', async () => {
  const invalid = document();
  const nodes = (invalid.workflow as { nodes: Record<string, Record<string, unknown>> }).nodes;
  nodes.press!.observe = false;
  await assert.rejects(() => run(invalid), /Unknown parameter observe/u);
});

test('called recipes run their own passive observers and expose only the call output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-observation-library-'));
  const recipesDir = path.join(root, 'recipes');
  await mkdir(recipesDir, { recursive: true });
  await writeFile(
    path.join(root, 'library.json'),
    `${JSON.stringify({ schema_version: 1, kind: 'recipe-library', name: 'test' })}\n`,
  );
  await writeFile(path.join(recipesDir, 'child.recipe.json'), `${JSON.stringify(document())}\n`);
  const rootRecipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Call one child recipe.',
    workflow: {
      entry: 'child',
      nodes: {
        child: {
          action: 'call',
          intent: 'Open the child screen.',
          ref: 'child',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const { status, trace } = await run(rootRecipe, adapter(), [
    {
      root,
      provenance: { kind: 'library', trust: 'trusted', name: 'test' },
    },
  ]);
  assert.equal(status, 'pass');
  assert.ok(trace.some((entry) => entry.nodeId === 'child/press' && entry.observations));
  assert.equal(trace.find((entry) => entry.nodeId === 'child')?.observations, undefined);
});
