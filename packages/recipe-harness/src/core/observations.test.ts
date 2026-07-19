import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { RecipeActionManifestDocument } from '@farmslot/protocol';

import { resolveObserveRefs } from './passive-observations.js';
import { createRecipeRunner as createRawRecipeRunner } from './runner.js';
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

function createRecipeRunner(options: Parameters<typeof createRawRecipeRunner>[0]) {
  return createRawRecipeRunner({
    ...options,
    adapters: options.adapters.map((adapter) => ({
      ...adapter,
      source: adapter.source ?? {
        kind: 'bundled',
        trust: 'trusted',
        name: 'observation test',
      },
    })),
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'observation test' },
  });
}

async function runRecipe(
  pressNode: Record<string, unknown>,
  adapter: ActionAdapter,
  actionManifest: RecipeActionManifestDocument = manifest,
): Promise<{ result: RecipeRunResult; trace: TraceEntry[] }> {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'recipe-observe-'));
  const runner = createRecipeRunner({
    actionManifest,
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
  const { trace } = await runRecipe(
    { observe: false },
    observingAdapter({
      async execute() {
        return { observations: { 'ui.screen': { provider: 'adapter' } } };
      },
    }),
  );
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.equal(press?.observations, undefined);
  assert.equal(press?.observationWarnings, undefined);
});

test('selected observe refs record only requested observers', async () => {
  const { trace } = await runRecipe(
    { observe: ['ui.visible'] },
    observingAdapter({
      async execute() {
        return {
          observations: {
            'ui.screen': { provider: 'adapter' },
            'ui.visible': { provider: 'adapter' },
          },
        };
      },
    }),
  );
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.deepEqual(Object.keys(press?.observations ?? {}), ['ui.visible']);
});

test('does not observe UI actions with unknown terminal status', async () => {
  let observeCalls = 0;
  const { trace } = await runRecipe(
    {},
    observingAdapter({
      async execute() {
        return {
          status: 'unknown',
          observations: { 'ui.screen': { provider: 'adapter' } },
        };
      },
      async observe() {
        observeCalls += 1;
        return {};
      },
    }),
  );
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.equal(observeCalls, 0);
  assert.equal(press?.observations, undefined);
});

