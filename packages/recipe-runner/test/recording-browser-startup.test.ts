import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeArtifactManifestDocument,
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
      description: 'Call setup and proof.',
      examples: [
        { action: 'call', intent: 'Run browser setup and proof', ref: 'browser', next: 'done' },
      ],
    },
    'app.launch': {
      description: 'Replace the owned browser.',
      execution_capabilities: [],
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'app.launch', intent: 'Launch a fresh owned browser', next: 'ui' }],
    },
    'ui.wait_for': {
      description: 'Check the owned browser.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      examples: [{ action: 'ui.wait_for', intent: 'Confirm the browser is ready', next: 'done' }],
    },
  },
};
const recipe = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Browser setup before proof',
  description: 'Launch the owned browser before recording its UI proof.',
  workflow: {
    entry: 'launch',
    nodes: {
      launch: { action: 'app.launch', intent: 'Launch a fresh owned browser', next: 'ui' },
      ui: {
        action: 'ui.wait_for',
        intent: 'Confirm the replacement browser is ready',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    },
  },
};

for (const { initialPid, composed } of [
  { initialPid: 0, composed: false },
  { initialPid: 123, composed: false },
  { initialPid: 123, composed: true },
]) {
  test(`recording binds after ${composed ? 'called' : 'root'} setup when the initial browser PID is ${initialPid}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'record-browser-setup-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let pid = initialPid;
    let recordedPid = 0;
    let captureReadyAt = 0;
    const events: string[] = [];
    const libraryRoot = path.join(root, 'library');
    if (composed) {
      await mkdir(path.join(libraryRoot, 'recipes'), { recursive: true });
      await writeFile(
        path.join(libraryRoot, 'recipes', 'browser.recipe.json'),
        JSON.stringify(recipe),
      );
    }
    const runner = createRecipeRunner({
      actionManifest: manifest,
      hud: false,
      defaultSource: { kind: 'project', trust: 'trusted', name: 'fixture' },
      adapters: [
        ...createStandardCoreAdapters({ actions: ['end'] }),
        {
          action: 'app.launch',
          source: { kind: 'bundled', trust: 'trusted', name: 'Fixture browser launcher' },
          async execute() {
            events.push('launch');
            pid = 456;
            return {};
          },
        },
        ...createStandardUiAdapters({
          actions: ['ui.wait_for'],
          transport: {
            async execute(_action, _node, context) {
              events.push('ui');
              assert.equal(recordedPid, pid);
              assert.ok(
                context.captureRecordingSnapshot,
                'UI context must see the active recording',
              );
              return {};
            },
          },
        }),
      ],
      recording: {
        targetProvider: {
          async resolveRecordingTarget() {
            events.push('target');
            if (!pid) throw new Error('No owned browser');
            return { kind: 'pid', pid };
          },
        },
        admission: {
          async acquire({ target }) {
            assert.equal(Object.isFrozen(target), true);
            assert.deepEqual(target, { kind: 'pid', pid: 456 });
            events.push('acquire');
            return {
              key: 'fixture-browser',
              async release() {
                events.push('release');
              },
            };
          },
        },
        videoRecorder: {
          name: 'structured-fixture',
          async doctor() {
            events.push('doctor');
            return { ok: true, code: 'ok', message: 'Fixture ready' };
          },
          async start(request: VideoRecorderStartRequest) {
            events.push('start');
            recordedPid = (request.target as Extract<RecordingTarget, { kind: 'pid' }>).pid;
            assert.equal(recordedPid, 456);
            await writeFile(request.outputPath, 'video fixture');
            captureReadyAt = Date.now();
            return {
              async snapshot(output: string) {
                await writeFile(output, 'PNG fixture');
                return { output };
              },
              async stop() {
                events.push('stop');
                return {
                  segments: [
                    {
                      path: path.basename(request.outputPath),
                      timingUnavailableReason: 'Structured recorder fixture',
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
      recipeDocument: composed
        ? {
            ...recipe,
            workflow: {
              entry: 'setup',
              nodes: {
                setup: {
                  action: 'call',
                  intent: 'Run browser setup and proof',
                  ref: 'browser',
                  next: 'setup-ui',
                },
                'setup-ui': {
                  action: 'ui.wait_for',
                  intent: 'Confirm the root browser',
                  next: 'done',
                },
                done: { action: 'end', status: 'pass' },
              },
            },
          }
        : recipe,
      ...(composed
        ? {
            librarySources: [
              {
                name: 'fixture',
                root: libraryRoot,
                provenance: {
                  kind: 'library' as const,
                  trust: 'trusted' as const,
                  name: 'fixture',
                },
              },
            ],
          }
        : {}),
      projectRoot: root,
      artifactsDir: path.join(root, 'artifacts'),
      recordVideo: { mode: 'full-run' },
    });
    assert.equal(result.status, 'pass');
    const artifactManifest: RecipeArtifactManifestDocument = JSON.parse(
      await readFile(result.artifactManifestPath, 'utf8'),
    );
    const stills = artifactManifest.artifacts
      .filter((artifact) => artifact.path.startsWith('stills/'))
      .map((artifact) => artifact.path);
    assert.equal(stills.length, composed ? 2 : 1);
    assert.equal(new Set(stills).size, stills.length, 'Nested and flattened ids cannot collide');
    for (const still of stills) {
      assert.equal(path.dirname(still), 'stills');
      assert.match(path.basename(still), /^[A-Za-z0-9._-]+\.png$/);
      assert.ok(path.basename(still).length < 255);
      assert.equal(await readFile(path.join(root, 'artifacts', still), 'utf8'), 'PNG fixture');
    }
    assert.deepEqual(events, [
      'doctor',
      'launch',
      'target',
      'acquire',
      'start',
      'ui',
      ...(composed ? ['ui'] : []),
      'stop',
      'release',
    ]);
    const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
    const entries = Array.isArray(trace) ? trace : trace.entries;
    assert.ok(
      Date.parse(
        entries.find((entry: { nodeId: string }) => entry.nodeId === (composed ? 'setup/ui' : 'ui'))
          .startedAt,
      ) >= captureReadyAt,
    );
  });
}

test('recorder doctor refusal still precedes setup and its side effects', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'record-doctor-before-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let launched = false;
  const runner = createRecipeRunner({
    actionManifest: manifest,
    hud: false,
    defaultSource: { kind: 'project', trust: 'trusted', name: 'fixture' },
    adapters: [
      ...createStandardCoreAdapters({ actions: ['end'] }),
      {
        action: 'app.launch',
        source: { kind: 'bundled', trust: 'trusted', name: 'Fixture browser launcher' },
        async execute() {
          launched = true;
          return {};
        },
      },
      ...createStandardUiAdapters({
        actions: ['ui.wait_for'],
        transport: {
          async execute() {
            return {};
          },
        },
      }),
    ],
    recording: {
      videoRecorder: {
        name: 'unavailable',
        async doctor() {
          return { ok: false, code: 'permission', message: 'Capture permission missing' };
        },
        async start() {
          throw new Error('Must not start');
        },
      },
    },
  });
  assert.equal(
    (
      await runner.run({
        recipeDocument: recipe,
        projectRoot: root,
        artifactsDir: path.join(root, 'artifacts'),
        recordVideo: { mode: 'full-run' },
      })
    ).status,
    'fail',
  );
  assert.equal(launched, false);
});

test('deferred target refusal records an environment failure before UI execution', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'record-target-after-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events: string[] = [];
  const runner = createRecipeRunner({
    actionManifest: manifest,
    hud: false,
    defaultSource: { kind: 'project', trust: 'trusted', name: 'fixture' },
    adapters: [
      ...createStandardCoreAdapters({ actions: ['end'] }),
      {
        action: 'app.launch',
        source: { kind: 'bundled', trust: 'trusted', name: 'Fixture browser launcher' },
        async execute() {
          events.push('launch');
          return {};
        },
      },
      ...createStandardUiAdapters({
        actions: ['ui.wait_for'],
        transport: {
          async execute() {
            events.push('ui');
            return {};
          },
        },
      }),
    ],
    recording: {
      targetProvider: {
        async resolveRecordingTarget() {
          events.push('target');
          throw new Error('No owned browser after setup');
        },
      },
      videoRecorder: {
        name: 'fixture',
        async start() {
          events.push('start');
          throw new Error('Must not start');
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
  assert.equal(result.status, 'fail');
  assert.deepEqual(events, ['launch', 'target']);
  const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
  const failed = trace.find((entry: { nodeId: string }) => entry.nodeId === 'ui');
  assert.equal(failed.cause_class, 'environment');
  assert.match(failed.error, /No owned browser after setup/u);
});
