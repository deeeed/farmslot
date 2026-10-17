import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const recipe = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Setup before proof',
  description: 'Restart and read state, then prove the venue before any UI action.',
  proofTargets: [{ id: 'AC-1', claim: 'The guard runs on the selected venue.' }],
  workflow: {
    entry: 'restart',
    nodes: {
      restart: { action: 'app.lifecycle', intent: 'Restart the app', next: 'venue' },
      venue: { action: 'state.read', intent: 'Read the selected venue', next: 'gate' },
      gate: {
        action: 'assert_output',
        intent: 'The venue is HyperLiquid',
        source: 'venue',
        stream: 'provider',
        contains: 'hyperliquid',
        proves: ['AC-1'],
        next: 'open',
      },
      open: { action: 'ui.press', intent: 'Open the market', selector: '#open', next: 'market' },
      market: {
        action: 'ui.wait_for',
        intent: 'The market is shown',
        selector: '#market',
        text: 'BTC',
        proves: ['AC-1'],
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    },
  },
};

for (const target of [
  { kind: 'android-device', serial: 'emulator-5554' },
  { kind: 'pid', pid: 456 },
] satisfies RecordingTarget[]) {
  test(`a ${target.kind} recording binds before the first assertion, after setup`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'record-proof-node-'));
    t.after(() => rm(root, { recursive: true, force: true }));
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
      recipeDocument: recipe,
      projectRoot: root,
      artifactsDir: path.join(root, 'artifacts'),
      recordVideo: { mode: 'full-run' },
    });
    assert.equal(result.status, 'pass');
    // Setup that proves nothing runs before capture; the assertion is the first proof node.
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
      timeline.markers.find((marker) => marker.nodeId === nodeId)?.startRangeMs[0];
    assert.ok(start('restart')! < 0, 'The restart stays before the recording');
    assert.ok(
      start('gate')! >= EVIDENCE_PADDING_MS,
      'The assertion runs one evidence padding after capture starts',
    );
    const claim = result.claims.criteria.find((criterion) => criterion.id === 'AC-1');
    assert.equal(claim?.timing, 'measured');
    assert.notEqual(claim?.verdict, 'weak');
  });
}