test('observe true enables only observers declared by the manifest', async () => {
  const visibleOnlyManifest: RecipeActionManifestDocument = {
    ...manifest,
    observers: manifest.observers.filter((observer) => observer.ref === 'ui.visible'),
  };
  const { trace } = await runRecipe({ observe: true }, observingAdapter(), visibleOnlyManifest);
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
        return {
          status: 'fail',
          observations: { 'ui.screen': { provider: 'adapter' } },
          observationWarnings: [{ ref: 'ui.screen', message: 'adapter warning' }],
        };
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
  assert.equal(trace.find((entry) => entry.nodeId === 'press')?.observationWarnings, undefined);
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

test('deduplicates repeated selected observe refs at runtime', () => {
  const refs = resolveObserveRefs(
    'ui.press',
    { observe: ['ui.visible', 'ui.visible', 'ui.screen', ' '] },
    new Map(),
    ['ui.screen', 'ui.visible'],
  );
  assert.deepEqual(refs, ['ui.visible', 'ui.screen']);
});

test('observe false suppresses adapter observations and warnings', async () => {
  const { trace } = await runRecipe(
    { observe: false },
    observingAdapter({
      async execute() {
        return {
          output: { pressed: true },
          observations: { 'ui.screen': { provider: 'adapter' } },
          observationWarnings: [{ ref: 'ui.screen', message: 'adapter warning' }],
        };
      },
    }),
  );
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.equal(press?.observations, undefined);
  assert.equal(press?.observationWarnings, undefined);
});

test('filters adapter observation warnings to selected observers', async () => {
  const { trace } = await runRecipe(
    { observe: ['ui.visible'] },
    observingAdapter({
      async execute() {
        return {
          output: { pressed: true },
          observationWarnings: [
            { ref: 'ui.screen', message: 'not selected' },
            { ref: 'ui.visible', message: 'selected warning' },
          ],
        };
      },
      async observe(refs) {
        return {
          observations: Object.fromEntries(refs.map((ref) => [ref, { provider: 'test' }])),
        };
      },
    }),
  );
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.deepEqual(press?.observationWarnings, [
    { ref: 'ui.visible', message: 'selected warning' },
  ]);
});

test('expect_observations passes when exact refs are recorded without warnings', async () => {
  const { result, trace } = await runRecipe(
    { expect_observations: ['ui.screen', 'ui.visible'] },
    observingAdapter(),
  );
  assert.equal(result.status, 'pass');
  assert.equal(trace.find((entry) => entry.nodeId === 'press')?.ok, true);
});

test('empty expect_observations passes only when nothing is observed', async () => {
  const { result } = await runRecipe(
    { observe: false, expect_observations: [] },
    observingAdapter(),
  );
  assert.equal(result.status, 'pass');

  const { result: extraResult, trace } = await runRecipe(
    { expect_observations: [] },
    observingAdapter(),
  );
  assert.equal(extraResult.status, 'fail');
  assert.match(
    trace.find((entry) => entry.nodeId === 'press')?.error ?? '',
    /expected observations/iu,
  );
});

test('expect_observations fails on missing refs', async () => {
  const { result, trace } = await runRecipe(
    { observe: ['ui.visible'], expect_observations: ['ui.screen', 'ui.visible'] },
    observingAdapter(),
  );
  assert.equal(result.status, 'fail');
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.equal(press?.ok, false);
  assert.match(press?.error ?? '', /expected observations/iu);
});

test('expect_observations fails when observer warnings are present', async () => {
  const { result, trace } = await runRecipe(
    { expect_observations: ['ui.screen', 'ui.visible'] },
    observingAdapter({
      async observe() {
        throw new Error('observer offline');
      },
    }),
  );
  assert.equal(result.status, 'fail');
  assert.match(trace.find((entry) => entry.nodeId === 'press')?.error ?? '', /observer offline/u);
});

test('failed actions keep their own failure signal instead of expectation errors', async () => {
  const { result, trace } = await runRecipe(
    { expect_observations: ['ui.screen', 'ui.visible'] },
    observingAdapter({
      async execute() {
        return { status: 'fail', output: { pressed: false, reason: 'target missing' } };
      },
    }),
  );
  const press = trace.find((entry) => entry.nodeId === 'press');
  assert.equal(result.status, 'fail');
  assert.equal(press?.ok, true);
  assert.equal(press?.status, 'fail');
  assert.deepEqual(press?.output, { pressed: false, reason: 'target missing' });
  assert.equal(press?.error, undefined);
});

test('enforces expect_observations inside called flows', async () => {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'recipe-observe-expect-flow-'));
  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters: [
      observingAdapter(),
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
        'example.expect': {
          entry: 'press',
          nodes: {
            press: {
              action: 'ui.press',
              intent: 'Exercise flow-level observation expectations',
              observe: ['ui.visible'],
              expect_observations: ['ui.screen', 'ui.visible'],
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
              intent: 'Run the expectation flow',
              ref: 'example.expect',
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
  const flowPress = trace.find((entry) => entry.nodeId === 'flow/press');
  assert.equal(flowPress?.ok, false);
  assert.match(flowPress?.error ?? '', /expected observations/iu);
});

test('does not observe failed UI actions inside called flows', async () => {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'recipe-observe-failed-flow-'));
  let observeCalls = 0;
  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters: [
      observingAdapter({
        async execute() {
          return {
            status: 'fail',
            observations: { 'ui.screen': { provider: 'adapter' } },
            observationWarnings: [{ ref: 'ui.screen', message: 'adapter warning' }],
          };
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
  assert.equal(
    trace.find((entry) => entry.nodeId === 'flow/failed')?.observationWarnings,
    undefined,
  );
});
