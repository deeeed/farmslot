// Physical recording-provider proof. Caller supplies an exclusive device lease.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RecipeActionManifestDocument } from '@farmslot/protocol';
import { createRecipeRunner } from '../packages/recipe-harness/src/core/runner.js';
import { createStandardCoreAdapters } from '../packages/recipe-harness/src/adapters/core.js';
import { createStandardUiAdapters } from '../packages/recipe-harness/src/adapters/ui.js';
import { createAndroidMirrorVideoRecorder } from '../packages/recipe-harness/src/recording/android-mirror.js';

const serial = process.env.FARMSLOT_RECORDING_DEVICE_SERIAL;
const lease = process.env.FARMSLOT_RECORDING_DEVICE_LEASE;
const helper = process.env.FARMSLOT_CAPTURE_HELPER;
const root = process.env.FARMSLOT_RECORDING_PROOF_DIR;
const hold = Number(process.env.FARMSLOT_RECORDING_HOLD_MS ?? 3000);
assert.ok(
  serial && lease && helper && root,
  'Supply the exclusively leased device, helper, and isolated artifact directory',
);
assert.ok(Number.isFinite(hold) && hold >= 0 && hold <= 600000);
await mkdir(root, { recursive: true });
const manifest: RecipeActionManifestDocument = {
  $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
  actions: {
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
    wait: {
      description: 'Keep capture running.',
      schema: {
        type: 'object',
        properties: { ms: { type: 'number' } },
        required: ['ms'],
        additionalProperties: false,
      },
      examples: [{ action: 'wait', intent: 'Observe.', ms: 100, next: 'done' }],
    },
    'ui.screenshot': {
      description: 'Capture from the active recording stream.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      examples: [
        { action: 'ui.screenshot', intent: 'Retain screen.', path: 'shot.png', next: 'done' },
      ],
    },
  },
};
manifest.actions.call = {
  description: 'Reuse a timed observation segment.',
  examples: [
    {
      action: 'call',
      ref: 'observe',
      params: { ms: 100 },
      intent: 'Continue observing the same device.',
      next: 'done',
    },
  ],
};
const actions = Object.keys(manifest.actions);
const recipe = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  description:
    'Retain physical device frames and concurrent screenshots without controlling the application.',
  workflow: {
    entry: 'first',
    nodes: {
      first: {
        action: 'ui.screenshot',
        path: 'first.png',
        intent: 'Establish the device display before the sustained observation interval.',
        next: 'hold',
      },
      hold: {
        action: 'wait',
        ms: hold,
        intent: 'Verify the recording remains active for the requested interval.',
        next: 'last',
      },
      last: {
        action: 'ui.screenshot',
        path: 'last.png',
        intent: 'Show that the device display remains observable after the sustained interval.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    },
  },
};
const segments = Math.max(1, Math.ceil(hold / 60000));
const nodes = recipe.workflow.nodes as Record<string, unknown>;
for (let i = 0; i < segments; i++)
  nodes[i === 0 ? 'hold' : `hold-${i}`] = {
    action: 'call',
    ref: 'observe',
    params: { ms: Math.min(60000, hold - i * 60000) },
    intent: 'Continue the sustained device observation through a reusable bounded segment.',
    next: i + 1 < segments ? `hold-${i + 1}` : 'last',
  };
const library = path.join(root, 'library');
await mkdir(path.join(library, 'recipes/shared'), { recursive: true });
await writeFile(
  path.join(library, 'recipes/shared/observe.recipe.json'),
  JSON.stringify({
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Keep the existing recording active for a bounded observation segment.',
    paramsSchema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
      required: ['ms'],
      additionalProperties: false,
    },
    workflow: {
      entry: 'observe',
      nodes: {
        observe: {
          action: 'wait',
          ms: '{{params.ms}}',
          intent: 'Allow observation of the existing device state over the requested interval.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  }),
);
const recorder = createAndroidMirrorVideoRecorder({
  serial,
  captureHelperPath: helper,
  fallback: {
    name: 'forbidden-for-primary-proof',
    async start() {
      throw new Error('This proof requires primary capture-helper recording.');
    },
  },
});
const runner = createRecipeRunner({
  actionManifest: manifest,
  hud: false,
  defaultSource: { kind: 'operator', trust: 'trusted', name: 'leased recording provider proof' },
  adapters: [
    ...createStandardCoreAdapters({ actions }),
    ...createStandardUiAdapters({
      actions,
      transport: {
        async execute() {
          throw new Error('Screenshot must use the recording session, not a separate transport.');
        },
      },
    }),
  ],
  recording: {
    videoRecorder: recorder,
    targetProvider: {
      async resolveRecordingTarget() {
        return { kind: 'android-device', serial };
      },
    },
  },
});
const result = await runner.run({
  recipeDocument: recipe,
  projectRoot: root,
  artifactsDir: path.join(root, 'artifacts'),
  recordVideo: { mode: 'full-run', maxFps: 15 },
  librarySources: [
    { root: library, provenance: { kind: 'library', trust: 'trusted', name: 'recording proof' } },
  ],
});
if (process.env.FARMSLOT_RECORDING_EXPECT_MIRROR_FAILURE === '1') {
  assert.equal(result.status, 'fail');
  const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
  assert.ok(
    trace.some(
      (entry: { ok: boolean; error?: string }) =>
        !entry.ok && entry.error?.includes('mirror exited during recording'),
    ),
  );
  console.log(JSON.stringify({ pass: true, expectedMirrorFailure: true, root }));
  process.exit(0);
}
assert.equal(result.status, 'pass');
const artifacts = JSON.parse(await readFile(result.artifactManifestPath, 'utf8')).artifacts;
const video = artifacts.find((artifact: any) => artifact.type === 'video');
assert.equal(video.recorder.name, 'capture-helper');
assert.ok(video.timelinePath);
const native = JSON.parse(
  await readFile(path.join(root, 'artifacts', video.path + '.capture.json'), 'utf8'),
);
assert.equal(native.snapshots.length, 2);
assert.ok(
  native.snapshots.every((snapshot: any) => Number.isInteger(snapshot.encoded_frame_index)),
);
assert.ok(native.duration_ms >= hold);
const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
const snapshots = trace.filter((entry: any) => entry.action === 'ui.screenshot');
assert.equal(snapshots.length, 2);
assert.ok(snapshots.every((entry: any) => entry.output.recording_id === native.recording_id));
const proof = {
  pass: true,
  scope: 'Recording infrastructure only; no application behavior certified',
  serial,
  lease,
  recordingId: native.recording_id,
  frames: native.frames_ms.length,
  durationMs: native.duration_ms,
  snapshots: snapshots.map((entry: any) => ({ node: entry.nodeId, output: entry.output })),
  root,
};
await writeFile(path.join(root, 'proof.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));
