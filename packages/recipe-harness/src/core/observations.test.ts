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
  supported_official_actions: ['ui.press', 'end', 'call'],
  observers: [
    {
      ref: 'ui.screen',
      description: 'Current test screen.',
      default_for: ['ui.press'],
      cost: 'cheap',
      redaction: 'none',
    },
    {
      ref: 'ui.visible',
      description: 'Current visible test controls.',
      default_for: ['ui.press'],
      cost: 'cheap',
      redaction: 'labels-only',
    },
  ],
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

test('does not observe failed UI actions', async () => {
  let observeCalls = 0;
  const { result, trace } = await runRecipe(
    {},
    observingAdapter({
      async execute() {
        return { status: 'fail' };
      },
      async observe() {
        observeCalls += 1;
        return {};
      },
    }),
  );

  assert.equal(result.status, 'fail');
  assert.equal(observeCalls, 0);
  assert.equal(trace.find((entry) => entry.nodeId === 'press')?.observations, undefined);
});

test('observations do not alter action control flow fields', async () => {
  const { trace } = await runRecipe({}, observingAdapter());
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.equal(press?.next, 'done');
  assert.equal(press?.status, undefined);
  assert.equal(press?.case, undefined);
  assert.equal(press?.artifacts, undefined);
});

test('records node observation policies inside called flows', async () => {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'recipe-observe-flow-'));
  const observedRefs: string[][] = [];
  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters: [
      observingAdapter({
        async execute() {
          return { output: { pressed: true } };
        },
        async observe(refs) {
          observedRefs.push([...refs]);
          return {
            observations: Object.fromEntries(
              refs.map((ref) => [ref, { provider: 'test', name: ref }]),
            ),
          };
        },
      }),
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
      flows: {
        'example.observe': {
          entry: 'default',
          nodes: {
            default: {
              action: 'ui.press',
              intent: 'Exercise the default observation policy',
              next: 'selected',
            },
            selected: {
              action: 'ui.press',
              intent: 'Exercise a selected observation policy',
              observe: ['ui.visible'],
              next: 'disabled',
            },
            disabled: {
              action: 'ui.press',
              intent: 'Exercise the disabled observation policy',
              observe: false,
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
      validate: {
        workflow: {
          entry: 'flow',
          nodes: {
            flow: {
              action: 'call',
              intent: 'Run the observation policy flow',
              ref: 'example.observe',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    },
  });
  const trace = JSON.parse(await readFile(result.tracePath, 'utf-8')) as TraceEntry[];

  assert.equal(result.status, 'pass');
  assert.deepEqual(observedRefs, [['ui.screen', 'ui.visible'], ['ui.visible']]);
  assert.deepEqual(
    Object.keys(trace.find((entry) => entry.nodeId === 'flow/default')?.observations ?? {}),
    ['ui.screen', 'ui.visible'],
  );
  assert.deepEqual(
    Object.keys(trace.find((entry) => entry.nodeId === 'flow/selected')?.observations ?? {}),
    ['ui.visible'],
  );
  assert.equal(trace.find((entry) => entry.nodeId === 'flow/disabled')?.observations, undefined);
});

test('does not observe failed UI actions inside called flows', async () => {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'recipe-observe-failed-flow-'));
  let observeCalls = 0;
  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters: [
      observingAdapter({
        async execute() {
          return { status: 'fail' };
        },
        async observe() {
          observeCalls += 1;
          return {};
        },
      }),
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
      flows: {
        'example.fail': {
          entry: 'failed',
          nodes: {
            failed: {
              action: 'ui.press',
              intent: 'Exercise a failed flow action',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
      validate: {
        workflow: {
          entry: 'flow',
          nodes: {
            flow: {
              action: 'call',
              intent: 'Run the failing observation flow',
              ref: 'example.fail',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    },
  });
  const trace = JSON.parse(await readFile(result.tracePath, 'utf-8')) as TraceEntry[];

  assert.equal(result.status, 'fail');
  assert.equal(observeCalls, 0);
  assert.equal(trace.find((entry) => entry.nodeId === 'flow/failed')?.observations, undefined);
});
