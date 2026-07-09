import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createRecipeRunner } from './runner.js';
import type { ActionAdapter, RecipeRunResult, TraceEntry } from './types.js';

const manifest = {
  runner_protocol_version: 1,
  action_registry_version: 1,
  supported_official_actions: ['ui.press', 'end'],
} as const;

async function runRecipe(
  pressNode: Record<string, unknown>,
  adapter: ActionAdapter,
): Promise<{ result: RecipeRunResult; trace: TraceEntry[] }> {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'recipe-observe-'));
  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters: [
      adapter,
      {
        action: 'end',
        async execute() {
          return { status: 'pass' };
        },
      },
    ],
  });
  const result = await runner.run({
    artifactsDir,
    recipeDocument: {
      schema_version: 1,
      title: 'Observation test',
      description: 'Exercises passive UI observations.',
      validate: {
        workflow: {
          entry: 'press',
          nodes: {
            press: {
              action: 'ui.press',
              intent: 'Open the target to reveal the next authoring surface.',
              next: 'done',
              ...pressNode,
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    },
  });
  const trace = JSON.parse(await readFile(result.tracePath, 'utf-8')) as TraceEntry[];
  return { result, trace };
}

function observingAdapter(overrides: Partial<ActionAdapter> = {}): ActionAdapter {
  return {
    action: 'ui.press',
    async execute() {
      return { output: { pressed: true }, next: 'done' };
    },
    async observe(refs) {
      return {
        observations: Object.fromEntries(
          refs.map((ref) => [
            ref,
            ref === 'ui.visible'
              ? {
                  provider: 'test',
                  items: [{ test_id: 'next', label: 'Next', role: 'button' }],
                  hidden_or_offscreen: [],
                  truncated: false,
                }
              : { provider: 'test', name: 'TestScreen' },
          ]),
        ),
      };
    },
    ...overrides,
  };
}

test('records default ui.screen and ui.visible observations after successful UI actions', async () => {
  const { trace } = await runRecipe({}, observingAdapter());
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.ok(press?.observations?.['ui.screen']);
  assert.ok(press?.observations?.['ui.visible']);
  assert.deepEqual(press.output, { pressed: true });
});

test('observe false disables passive observations', async () => {
  const { trace } = await runRecipe({ observe: false }, observingAdapter());
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.equal(press?.observations, undefined);
  assert.equal(press?.observationWarnings, undefined);
});

test('selected observe refs record only requested observers', async () => {
  const { trace } = await runRecipe({ observe: ['ui.visible'] }, observingAdapter());
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.deepEqual(Object.keys(press?.observations ?? {}), ['ui.visible']);
});

test('observation failures are warnings and do not fail a successful action', async () => {
  const { result, trace } = await runRecipe(
    {},
    observingAdapter({
      async observe() {
        throw new Error('observer offline');
      },
    }),
  );
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.equal(result.status, 'pass');
  assert.equal(press?.ok, true);
  assert.equal(press?.observationWarnings?.length, 2);
  assert.match(press?.observationWarnings?.[0]?.message ?? '', /observer offline/u);
});

test('observations do not alter action control flow fields', async () => {
  const { trace } = await runRecipe({}, observingAdapter());
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.equal(press?.next, 'done');
  assert.equal(press?.status, undefined);
  assert.equal(press?.case, undefined);
  assert.equal(press?.artifacts, undefined);
});
