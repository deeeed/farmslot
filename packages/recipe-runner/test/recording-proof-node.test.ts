import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EVIDENCE_PADDING_MS,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeArtifactManifestDocument,
  type RecipeRecordingTimelineDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createStandardUiAdapters } from '../src/adapters/ui.js';
import { createRecipeRunner } from '../src/core/runner.js';
import type { RecordingTarget, VideoRecorderStartRequest } from '../src/core/types.js';

const manifest = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
    call: {
      description: 'Run the guard.',
      examples: [{ action: 'call', intent: 'Run the guard', ref: 'guard', next: 'done' }],
    },
    'app.lifecycle': {
      description: 'Restart the app.',
      execution_capabilities: [],
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'app.lifecycle', intent: 'Restart the app', next: 'done' }],
    },
    'state.read': {
      description: 'Read app state.',
      execution_capabilities: [],
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'state.read', intent: 'Read the venue', next: 'done' }],
    },
    assert_output: {
      description: 'Check an earlier output.',
      schema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          stream: { type: 'string' },
          contains: { type: 'string' },
        },
        required: ['source'],
        additionalProperties: false,
      },
      examples: [
        {
          action: 'assert_output',
          intent: 'Check the venue',
          source: 'venue',
          stream: 'provider',
          contains: 'hyperliquid',
          next: 'done',
        },
      ],
    },
    'ui.press': {
      description: 'Tap the app.',
      schema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        additionalProperties: false,
      },
      examples: [
        { action: 'ui.press', intent: 'Open the market', selector: '#open', next: 'done' },
      ],
    },
    'ui.wait_for': {
      description: 'Check the app.',
      schema: {
        type: 'object',
        properties: { selector: { type: 'string' }, text: { type: 'string' } },
        additionalProperties: false,
      },
      examples: [
        {
          action: 'ui.wait_for',
          intent: 'Confirm the market',
          selector: '#market',
          text: 'BTC',
          next: 'done',
        },
      ],
    },
  },
};
// QA-03's shape: claim-less setup, then assertions that prove the claim before the first tap.
const guardNodes = (proves?: string[]) => ({
  restart: { action: 'app.lifecycle', intent: 'Restart the app', next: 'venue' },
  venue: { action: 'state.read', intent: 'Read the selected venue', next: 'gate' },
  gate: {
    action: 'assert_output',
    intent: 'The venue is HyperLiquid',
    source: 'venue',
    stream: 'provider',
    contains: 'hyperliquid',
    ...(proves ? { proves } : {}),
    next: 'open',
  },
  open: { action: 'ui.press', intent: 'Open the market', selector: '#open', next: 'market' },
  market: {
    action: 'ui.wait_for',
    intent: 'The market is shown',
    selector: '#market',
    text: 'BTC',
    ...(proves ? { proves } : {}),
    next: 'done',
  },
  done: { action: 'end', status: 'pass' },
});
const proofTargets = [{ id: 'AC-1', claim: 'The guard runs on the selected venue.' }];
const guard = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Setup before proof',
  description: 'Restart and read state, then prove the venue before any UI action.',
  workflow: { entry: 'restart', nodes: guardNodes() },
};
const flat = {
  ...guard,
  proofTargets,
  workflow: { entry: 'restart', nodes: guardNodes(['AC-1']) },
};
// As in QA-03, the call proves the claim and its first assertion sits inside the called recipe.
const composed = {
  ...guard,
  proofTargets,
  workflow: {
    entry: 'guard',
    nodes: {
      guard: {
        action: 'call',
        intent: 'Run the guard',
        ref: 'guard',
        proves: ['AC-1'],
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    },
  },
};
// The teardown's first node is a UI action, so capture binds there after an early cancel.
const withTeardown = {
  ...guard,
  workflow: {
    entry: 'restart',
    teardown: 'restore',
    nodes: {
      ...guardNodes(),
      restore: {
        action: 'ui.press',
        intent: 'Restore the market',
        selector: '#restore',
        next: 'closed',
      },
      closed: { action: 'end', status: 'pass' },
    },
  },
};

const android: RecordingTarget = { kind: 'android-device', serial: 'emulator-5554' };

async function runFixture(
  t: test.TestContext,
  options: {
    target?: RecordingTarget;
    recipe: object;
    signal?: AbortSignal;
    onRestart?: () => void;
    onCaptureStart?: () => void;
    ready?: () => Promise<void>;
  },
) {
  const target = options.target ?? android;
  const root = await mkdtemp(path.join(os.tmpdir(), 'record-proof-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  await mkdir(path.join(libraryRoot, 'recipes'), { recursive: true });
  await writeFile(path.join(libraryRoot, 'recipes', 'guard.recipe.json'), JSON.stringify(guard));
  const events: string[] = [];
  let captureStartedAt = 0;
  const runner = createRecipeRunner({
    actionManifest: manifest,
    hud: false,
    defaultSource: { kind: 'project', trust: 'trusted', name: 'fixture' },
    adapters: [
      ...createStandardCoreAdapters({ actions: ['end', 'assert_output'] }),
      {
        action: 'app.lifecycle',
        source: { kind: 'bundled', trust: 'trusted', name: 'Fixture app restart' },
        async execute() {
          events.push('restart');
          options.onRestart?.();
          return {};
        },
      },
      {
        action: 'state.read',
        source: { kind: 'bundled', trust: 'trusted', name: 'Fixture state read' },
        async execute() {
          events.push('read');
          return { output: { provider: 'hyperliquid' } };
        },
      },
      ...createStandardUiAdapters({
        actions: ['ui.press', 'ui.wait_for'],
        transport: {
          async execute() {
            events.push('ui');
            return { found: true, text: 'BTC' };
          },
        },
      }),
    ],
    recording: {
      targetProvider: {
        async resolveRecordingTarget() {
          events.push('target');
          return target;
        },
      },
      admission: {
        async acquire(request) {
          assert.deepEqual(request.target, target);
          events.push('acquire');
          return { key: 'fixture-target', async release() {} };
        },
      },
      videoRecorder: {
        name: 'fixture',
        async doctor() {
          events.push('doctor');
          return { ok: true, code: 'ok', message: 'Fixture ready' };
        },
        async start(request: VideoRecorderStartRequest) {
          events.push('start');
          await writeFile(request.outputPath, 'video fixture');
          captureStartedAt = Date.now();
          options.onCaptureStart?.();
          return {
            ...(options.ready ? { ready: options.ready } : {}),
            async stop() {
              events.push('stop');
              const durationMs = Date.now() - captureStartedAt + 1000;
              return {
                segments: [
                  {
                    path: path.basename(request.outputPath),
                    timing: {
                      framesMs: [0, durationMs - 1],
                      durationMs,
                      clock: {
                        source: 'fixture',
                        earliestZeroUnixMs: captureStartedAt,
                        latestZeroUnixMs: captureStartedAt,
                      },
                    },
                  },
                ],
              };
            },
          };
        },
      },
    },
  });
  const result = await runner.run({
    recipeDocument: options.recipe,
    librarySources: [
      {
        name: 'fixture',
        root: libraryRoot,
        provenance: { kind: 'library', trust: 'trusted', name: 'fixture' },
      },
    ],
    projectRoot: root,
    artifactsDir: path.join(root, 'artifacts'),
    recordVideo: { mode: 'full-run' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
  const entries: { nodeId: string; ok: boolean; error_code?: string }[] = Array.isArray(trace)
    ? trace
    : trace.entries;
  return { root, result, events, entries };
}

for (const { target, nested } of [
  { target: android, nested: false },
  { target: { kind: 'pid', pid: 456 }, nested: false },
  { target: android, nested: true },
] satisfies { target: RecordingTarget; nested: boolean }[]) {
  test(`a ${target.kind} recording binds before the first ${nested ? 'called ' : ''}assertion, after setup`, async (t) => {
    const { root, result, events } = await runFixture(t, {
      target,
      recipe: nested ? composed : flat,
    });
    assert.equal(result.status, 'pass');
    // Setup that proves nothing runs before capture. The assertion itself pushes no event,
    // so the timeline below is what tells this rule from binding at the first UI node.
    assert.deepEqual(events, [
      'doctor',
      'restart',
      'read',
      'target',
      'acquire',
      'start',
      'ui',
      'ui',
      'stop',
    ]);
    const artifactManifest: RecipeArtifactManifestDocument = JSON.parse(
      await readFile(result.artifactManifestPath, 'utf8'),
    );
    const video = artifactManifest.artifacts.find((artifact) => artifact.type === 'video');
    assert.ok(video?.timelinePath, 'The run video has a timeline');
    const timeline: RecipeRecordingTimelineDocument = JSON.parse(
      await readFile(path.join(root, 'artifacts', video.timelinePath), 'utf8'),
    );
    const start = (nodeId: string) =>
      timeline.markers.find((marker) => marker.nodeId === `${nested ? 'guard/' : ''}${nodeId}`)
        ?.startRangeMs[0];
    assert.ok(start('restart')! < 0, 'The restart stays before the recording');
    // The timer and the wall clock can differ by a few milliseconds.
    assert.ok(
      start('gate')! >= EVIDENCE_PADDING_MS - 10,
      'The assertion runs one evidence padding after capture starts',
    );
    const claim = result.claims.criteria.find((criterion) => criterion.id === 'AC-1');
    assert.equal(claim?.timing, 'measured');
    assert.equal(claim?.verdict, 'awaiting-review');
  });
}

test('a cancel during setup still lets teardown bind capture and run its first proof node', async (t) => {
  const controller = new AbortController();
  const { result, events, entries } = await runFixture(t, {
    recipe: withTeardown,
    signal: controller.signal,
    onRestart: () => controller.abort('SIGTERM'),
  });
  assert.equal(result.status, 'fail');
  assert.ok(entries.some((entry) => entry.error_code === 'RECIPE_ABORTED'));
  // Teardown runs on a signal the cancel does not reach, lead-in included.
  assert.deepEqual(events, ['doctor', 'restart', 'target', 'acquire', 'start', 'ui', 'stop']);
  assert.equal(entries.find((entry) => entry.nodeId === 'restore')?.ok, true);
  assert.equal(entries.at(-1)?.nodeId, 'closed');
});

test('a cancel during the lead-in stops the run before the first proof node', async (t) => {
  const controller = new AbortController();
  let abortedAt = 0;
  const { result, events, entries } = await runFixture(t, {
    recipe: flat,
    signal: controller.signal,
    onCaptureStart: () =>
      setTimeout(() => {
        abortedAt = Date.now();
        controller.abort('SIGTERM');
      }, 50),
  });
  const settledAfterMs = Date.now() - abortedAt;
  assert.equal(result.status, 'fail');
  assert.equal(entries.find((entry) => entry.error_code === 'RECIPE_ABORTED')?.nodeId, 'gate');
  assert.ok(!events.includes('ui'), 'No proof node runs after the cancel');
  assert.ok(settledAfterMs < EVIDENCE_PADDING_MS, 'The cancel does not wait out the lead-in');
});

test('a proof node waits until a restarting recorder is ready', async (t) => {
  let calls = 0;
  let restartedAt = 0;
  const { result, entries } = await runFixture(t, {
    recipe: flat,
    // The second proof node arrives during a capture restart that takes 300 ms.
    ready: async () => {
      if (++calls !== 2) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
      restartedAt = Date.now();
    },
  });
  assert.equal(result.status, 'pass');
  assert.equal(calls, 3, 'Each proof node asks once: gate, open and market');
  const open = entries.find((entry) => entry.nodeId === 'open') as { startedAt: string };
  assert.ok(Date.parse(open.startedAt) >= restartedAt, 'open starts after the restart is ready');
});

test(
  'a cancel while waiting for ready stops the run before the next proof node',
  { timeout: 5_000 },
  async (t) => {
    const controller = new AbortController();
    let calls = 0;
    let abortedAt = 0;
    const { result, events, entries } = await runFixture(t, {
      recipe: flat,
      signal: controller.signal,
      // The restart before the second proof node never becomes ready; the operator cancels.
      ready: () => {
        if (++calls !== 2) return Promise.resolve();
        setTimeout(() => {
          abortedAt = Date.now();
          controller.abort('SIGTERM');
        }, 50);
        return new Promise<void>(() => {});
      },
    });
    const settledAfterMs = Date.now() - abortedAt;
    assert.equal(result.status, 'fail');
    assert.equal(entries.find((entry) => entry.error_code === 'RECIPE_ABORTED')?.nodeId, 'open');
    assert.ok(!events.includes('ui'), 'No UI node runs after the cancel');
    assert.ok(settledAfterMs < EVIDENCE_PADDING_MS, 'The cancel does not wait for ready');
  },
);
