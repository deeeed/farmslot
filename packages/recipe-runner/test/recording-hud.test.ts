import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { digestRecipeDocument, RECIPE_ACTION_MANIFEST_SCHEMA_URL } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createStandardUiAdapters } from '../src/adapters/ui.js';
import { RecipeExecutionError, RUNTIME_CONNECTION_CLOSED } from '../src/core/failure.js';
import { createRecipeRunner } from '../src/core/runner.js';
import { loneCaptureInterruption } from '../src/recording/capture-helper-interruption.js';

const manifest = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
    'app.hud': {
      description: 'Show progress.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'app.hud', intent: 'Show progress.', next: 'done' }],
    },
  },
};
const recipe = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Recording completion',
  description: 'Completion waits for recording finalization.',
  workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
};

for (const outcome of [
  'complete',
  'interrupted',
  'unmeasured',
  'failed',
  'release-failed',
  'hud-failed',
  'interrupted-hud-closed',
  'interrupted-hud-failed',
  'product-failed-hud-closed',
] as const) {
  test(`completion HUD remains inside the recording boundary: ${outcome}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'record-hud-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const events: string[] = [];
    const interrupted =
      outcome === 'interrupted' ||
      outcome === 'unmeasured' ||
      outcome === 'interrupted-hud-closed' ||
      outcome === 'interrupted-hud-failed' ||
      outcome === 'product-failed-hud-closed';
    const runner = createRecipeRunner({
      actionManifest: manifest,
      defaultSource: { kind: 'project', trust: 'trusted', name: 'test' },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['end'] }),
        ...createStandardUiAdapters({
          actions: ['app.hud'],
          transport: {
            async execute(_action, node) {
              if (node.phase === 'complete') {
                events.push(`hud:${node.status}`);
                if (outcome === 'hud-failed') throw new Error('HUD unavailable');
                if (outcome === 'interrupted-hud-failed')
                  throw new Error('Independent HUD render failure');
                if (
                  outcome === 'interrupted-hud-closed' ||
                  outcome === 'product-failed-hud-closed'
                ) {
                  throw new RecipeExecutionError('environment', 'CDP websocket closed.', {
                    code: RUNTIME_CONNECTION_CLOSED,
                  });
                }
              }
              return {};
            },
          },
        }),
      ],
      recording: {
        admission: {
          async acquire(context) {
            events.push('acquire');
            assert.equal(Object.isFrozen(context.target), true);
            assert.deepEqual(context.target, { kind: 'pid', pid: 123 });
            return {
              key: 'recording/test/pid-123',
              async release() {
                events.push('release');
                if (outcome === 'release-failed') throw new Error('Gateway disconnected.');
              },
            };
          },
        },
        videoRecorder: {
          name: 'test',
          async start(request) {
            events.push('start');
            assert.equal(Object.isFrozen(request.target), true);
            return {
              async stop() {
                events.push('stop');
                if (outcome === 'failed') throw new Error('Recorder finalization failed');
                await writeFile(request.outputPath, 'finalized video');
                return {
                  segments: [
                    {
                      path: request.outputPath.split(/[\\/]/u).at(-1)!,
                      ...(outcome === 'unmeasured'
                        ? { timingUnavailableReason: 'ffprobe unavailable' }
                        : {
                            timing: {
                              framesMs: [0, 33],
                              durationMs: 66,
                              clock: {
                                source: 'measured-fixture',
                                earliestZeroUnixMs: 1000,
                                latestZeroUnixMs: 1001,
                              },
                            },
                          }),
                    },
                  ],
                  ...(interrupted
                    ? {
                        interruption: {
                          frames: outcome === 'unmeasured' ? 0 : 2,
                          mediaTimeMs: outcome === 'unmeasured' ? 0 : 33,
                          cause:
                            outcome === 'unmeasured'
                              ? 'Recorder stopped; timing unavailable'
                              : 'Window closed',
                        },
                      }
                    : {}),
                };
              },
            };
          },
        },
      },
    });
    const result = await runner.run({
      recipeDocument:
        outcome === 'product-failed-hud-closed'
          ? {
              ...recipe,
              workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'fail' } } },
            }
          : recipe,
      projectRoot: root,
      artifactsDir: path.join(root, 'artifacts'),
      recordVideo: { target: { kind: 'pid', pid: 123 } },
    });
    assert.deepEqual(events, [
      'acquire',
      'start',
      `hud:${outcome === 'product-failed-hud-closed' ? 'fail' : 'pass'}`,
      'stop',
      'release',
    ]);
    assert.equal(result.status, outcome === 'complete' ? 'pass' : 'fail');
    if (outcome === 'release-failed') {
      assert.equal(result.claims.recording.status, 'complete');
      assert.equal(
        await readFile(path.join(root, 'artifacts/videos/recipe-run.mp4'), 'utf8'),
        'finalized video',
      );
      const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
      assert.ok(
        trace.some(
          (entry: { error_code?: string; cause_class?: string }) =>
            entry.error_code === 'RECORDING_ADMISSION_RELEASE_FAILED' &&
            entry.cause_class === 'environment',
        ),
      );
    }
    if (outcome === 'interrupted-hud-closed') {
      assert.ok(loneCaptureInterruption(result));
      const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
      assert.equal(
        trace.find((entry: { nodeId: string }) => entry.nodeId === 'recipe-complete:hud')
          .error_code,
        'CAPTURE_INTERRUPTED',
      );
    }
    if (outcome === 'interrupted-hud-failed' || outcome === 'product-failed-hud-closed') {
      assert.equal(loneCaptureInterruption(result), undefined);
    }
    if (outcome === 'unmeasured') {
      const manifest = JSON.parse(await readFile(result.artifactManifestPath, 'utf8'));
      const video = manifest.artifacts.find((entry: { type: string }) => entry.type === 'video');
      assert.equal(video.interruption.frames, 0);
      assert.equal(video.timelineUnavailableReason, 'ffprobe unavailable');
      assert.match(result.captureInterruption?.message ?? '', /timing unavailable/u);
      assert.doesNotMatch(result.captureInterruption?.message ?? '', /0 frames|0\.0 s/u);
    } else if (outcome !== 'failed') {
      const timeline = JSON.parse(
        await readFile(path.join(root, 'artifacts/videos/recipe-run.mp4.timeline.json'), 'utf8'),
      );
      const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
      assert.equal(timeline.traceDigest, digestRecipeDocument(trace));
      if (outcome === 'hud-failed') assert.equal(trace.at(-1).nodeId, 'recipe-complete:hud');
    }
  });
}

for (const outcome of ['start-failed', 'cancelled', 'headless'] as const) {
  test(`recording admission cleanup follows execution ownership: ${outcome}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'record-admission-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const events: string[] = [];
    const controller = new AbortController();
    const runner = createRecipeRunner({
      actionManifest: { ...manifest, actions: { end: manifest.actions.end! } },
      defaultSource: { kind: 'operator', trust: 'trusted' },
      adapters: createStandardCoreAdapters({ actions: ['end'] }),
      recording: {
        admission: {
          async acquire() {
            events.push('acquire');
            return {
              key: 'owned',
              async release() {
                events.push('release');
              },
            };
          },
        },
        videoRecorder: {
          name: 'fixture',
          async start() {
            events.push('start');
            if (outcome === 'start-failed') throw new Error('Recorder unavailable.');
            controller.abort();
            return {
              async stop() {
                events.push('stop');
                return { segments: [] };
              },
            };
          },
        },
      },
    });
    const result = await runner.run({
      recipeDocument: recipe,
      projectRoot: root,
      artifactsDir: path.join(root, 'artifacts'),
      signal: controller.signal,
      ...(outcome === 'headless'
        ? {}
        : { recordVideo: { target: { kind: 'pid' as const, pid: 123 } } }),
    });
    assert.deepEqual(
      events,
      outcome === 'headless'
        ? []
        : outcome === 'start-failed'
          ? ['acquire', 'start', 'release']
          : ['acquire', 'start', 'stop', 'release'],
    );
    assert.equal(result.status, outcome === 'headless' ? 'pass' : 'fail');
    assert.equal(
      result.claims.recording.status,
      outcome === 'headless' ? 'not-required' : 'failed',
    );
  });
}
