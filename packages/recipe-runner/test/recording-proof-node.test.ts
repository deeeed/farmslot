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

for (const { target, nested } of [
  { target: { kind: 'android-device', serial: 'emulator-5554' }, nested: false },
  { target: { kind: 'pid', pid: 456 }, nested: false },
  { target: { kind: 'android-device', serial: 'emulator-5554' }, nested: true },
] satisfies { target: RecordingTarget; nested: boolean }[]) {
  test(`a ${target.kind} recording binds before the first ${nested ? 'called ' : ''}assertion, after setup`, async (t) => {
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
            return {
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
      recipeDocument: nested ? composed : flat,
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
