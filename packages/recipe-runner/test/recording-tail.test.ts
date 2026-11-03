import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeRecordingTimelineDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';
import { occurrenceRecordingCoverage } from '../src/evidence/moments.js';

// TAT-4355 f84790b3: the last two assertion ranges overran the original video.
const originalDurationMs = 36_006.667;
const clockBoundMs = 388;
const assertionEnds = [35_842, 36_019, 36_197];
const assertionIds = ['ac1-assert', 'ac1-assert-no-derived', 'ac2-assert'];

for (const continuousSegments of [false, true]) {
  test(`final assertions stay recorded with ${continuousSegments ? 'continuous' : 'rotating'} capture`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'recording-tail-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const zero = Date.UTC(2026, 10, 3);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: zero });
    const lastNodeAt = zero + assertionEnds.at(-1)! - clockBoundMs;
    let reachedLast!: () => void;
    const lastNode = new Promise<void>((resolve) => {
      reachedLast = resolve;
    });
    let stoppedAt: number | undefined;
    let stops = 0;
    const runner = createRecipeRunner({
      hud: false,
      actionManifest: {
        $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
        actions: {
          end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
          'state.assert': {
            schema: { type: 'object', properties: {}, additionalProperties: false },
            execution_capabilities: [],
            description: 'Assert the captured state.',
            examples: [{ action: 'state.assert', intent: 'Check the state.', next: 'done' }],
          },
        },
      },
      defaultSource: { kind: 'project', trust: 'trusted', name: 'timing regression' },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['end'] }),
        {
          action: 'state.assert',
          source: { kind: 'bundled', trust: 'trusted', name: 'Timing fixture' },
          async execute(_node, context) {
            const index = assertionIds.indexOf(context.nodeId);
            assert.ok(index >= 0);
            t.mock.timers.setTime(zero + assertionEnds[index]! - clockBoundMs);
            if (index === assertionIds.length - 1) reachedLast();
            return { output: { matched: true } };
          },
        },
      ],
      recording: {
        targetProvider: { resolveRecordingTarget: async () => ({ kind: 'pid', pid: 123 }) },
        videoRecorder: {
          name: 'timing-fixture',
          continuousSegments,
          async start(request) {
            await writeFile(request.outputPath, 'original video fixture');
            return {
              async stop() {
                stops++;
                stoppedAt = Date.now();
                const durationMs = originalDurationMs + stoppedAt - lastNodeAt;
                return {
                  segments: [
                    {
                      path: path.basename(request.outputPath),
                      timing: {
                        framesMs: [0, durationMs - 1],
                        durationMs,
                        clock: {
                          source: 'recorder-lifetime-bound',
                          earliestZeroUnixMs: zero - clockBoundMs,
                          latestZeroUnixMs: zero,
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
    const pending = runner.run({
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'Keep the real final assertion ranges within the recording.',
        workflow: {
          entry: assertionIds[0],
          nodes: {
            ...Object.fromEntries(
              assertionIds.map((id, index) => [
                id,
                {
                  action: 'state.assert',
                  intent: 'Check the state.',
                  next: assertionIds[index + 1] ?? 'done',
                },
              ]),
            ),
            done: { action: 'end', status: 'pass' },
          },
        },
      },
      projectRoot: root,
      artifactsDir: path.join(root, 'artifacts'),
      recordVideo: { mode: 'full-run' },
    });
    await lastNode;
    // Let the engine finish the final node and reach capture finalization, without real sleeps.
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.equal(stoppedAt, undefined, 'Capture must continue after the last assertion.');
      t.mock.timers.tick(399);
      assert.equal(stoppedAt, undefined, 'The tail must cover the 388 ms clock bound.');
      t.mock.timers.tick(1);
      const result = await pending;
      assert.equal(result.status, 'pass');
      assert.equal(stoppedAt! - lastNodeAt, 400);
      assert.equal(stops, 1);
      const manifest = JSON.parse(await readFile(result.artifactManifestPath, 'utf8'));
      const video = manifest.artifacts.find((entry: { type: string }) => entry.type === 'video');
      const timeline: RecipeRecordingTimelineDocument = JSON.parse(
        await readFile(path.join(root, 'artifacts', video.timelinePath), 'utf8'),
      );
      const markers = timeline.markers.filter((marker) => assertionIds.includes(marker.nodeId));
      assert.deepEqual(
        markers.map((marker) => marker.endRangeMs[1]),
        assertionEnds,
      );
      assert.deepEqual(
        assertionEnds.map((end) => end <= originalDurationMs),
        [true, false, false],
      );
      const segments = [{ videoPath: timeline.videoPath, videoDigest: timeline.videoDigest }];
      const coverage = (durationMs: number) =>
        markers.map(
          (marker) =>
            occurrenceRecordingCoverage(
              marker.traceIndex,
              segments,
              new Map([[timeline.videoPath, { ...timeline, durationMs }]]),
            ).timing,
        );
      assert.deepEqual(coverage(originalDurationMs), [
        'measured',
        'outside-recording',
        'outside-recording',
      ]);
      assert.deepEqual(coverage(timeline.durationMs), ['measured', 'measured', 'measured']);
    } finally {
      t.mock.timers.tick(400);
      await pending;
    }
  });
}
