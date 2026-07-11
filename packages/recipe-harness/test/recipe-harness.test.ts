import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  type RecipeActionManifestDocument,
  validateRecipeArtifactPackage,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createStandardUiAdapters, type UiActionTransport } from '../src/adapters/ui.js';
import { runRecipeHarnessCli } from '../src/cli/index.js';
import { validateRecipeCliInput } from '../src/cli/support.js';
import { readJsonFile, writeJsonFile } from '../src/core/json.js';
import { cleanupAbortedRunVideoRecording } from '../src/core/recording-cleanup.js';
import { createRecipeRunner, defineActionAdapter } from '../src/core/runner.js';
import type { VideoRecorder, VideoRecorderStartRequest } from '../src/core/types.js';
import { createCaptureHelperVideoRecorder } from '../src/recording/capture-helper.js';
import { extensionIdFromTarget } from '../src/runtime/browser-extension.js';
import { CdpWebPage, createCdpWebUiTransport } from '../src/runtime/cdp.js';
import {
  createReactNativeBridgeUiTransport,
  type ReactNativeBridgeCommand,
} from '../src/runtime/react-native-bridge.js';

const coreActionManifest: RecipeActionManifestDocument = {
  runner_protocol_version: 1,
  action_registry_version: 1,
  supported_official_actions: [
    'end',
    'wait',
    'command',
    'assert_file',
    'assert_json',
    'assert_exit_code',
    'assert_output',
    'state_read',
    'watch_logs',
    'index_artifacts',
    'call',
    'switch',
    'manual',
  ],
};

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'farmslot-recipe-harness-'));
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        output.push(relativePath.split(path.sep).join('/'));
      }
    }
  }
  await visit('');
  return output.sort();
}

async function captureConsoleLog(callback: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...values: unknown[]) => {
    lines.push(values.map((value) => String(value)).join(' '));
  };
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
}

function createSmokeRecipe(): unknown {
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    schema_version: 1,
    title: 'Recipe harness smoke',
    description: 'Runs a command, asserts outputs, and publishes artifacts.',
    validate: {
      workflow: {
        entry: 'run-smoke',
        nodes: {
          'run-smoke': {
            action: 'command',
            intent: 'Run the smoke command and create report artifacts',
            cmd: "node -e \"const fs=require('fs'); fs.mkdirSync('reports',{recursive:true}); fs.mkdirSync('logs',{recursive:true}); fs.writeFileSync('reports/api-smoke.json', JSON.stringify({failed:0,message:'ok'})); fs.writeFileSync('logs/api-smoke.log','ok log'); console.log('SMOKE_OK')\"",
            next: 'assert-report',
          },
          'assert-report': {
            action: 'assert_json',
            intent: 'Verify the smoke report has no failed checks',
            path: 'reports/api-smoke.json',
            assert: { path: '$.failed', operator: 'eq', value: 0 },
            next: 'assert-output',
          },
          'assert-output': {
            action: 'assert_output',
            intent: 'Confirm the smoke command printed its success marker',
            source: 'run-smoke',
            stream: 'stdout',
            contains: 'SMOKE_OK',
            next: 'index-artifacts',
          },
          'index-artifacts': {
            action: 'index_artifacts',
            intent: 'Publish the smoke report and log artifacts for review',
            artifacts: [
              {
                path: 'reports/api-smoke.json',
                type: 'json',
                proofTarget: 'api smoke',
                covers: ['report'],
              },
              { path: 'logs/api-smoke.log', type: 'log', category: 'debug' },
            ],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  };
}

test('runs a backend/headless recipe and writes a v1 artifact package', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = createSmokeRecipe();
    const recipePath = path.join(tempRoot, 'recipe.json');
    const artifactsDir = path.join(tempRoot, 'artifacts');
    await writeJsonFile(recipePath, recipe);

    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({ recipePath, artifactsDir, projectRoot: tempRoot });

    assert.equal(result.status, 'pass');
    for (const requiredPath of [
      'recipe.json',
      'summary.json',
      'trace.json',
      'artifact-manifest.json',
    ]) {
      assert.ok((await listRelativeFiles(artifactsDir)).includes(requiredPath), requiredPath);
    }

    const copiedRecipe = await readJsonFile(path.join(artifactsDir, 'recipe.json'));
    const summary = await readJsonFile(path.join(artifactsDir, 'summary.json'));
    const trace = await readJsonFile(path.join(artifactsDir, 'trace.json'));
    const manifest = await readJsonFile(path.join(artifactsDir, 'artifact-manifest.json'));
    assert.equal(
      (manifest as { artifacts?: Array<{ type?: string }> }).artifacts?.some(
        (artifact) => artifact.type === 'video',
      ),
      false,
    );
    assert.deepEqual(copiedRecipe, recipe);
    assert.match(await readFile(path.join(artifactsDir, 'logs/api-smoke.log'), 'utf-8'), /ok log/);
    assert.ok(Array.isArray(trace));
    assert.equal(
      (trace as Array<{ intent?: string }>)[0]?.intent,
      'Run the smoke command and create report artifacts',
    );
    assert.equal((summary as { status?: string }).status, 'pass');

    const packageResult = validateRecipeArtifactPackage({
      recipe,
      manifest,
      artifactPaths: await listRelativeFiles(artifactsDir),
    });
    assert.equal(packageResult.status, 'valid', JSON.stringify(packageResult.findings));
    assert.deepEqual(packageResult.findings, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('watch_logs defaults to run-scoped matching so stale pre-run lines do not pass', async () => {
  const tempRoot = await createTempRoot();
  try {
    await mkdir(path.join(tempRoot, 'logs'), { recursive: true });
    await writeFile(path.join(tempRoot, 'logs/app.log'), 'STALE_MARKER\n');
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });

    const failRecipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'stale watch_logs proof',
      description: 'Pre-run stale markers must not satisfy watch_logs.',
      validate: {
        workflow: {
          entry: 'append',
          nodes: {
            append: {
              action: 'command',
              intent: 'Append a fresh marker without rewriting the old log.',
              cmd: "node -e \"require('fs').appendFileSync('logs/app.log','FRESH_MARKER\\n')\"",
              next: 'watch',
            },
            watch: {
              action: 'watch_logs',
              intent: 'Check stale markers do not satisfy run-scoped log matching.',
              path: 'logs/app.log',
              contains: 'STALE_MARKER',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const failResult = await runner.run({
      recipeDocument: failRecipe,
      artifactsDir: path.join(tempRoot, 'artifacts-fail'),
      projectRoot: tempRoot,
    });
    assert.equal(failResult.status, 'fail');

    const passRecipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'fresh watch_logs proof',
      description: 'Run-scoped watch_logs sees lines emitted during this run.',
      validate: {
        workflow: {
          entry: 'append',
          nodes: {
            append: {
              action: 'command',
              intent: 'Append a run-scoped marker to the log.',
              cmd: "node -e \"require('fs').appendFileSync('logs/app.log','RUN_SCOPED_MARKER\\n')\"",
              next: 'watch',
            },
            watch: {
              action: 'watch_logs',
              intent: 'Check the marker emitted during this run.',
              path: 'logs/app.log',
              contains: 'RUN_SCOPED_MARKER',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const passResult = await runner.run({
      recipeDocument: passRecipe,
      artifactsDir: path.join(tempRoot, 'artifacts-pass'),
      projectRoot: tempRoot,
    });
    assert.equal(passResult.status, 'pass');

    const fileScopeRecipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'file scoped watch_logs proof',
      description: 'Recipes can explicitly scan the whole file when needed.',
      validate: {
        workflow: {
          entry: 'watch',
          nodes: {
            watch: {
              action: 'watch_logs',
              intent: 'Check whole-file matching remains opt-in.',
              path: 'logs/app.log',
              contains: 'STALE_MARKER',
              scope: 'file',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const fileScopeResult = await runner.run({
      recipeDocument: fileScopeRecipe,
      artifactsDir: path.join(tempRoot, 'artifacts-file-scope'),
      projectRoot: tempRoot,
    });
    assert.equal(fileScopeResult.status, 'pass');

    const flowRecipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'flow scoped watch_logs proof',
      description: 'Run-scoped watch_logs also applies inside called flows.',
      flows: {
        'local.watch-stale': {
          entry: 'watch',
          nodes: {
            watch: {
              action: 'watch_logs',
              intent: 'Check stale markers do not satisfy run-scoped log matching in flows.',
              path: 'logs/app.log',
              contains: 'STALE_MARKER',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
      validate: {
        workflow: {
          entry: 'append',
          nodes: {
            append: {
              action: 'command',
              intent: 'Append a fresh marker before calling the flow.',
              cmd: "node -e \"require('fs').appendFileSync('logs/app.log','FLOW_FRESH_MARKER\\n')\"",
              next: 'call-flow',
            },
            'call-flow': {
              action: 'call',
              intent: 'Run a flow whose watch_logs node must use the run baseline.',
              ref: 'local.watch-stale',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const flowResult = await runner.run({
      recipeDocument: flowRecipe,
      artifactsDir: path.join(tempRoot, 'artifacts-flow'),
      projectRoot: tempRoot,
    });
    assert.equal(flowResult.status, 'fail');

    // An inline-only recipe is already self-contained (its flows live in recipe.json
    // and are validated by validateInlineFlows), so no separate resolved-recipe.json
    // is emitted — that artifact is reserved for `uses`/library composition.
    assert.ok(
      !(await listRelativeFiles(path.join(tempRoot, 'artifacts-flow'))).includes(
        'resolved-recipe.json',
      ),
      'inline-only recipe should not emit resolved-recipe.json',
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('records one opt-in whole-recipe video and registers it in the artifact manifest', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = createSmokeRecipe();
    const starts: VideoRecorderStartRequest[] = [];
    const recorder: VideoRecorder = {
      name: 'fake-recorder',
      platform: 'test',
      async doctor() {
        return { ok: true, code: 'ok', message: 'ready' };
      },
      async start(request) {
        starts.push(request);
        return {
          async stop() {
            await writeFile(request.outputPath, 'fake mp4');
            return {
              recorder: {
                name: 'fake-recorder',
                platform: 'test',
                target: { selector: 'pid', value: '123' },
              },
            };
          },
        };
      },
    };
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
      recording: {
        videoRecorder: recorder,
        targetProvider: {
          async resolveRecordingTarget() {
            return { kind: 'pid', pid: 123 };
          },
        },
      },
    });
    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
      recordVideo: { mode: 'full-run', maxFps: 24 },
    });

    assert.equal(result.status, 'pass');
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.nodeId, 'recipe-run');
    assert.equal(starts[0]?.record, 'full_run');
    assert.equal(starts[0]?.maxFps, 24);
    const files = await listRelativeFiles(path.join(tempRoot, 'artifacts'));
    assert.ok(files.includes('videos/recipe-run.mp4'));

    const manifest = await readJsonFile(result.artifactManifestPath);
    const video = (manifest as { artifacts: Array<Record<string, unknown>> }).artifacts.find(
      (artifact) => artifact.path === 'videos/recipe-run.mp4',
    );
    assert.deepEqual(video, {
      path: 'videos/recipe-run.mp4',
      type: 'video',
      mimeType: 'video/mp4',
      category: 'proof',
      label: 'Recipe run video',
      record: 'full_run',
      recorder: {
        name: 'fake-recorder',
        platform: 'test',
        target: { selector: 'pid', value: '123' },
      },
      maxFps: 24,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('record-video doctor failure writes a failed artifact package', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = createSmokeRecipe();
    const recorder: VideoRecorder = {
      name: 'fake-recorder',
      platform: 'test',
      async doctor() {
        return {
          ok: false,
          code: 'missing-permission',
          message: 'Screen Recording is disabled.',
          suggestedFix: 'Open permissions.',
        };
      },
      async start() {
        throw new Error('start should not run after doctor failure');
      },
    };
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
      recording: { videoRecorder: recorder },
    });
    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
      recordVideo: true,
    });

    assert.equal(result.status, 'fail');
    const files = await listRelativeFiles(path.join(tempRoot, 'artifacts'));
    assert.ok(files.includes('recipe.json'));
    assert.ok(files.includes('summary.json'));
    assert.ok(files.includes('trace.json'));
    assert.ok(files.includes('artifact-manifest.json'));
    assert.equal(files.includes('videos/recipe-run.mp4'), false);

    const summary = await readJsonFile(result.summaryPath);
    const trace = await readJsonFile(result.tracePath);
    const videoFailure = (trace as Array<{ nodeId: string; error?: string }>).find(
      (entry) => entry.nodeId === 'recipe-run:video',
    );
    assert.equal((summary as { status?: string }).status, 'fail');
    assert.match(videoFailure?.error ?? '', /fake-recorder doctor missing-permission/);
    assert.match(videoFailure?.error ?? '', /Open permissions/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('record-video start failure removes partial MP4 and writes a failed artifact package', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recorder: VideoRecorder = {
      name: 'fake-recorder',
      platform: 'test',
      async doctor() {
        return { ok: true, code: 'ok', message: 'ready' };
      },
      async start(request) {
        await writeFile(request.outputPath, 'partial mp4');
        throw new Error('start failed after partial write');
      },
    };
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
      recording: {
        videoRecorder: recorder,
        targetProvider: {
          async resolveRecordingTarget() {
            return { kind: 'pid', pid: 123 };
          },
        },
      },
    });
    const result = await runner.run({
      recipeDocument: createSmokeRecipe(),
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
      recordVideo: true,
    });

    assert.equal(result.status, 'fail');
    const files = await listRelativeFiles(path.join(tempRoot, 'artifacts'));
    assert.equal(files.includes('videos/recipe-run.mp4'), false);

    const trace = await readJsonFile(result.tracePath);
    const videoFailure = (trace as Array<{ nodeId: string; error?: string }>).find(
      (entry) => entry.nodeId === 'recipe-run:video',
    );
    assert.match(videoFailure?.error ?? '', /start failed after partial write/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('record-video stop failure removes partial MP4 and writes a failed artifact package', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recorder: VideoRecorder = {
      name: 'fake-recorder',
      platform: 'test',
      async doctor() {
        return { ok: true, code: 'ok', message: 'ready' };
      },
      async start(request) {
        return {
          async stop() {
            await writeFile(request.outputPath, 'partial mp4');
            throw new Error('stop failed after partial write');
          },
        };
      },
    };
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
      recording: {
        videoRecorder: recorder,
        targetProvider: {
          async resolveRecordingTarget() {
            return { kind: 'pid', pid: 123 };
          },
        },
      },
    });
    const result = await runner.run({
      recipeDocument: createSmokeRecipe(),
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
      recordVideo: true,
    });

    assert.equal(result.status, 'fail');
    const files = await listRelativeFiles(path.join(tempRoot, 'artifacts'));
    assert.equal(files.includes('videos/recipe-run.mp4'), false);

    const trace = await readJsonFile(result.tracePath);
    const videoFailure = (trace as Array<{ nodeId: string; error?: string }>).find(
      (entry) => entry.nodeId === 'recipe-run:video',
    );
    assert.match(videoFailure?.error ?? '', /stop failed after partial write/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('record-video stop success still requires a non-empty MP4 artifact', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recorder: VideoRecorder = {
      name: 'fake-recorder',
      platform: 'test',
      async doctor() {
        return { ok: true, code: 'ok', message: 'ready' };
      },
      async start() {
        return {
          async stop() {
            return {};
          },
        };
      },
    };
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
      recording: {
        videoRecorder: recorder,
        targetProvider: {
          async resolveRecordingTarget() {
            return { kind: 'pid', pid: 123 };
          },
        },
      },
    });
    const result = await runner.run({
      recipeDocument: createSmokeRecipe(),
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
      recordVideo: true,
    });

    assert.equal(result.status, 'fail');
    const files = await listRelativeFiles(path.join(tempRoot, 'artifacts'));
    assert.equal(files.includes('videos/recipe-run.mp4'), false);

    const trace = await readJsonFile(result.tracePath);
    const videoFailure = (trace as Array<{ nodeId: string; error?: string }>).find(
      (entry) => entry.nodeId === 'recipe-run:video',
    );
    assert.match(videoFailure?.error ?? '', /Recording output is missing/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('aborted video cleanup removes partial MP4 written during recorder stop', async () => {
  const tempRoot = await createTempRoot();
  try {
    const artifactsDir = path.join(tempRoot, 'artifacts');
    const outputPath = path.join(artifactsDir, 'videos/recipe-run.mp4');
    await mkdir(path.dirname(outputPath), { recursive: true });
    const errors: string[] = [];

    await cleanupAbortedRunVideoRecording(
      {
        outputPath,
        recording: {
          async stop() {
            await writeFile(outputPath, 'partial mp4');
            return {};
          },
        },
      },
      {
        info() {},
        warn() {},
        error(message) {
          errors.push(message);
        },
      },
    );

    assert.equal((await listRelativeFiles(artifactsDir)).includes('videos/recipe-run.mp4'), false);
    assert.deepEqual(errors, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runner rejects proof-window video mode until focused clips are implemented', async () => {
  const tempRoot = await createTempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const unsupportedRecordVideo = { mode: 'proof-window' } as unknown as Parameters<
      typeof runner.run
    >[0]['recordVideo'];

    await assert.rejects(
      () =>
        runner.run({
          recipeDocument: createSmokeRecipe(),
          artifactsDir: path.join(tempRoot, 'artifacts'),
          projectRoot: tempRoot,
          recordVideo: unsupportedRecordVideo,
        }),
      /proof-window mode is reserved for future focused clips/,
    );

    const unknownRecordVideo = { mode: 'focused-clip' } as unknown as Parameters<
      typeof runner.run
    >[0]['recordVideo'];
    await assert.rejects(
      () =>
        runner.run({
          recipeDocument: createSmokeRecipe(),
          artifactsDir: path.join(tempRoot, 'unknown-artifacts'),
          projectRoot: tempRoot,
          recordVideo: unknownRecordVideo,
        }),
      /recordVideo mode must be full-run or off/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('capture-helper recorder stop sends SIGINT and returns recorder metadata', async () => {
  const tempRoot = await createTempRoot();
  try {
    const helperPath = path.join(tempRoot, 'fake-capture-helper.cjs');
    const readyPath = path.join(tempRoot, 'ready.txt');
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const output = process.argv[process.argv.indexOf('--output') + 1];
process.on('SIGINT', () => {
  writeFileSync(output, 'fake mp4');
  process.exit(0);
});
writeFileSync(${JSON.stringify(readyPath)}, 'ready');
setInterval(() => {}, 1000);
`,
    );
    await chmod(helperPath, 0o755);

    const outputPath = path.join(tempRoot, 'recording.mp4');
    const recorder = createCaptureHelperVideoRecorder({ captureHelperPath: helperPath });
    const active = await recorder.start({
      outputPath,
      target: { kind: 'pid', pid: 123 },
      nodeId: 'recipe-run',
      record: 'full_run',
    });
    await waitForFile(readyPath);
    const result = await active.stop();

    assert.match(await readFile(outputPath, 'utf-8'), /fake mp4/);
    assert.deepEqual(result.recorder, {
      name: 'capture-helper',
      platform: 'macos',
      target: { selector: 'pid', value: '123' },
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('capture-helper recorder stop times out when the helper ignores SIGINT', async () => {
  const tempRoot = await createTempRoot();
  try {
    const helperPath = path.join(tempRoot, 'stuck-capture-helper.cjs');
    const readyPath = path.join(tempRoot, 'stuck-ready.txt');
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
process.on('SIGINT', () => {});
writeFileSync(${JSON.stringify(readyPath)}, 'ready');
setInterval(() => {}, 1000);
`,
    );
    await chmod(helperPath, 0o755);

    const recorder = createCaptureHelperVideoRecorder({
      captureHelperPath: helperPath,
      stopTimeoutMs: 50,
    });
    const active = await recorder.start({
      outputPath: path.join(tempRoot, 'recording.mp4'),
      target: { kind: 'pid', pid: 123 },
      nodeId: 'recipe-run',
      record: 'full_run',
    });

    await waitForFile(readyPath);
    await assert.rejects(() => active.stop(), /did not stop within 50ms after SIGINT/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('writes runner provenance into strict v1 runtime artifacts when configured', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = createSmokeRecipe();
    const recipePath = path.join(tempRoot, 'recipe.json');
    const artifactsDir = path.join(tempRoot, 'artifacts');
    const runner = {
      source: '/tmp/example-runner',
      git_ref: '0123456789abcdef',
      name: '@example/recipe-runner',
    };
    await writeJsonFile(recipePath, recipe);

    const recipeRunner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
      runner,
    });
    const result = await recipeRunner.run({ recipePath, artifactsDir, projectRoot: tempRoot });

    assert.equal(result.status, 'pass');
    const summary = await readJsonFile(path.join(artifactsDir, 'summary.json'));
    const trace = await readJsonFile(path.join(artifactsDir, 'trace.json'));
    const manifest = await readJsonFile(path.join(artifactsDir, 'artifact-manifest.json'));

    assert.deepEqual((summary as { runner?: unknown }).runner, runner);
    assert.deepEqual((trace as { metadata?: { runner?: unknown } }).metadata?.runner, runner);
    assert.deepEqual(
      (manifest as { provenance?: { runner?: unknown } }).provenance?.runner,
      runner,
    );
    assert.ok(Array.isArray((trace as { entries?: unknown }).entries));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('executes setup startState teardown lifecycle nodes and validates their actions', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Lifecycle recipe',
      description: 'Exercises v1 lifecycle execution.',
      startState: {
        action: 'command',
        intent: 'Record that startState ran after setup',
        cmd: "node -e \"require('fs').appendFileSync('order.txt','startState\\n')\"",
      },
      validate: {
        workflow: {
          setup: [
            {
              id: 'setup-command',
              action: 'command',
              intent: 'Write the lifecycle setup marker before validation',
              cmd: "node -e \"require('fs').writeFileSync('order.txt','setup\\n')\"",
            },
          ],
          entry: 'proof',
          nodes: {
            proof: {
              action: 'command',
              intent: 'Record that the main lifecycle proof step ran',
              cmd: "node -e \"require('fs').appendFileSync('order.txt','proof\\n')\"",
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
          teardown: [
            {
              id: 'teardown-command',
              action: 'command',
              intent: 'Record that teardown ran after the main workflow',
              cmd: "node -e \"require('fs').appendFileSync('order.txt','teardown\\n')\"",
            },
          ],
        },
      },
    };
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'pass');
    assert.equal(
      await readFile(path.join(tempRoot, 'order.txt'), 'utf-8'),
      'setup\nstartState\nproof\nteardown\n',
    );
    const trace = await readJsonFile(result.tracePath);
    assert.deepEqual(
      (trace as Array<{ nodeId: string }>).map((entry) => entry.nodeId),
      ['setup-command', 'startState', 'proof', 'done', 'teardown-command', 'teardown:end'],
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('executes manifest-declared preconditions before lifecycle nodes', async () => {
  const tempRoot = await createTempRoot();
  try {
    const manifest: RecipeActionManifestDocument = {
      ...coreActionManifest,
      pre_conditions: [
        { id: 'workspace.ready', description: 'Workspace is ready.' },
        { id: 'fixture.named', description: 'Fixture name is provided.' },
      ],
    };
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Precondition recipe',
      description: 'Checks preconditions before setup.',
      validate: {
        workflow: {
          pre_conditions: ['workspace.ready', { id: 'fixture.named', params: { name: 'dev7' } }],
          setup: [
            {
              id: 'setup-command',
              action: 'command',
              intent: 'Write setup proof after preconditions pass',
              cmd: "node -e \"require('fs').writeFileSync('setup.txt','setup')\"",
            },
          ],
          entry: 'done',
          nodes: { done: { action: 'end', status: 'pass' } },
        },
      },
    };
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters(),
      preconditions: [
        {
          id: 'workspace.ready',
          async execute() {
            return { output: { ready: true } };
          },
        },
        {
          id: 'fixture.named',
          async execute(gate) {
            return { ok: gate.params?.name === 'dev7', output: { checkedName: gate.params?.name } };
          },
        },
      ],
    });
    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'pass');
    assert.equal(await readFile(path.join(tempRoot, 'setup.txt'), 'utf-8'), 'setup');
    const trace = await readJsonFile(result.tracePath);
    assert.deepEqual(
      (trace as Array<{ nodeId: string }>).slice(0, 3).map((entry) => entry.nodeId),
      ['pre_conditions:workspace.ready', 'pre_conditions:fixture.named', 'setup-command'],
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('fails preconditions with no registered checker instead of silently skipping them', async () => {
  const tempRoot = await createTempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: {
        ...coreActionManifest,
        pre_conditions: [{ id: 'workspace.ready', description: 'Workspace is ready.' }],
      },
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        schema_version: 1,
        title: 'Missing precondition checker',
        description: 'Preconditions must fail closed.',
        validate: {
          workflow: {
            pre_conditions: ['workspace.ready'],
            setup: [
              {
                id: 'setup-command',
                action: 'command',
                intent: 'Prepare the command that must not run without preconditions',
                cmd: "node -e \"require('fs').writeFileSync('should-not-run.txt','bad')\"",
              },
            ],
            entry: 'done',
            nodes: { done: { action: 'end', status: 'pass' } },
          },
        },
      },
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'fail');
    assert.ok(!(await readdir(tempRoot)).includes('should-not-run.txt'));
    const trace = await readJsonFile(result.tracePath);
    assert.match((trace as Array<{ error?: string }>)[0]?.error ?? '', /has no checker registered/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runs inline flow composition through call nodes', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Inline call recipe',
      description: 'Executes a reusable inline flow.',
      flows: {
        'example.write-file': {
          entry: 'write',
          nodes: {
            write: {
              action: 'command',
              intent: 'Write the inline flow output file',
              cmd: "node -e \"require('fs').writeFileSync('flow.txt','ok')\"",
              next: 'assert-write',
            },
            'assert-write': {
              action: 'assert_exit_code',
              intent: 'Confirm the inline flow write command exited successfully',
              source: 'write',
              expected: 0,
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
      validate: {
        workflow: {
          entry: 'call-flow',
          nodes: {
            'call-flow': {
              action: 'call',
              intent: 'Run the reusable inline file-writing flow',
              ref: 'example.write-file',
              next: 'assert-flow-output',
            },
            'assert-flow-output': {
              action: 'assert_file',
              intent: 'Verify the inline flow produced the expected file',
              path: 'flow.txt',
              contains: 'ok',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'pass');
    const trace = await readJsonFile(result.tracePath);
    assert.ok(
      (trace as Array<{ nodeId: string }>).some((entry) => entry.nodeId === 'call-flow/write'),
    );
    assert.ok(
      (trace as Array<{ nodeId: string }>).some(
        (entry) => entry.nodeId === 'call-flow/assert-write',
      ),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('keeps child flow intent as the only default HUD line', async () => {
  const tempRoot = await createTempRoot();
  try {
    const hudPayloads: Record<string, unknown>[] = [];
    const hudAdapter = defineActionAdapter({
      action: 'app.hud',
      async execute(node) {
        hudPayloads.push(node);
        return { output: { ok: true } };
      },
    });
    const runner = createRecipeRunner({
      actionManifest: {
        ...coreActionManifest,
        supported_official_actions: [...coreActionManifest.supported_official_actions, 'app.hud'],
      },
      adapters: [...createStandardCoreAdapters(), hudAdapter],
    });

    const result = await runner.run({
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        schema_version: 1,
        flows: {
          'example.child-hud': {
            entry: 'write-proof',
            nodes: {
              'write-proof': {
                action: 'command',
                intent: 'Write the child flow proof file',
                cmd: "node -e \"require('fs').writeFileSync('subflow.txt','ok')\"",
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
        validate: {
          workflow: {
            entry: 'call-flow',
            nodes: {
              'call-flow': {
                action: 'call',
                intent: 'Run the parent flow for HUD context',
                ref: 'example.child-hud',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });

    assert.equal(result.status, 'pass');
    const childHud = hudPayloads.find(
      (payload) => payload.node_id === 'call-flow/write-proof' && payload.status === 'running',
    );
    assert.equal(childHud?.text, 'Write the child flow proof file');
    assert.equal(childHud?.sub_intent, undefined);
    assert.equal(
      (childHud?.display as Record<string, unknown> | undefined)?.showSubflow,
      undefined,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runs catalog flow calls with params and postconditions', async () => {
  const tempRoot = await createTempRoot();
  try {
    await writeJsonFile(path.join(tempRoot, 'flows.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: {
        'example.write-param': {
          paramsSchema: {
            type: 'object',
            required: ['text'],
            properties: { text: { type: 'string' } },
          },
          postcondition: { path: '$.outputs.write.exitCode', operator: 'eq', value: 0 },
          workflow: {
            entry: 'write',
            nodes: {
              write: {
                action: 'command',
                intent: 'Write the catalog flow parameter to disk',
                cmd: "node -e \"require('fs').writeFileSync('catalog.txt','{{params.text}}')\"",
                next: 'skip-when-false',
              },
              'skip-when-false': {
                action: 'command',
                intent: 'Exercise the catalog flow conditional skip path',
                cmd: "node -e \"require('fs').writeFileSync('should-not-run.txt','bad')\"",
                when: { path: '$.params.runSkippedNode', operator: 'eq', value: true },
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
    });
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Catalog call recipe',
      description: 'Executes a reusable catalog flow.',
      uses: ['flows.json'],
      validate: {
        workflow: {
          entry: 'call-flow',
          nodes: {
            'call-flow': {
              action: 'call',
              intent: 'Run the catalog flow with recipe parameters',
              ref: 'example.write-param',
              params: { text: 'catalog-ok' },
              next: 'assert-flow-output',
            },
            'assert-flow-output': {
              action: 'assert_file',
              intent: 'Verify the catalog flow wrote the expected output',
              path: 'catalog.txt',
              contains: 'catalog-ok',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writeJsonFile(recipePath, recipe);
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipePath,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'pass');
    assert.equal(await readFile(path.join(tempRoot, 'catalog.txt'), 'utf-8'), 'catalog-ok');
    assert.ok(!(await readdir(tempRoot)).includes('should-not-run.txt'));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runs nested catalog flow calls and rejects flow call cycles', async () => {
  const tempRoot = await createTempRoot();
  try {
    await writeJsonFile(path.join(tempRoot, 'flows.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: {
        'example.parent': {
          workflow: {
            entry: 'call-child',
            nodes: {
              'call-child': {
                action: 'call',
                intent: 'Call the child catalog flow from the parent flow',
                ref: 'example.child',
                params: { text: 'nested-ok' },
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
        'example.child': {
          paramsSchema: {
            type: 'object',
            required: ['text'],
            properties: { text: { type: 'string' } },
          },
          workflow: {
            entry: 'write',
            nodes: {
              write: {
                action: 'command',
                intent: 'Write the nested catalog flow output file',
                cmd: "node -e \"require('fs').writeFileSync('nested.txt','{{params.text}}')\"",
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
        'example.cycle-a': {
          workflow: {
            entry: 'call-b',
            nodes: {
              'call-b': {
                action: 'call',
                intent: 'Call cycle-b to exercise catalog cycle detection',
                ref: 'example.cycle-b',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
        'example.cycle-b': {
          workflow: {
            entry: 'call-a',
            nodes: {
              'call-a': {
                action: 'call',
                intent: 'Call cycle-a to exercise catalog cycle detection',
                ref: 'example.cycle-a',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
    });
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const passResult = await runner.run({
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        schema_version: 1,
        title: 'Nested catalog call recipe',
        description: 'Executes flow calls inside flow catalogs.',
        uses: ['flows.json'],
        validate: {
          workflow: {
            entry: 'call-parent',
            nodes: {
              'call-parent': {
                action: 'call',
                intent: 'Run the parent catalog flow and wait for completion',
                ref: 'example.parent',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
      artifactsDir: path.join(tempRoot, 'artifacts-pass'),
      projectRoot: tempRoot,
    });
    assert.equal(passResult.status, 'pass');
    assert.equal(await readFile(path.join(tempRoot, 'nested.txt'), 'utf-8'), 'nested-ok');
    const trace = await readJsonFile(passResult.tracePath);
    assert.ok(
      (trace as Array<{ nodeId: string }>).some(
        (entry) => entry.nodeId === 'call-parent/call-child/write',
      ),
    );

    const failResult = await runner.run({
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        schema_version: 1,
        title: 'Cycle catalog call recipe',
        description: 'Fails recursive flow calls.',
        uses: ['flows.json'],
        validate: {
          workflow: {
            entry: 'call-cycle',
            nodes: {
              'call-cycle': {
                action: 'call',
                intent: 'Run the cyclic catalog flow to capture the failure trace',
                ref: 'example.cycle-a',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
      artifactsDir: path.join(tempRoot, 'artifacts-fail'),
      projectRoot: tempRoot,
    });
    assert.equal(failResult.status, 'fail');
    const failTrace = await readJsonFile(failResult.tracePath);
    assert.ok(
      (failTrace as Array<{ error?: string }>).some((entry) =>
        /Flow call cycle detected/.test(entry.error ?? ''),
      ),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('fails catalog flow calls with invalid params or postconditions', async () => {
  const tempRoot = await createTempRoot();
  try {
    await writeJsonFile(path.join(tempRoot, 'flows.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: {
        'example.needs-param': {
          paramsSchema: { type: 'object', required: ['text'] },
          workflow: {
            entry: 'done',
            nodes: { done: { action: 'end', status: 'pass' } },
          },
        },
        'example.bad-postcondition': {
          postcondition: { path: '$.outputs.done.status', operator: 'eq', value: 'missing' },
          workflow: {
            entry: 'done',
            nodes: { done: { action: 'end', status: 'pass' } },
          },
        },
      },
    });
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const baseRecipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Catalog call failure',
      description: 'Fails invalid catalog calls.',
      uses: ['flows.json'],
      validate: {
        workflow: {
          entry: 'call-flow',
          nodes: {
            'call-flow': {
              action: 'call',
              intent: 'Run the parameterized catalog flow without required params',
              ref: 'example.needs-param',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };

    const invalidParams = await runner.run({
      recipeDocument: baseRecipe,
      artifactsDir: path.join(tempRoot, 'invalid-params'),
      projectRoot: tempRoot,
    });
    assert.equal(invalidParams.status, 'fail');

    const failedPostcondition = await runner.run({
      recipeDocument: {
        ...baseRecipe,
        validate: {
          workflow: {
            entry: 'call-flow',
            nodes: {
              'call-flow': {
                action: 'call',
                intent: 'Run the catalog flow with an invalid postcondition',
                ref: 'example.bad-postcondition',
                next: 'done',
              },
              done: { action: 'end', status: 'pass' },
            },
          },
        },
      },
      artifactsDir: path.join(tempRoot, 'bad-postcondition'),
      projectRoot: tempRoot,
    });
    assert.equal(failedPostcondition.status, 'fail');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects lifecycle nodes that declare graph transitions', async () => {
  const tempRoot = await createTempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    await assert.rejects(
      runner.run({
        recipeDocument: {
          $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
          schema_version: 1,
          title: 'Invalid lifecycle',
          description: 'Lifecycle arrays are ordered and cannot declare next.',
          validate: {
            workflow: {
              setup: [
                {
                  action: 'wait',
                  intent: 'Wait during lifecycle setup to trigger transition validation',
                  ms: 1,
                  next: 'done',
                },
              ],
              entry: 'done',
              nodes: { done: { action: 'end', status: 'pass' } },
            },
          },
        },
        artifactsDir: path.join(tempRoot, 'artifacts'),
        projectRoot: tempRoot,
      }),
      /must not declare next/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('supports the documented v1 assertion operators', async () => {
  const tempRoot = await createTempRoot();
  try {
    await writeJsonFile(path.join(tempRoot, 'subject.json'), {
      count: 3,
      name: 'alpha',
      tags: ['red', 'blue'],
      nested: { ok: true },
    });
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Assertion operators',
      description: 'Exercises v1 assertion operators.',
      validate: {
        workflow: {
          entry: 'assert-subject',
          nodes: {
            'assert-subject': {
              action: 'assert_json',
              intent: 'Verify the subject JSON satisfies all documented assertion operators',
              path: 'subject.json',
              assert: {
                all: [
                  { path: '$.count', operator: 'gte', value: 3 },
                  { path: '$.count', operator: 'lte', value: 3 },
                  { path: '$.name', operator: 'matches', value: '^alp' },
                  { path: '$.tags', operator: 'contains', value: 'red' },
                  { path: '$.tags', operator: 'length_eq', value: 2 },
                  { path: '$.nested', operator: 'deep_eq', value: { ok: true } },
                  { path: '$.missing', operator: 'falsy' },
                ],
              },
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'pass');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('fails fast for missing manifest declarations and missing adapter implementations', () => {
  const endAdapter = defineActionAdapter({
    action: 'end',
    async execute() {
      return { status: 'pass' };
    },
  });
  const echoAdapter = defineActionAdapter({
    action: 'example.echo',
    async execute(node) {
      return { output: { message: node.message } };
    },
  });
  const customManifest: RecipeActionManifestDocument = {
    runner_protocol_version: 1,
    action_registry_version: 1,
    supported_official_actions: ['end'],
    custom_actions: [{ name: 'example.echo', description: 'Echo a test message.' }],
  };

  assert.throws(
    () =>
      createRecipeRunner({
        actionManifest: { ...customManifest, custom_actions: [] },
        adapters: [endAdapter, echoAdapter],
      }),
    /not declared/,
  );
  assert.throws(
    () => createRecipeRunner({ actionManifest: customManifest, adapters: [endAdapter] }),
    /no registered adapter/,
  );
  assert.doesNotThrow(() =>
    createRecipeRunner({ actionManifest: customManifest, adapters: [endAdapter, echoAdapter] }),
  );
});

test('writes failure trace and summary with a non-pass result', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Failing recipe',
      description: 'Demonstrates failure artifacts.',
      validate: {
        workflow: {
          entry: 'run',
          nodes: {
            run: {
              action: 'command',
              intent: 'Run a command that exits non-zero to prove failure artifacts',
              cmd: 'node -e "process.exit(7)"',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'fail');
    const summary = await readJsonFile(result.summaryPath);
    const trace = await readJsonFile(result.tracePath);
    assert.equal((summary as { status?: string; failed?: number }).status, 'fail');
    assert.equal((summary as { status?: string; failed?: number }).failed, 1);
    assert.ok(Array.isArray(trace));
    assert.equal((trace[0] as { ok?: boolean }).ok, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runs and validates recipes through the harness CLI entrypoint', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = createSmokeRecipe();
    const recipePath = path.join(tempRoot, 'recipe.json');
    const manifestPath = path.join(tempRoot, 'action-manifest.json');
    const artifactsDir = path.join(tempRoot, 'artifacts');
    await writeJsonFile(recipePath, recipe);
    await writeJsonFile(manifestPath, coreActionManifest);

    const runOutput = await captureConsoleLog(() =>
      runRecipeHarnessCli([
        'run',
        recipePath,
        '--artifacts-dir',
        artifactsDir,
        '--action-manifest',
        manifestPath,
        '--project-root',
        tempRoot,
        '--json',
      ]),
    );
    assert.match(runOutput, /"status": "pass"/);
    assert.ok((await listRelativeFiles(artifactsDir)).includes('artifact-manifest.json'));

    const validateOutput = await captureConsoleLog(() =>
      runRecipeHarnessCli([
        'validate',
        recipePath,
        '--action-manifest',
        manifestPath,
        '--artifact-dir',
        artifactsDir,
        '--json',
      ]),
    );
    assert.match(validateOutput, /"status": "valid"/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('CLI rejects proof-window video mode until focused clips are implemented', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipePath = path.join(tempRoot, 'recipe.json');
    const manifestPath = path.join(tempRoot, 'action-manifest.json');
    await writeJsonFile(recipePath, createSmokeRecipe());
    await writeJsonFile(manifestPath, coreActionManifest);

    await assert.rejects(
      () =>
        runRecipeHarnessCli([
          'run',
          recipePath,
          '--artifacts-dir',
          path.join(tempRoot, 'artifacts'),
          '--action-manifest',
          manifestPath,
          '--record-video',
          'proof-window',
        ]),
      /proof-window is reserved for future focused clips/,
    );
    await assert.rejects(
      () =>
        runRecipeHarnessCli([
          'run',
          recipePath,
          '--artifacts-dir',
          path.join(tempRoot, 'artifacts'),
          '--action-manifest',
          manifestPath,
          '--record-video',
          'proof_window',
        ]),
      /proof-window is reserved for future focused clips/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('reports missing artifact manifests as validation findings instead of file errors', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Missing manifest validation smoke',
      description: 'Exercises optional artifact-manifest validation.',
      validate: {
        workflow: {
          entry: 'done',
          nodes: {
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const artifactsDir = path.join(tempRoot, 'artifacts');
    await writeJsonFile(path.join(tempRoot, 'recipe.json'), recipe);
    await writeJsonFile(path.join(artifactsDir, 'recipe.json'), recipe);

    const result = await validateRecipeCliInput({
      recipePath: 'recipe.json',
      artifactDir: 'artifacts',
      baseDir: tempRoot,
    });

    assert.equal(result.status, 'invalid');
    assert.ok(
      result.findings.some((finding) => finding.code === 'artifact_package.missing_manifest'),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runs official UI adapters through a runner-provided transport', async () => {
  const tempRoot = await createTempRoot();
  try {
    const manifest: RecipeActionManifestDocument = {
      runner_protocol_version: 1,
      action_registry_version: 1,
      supported_official_actions: ['ui.press', 'app.hud', 'end'],
    };
    const calls: string[] = [];
    const hudPayloads: Record<string, unknown>[] = [];
    const transport: UiActionTransport = {
      async execute(action, node, context) {
        calls.push(`${context.nodeId}:${action}`);
        if (action === 'app.hud') hudPayloads.push(node);
        return { action, selector: node.selector ?? null };
      },
    };
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'UI adapter smoke',
      description: 'Exercises official ui/app adapters through a project transport.',
      validate: {
        workflow: {
          entry: 'press-buy',
          nodes: {
            'press-buy': {
              action: 'ui.press',
              intent: 'Press the buy button in the UI adapter smoke recipe',
              note: 'Artifact note that must not become HUD text',
              selector: '[data-testid="buy"]',
              next: 'show-hud',
            },
            'show-hud': {
              action: 'app.hud',
              intent: 'Show the buy flow annotation in the HUD',
              text: 'Buying',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: [
        ...createStandardUiAdapters({ transport, actions: manifest.supported_official_actions }),
        ...createStandardCoreAdapters({ actions: ['end'] }),
      ],
    });

    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });

    assert.equal(result.status, 'pass');
    assert.deepEqual(calls, [
      'press-buy:app.hud',
      'press-buy:ui.press',
      'press-buy:app.hud',
      'show-hud:app.hud',
      'done:app.hud',
      'done:app.hud',
      'recipe-complete:app.hud',
    ]);
    assert.equal(hudPayloads[0]?.text, 'Press the buy button in the UI adapter smoke recipe');
    assert.notEqual(hudPayloads[0]?.text, 'Artifact note that must not become HUD text');
    const trace = await readJsonFile(result.tracePath);
    assert.equal((trace as Array<{ output?: { action?: string } }>)[0]?.output?.action, 'ui.press');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('maps React Native bridge transport commands without project-specific ui reimplementation', async () => {
  const tempRoot = await createTempRoot();
  try {
    const manifest: RecipeActionManifestDocument = {
      runner_protocol_version: 1,
      action_registry_version: 1,
      supported_official_actions: ['ui.scroll', 'app.hud', 'end'],
      observers: [
        {
          ref: 'ui.screen',
          description: 'Current native screen.',
          default_for: ['ui.scroll'],
          cost: 'cheap',
          redaction: 'none',
        },
        {
          ref: 'ui.visible',
          description: 'Current visible native controls.',
          default_for: ['ui.scroll'],
          cost: 'cheap',
          redaction: 'labels-only',
        },
      ],
    };
    const commands: ReactNativeBridgeCommand[] = [];
    const transport = createReactNativeBridgeUiTransport({
      bridge: {
        async send(command) {
          commands.push(command);
          return { command: command.command, payload: command.payload };
        },
      },
    });
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'React Native bridge smoke',
      description: 'Exercises official ui/app actions through the RN bridge contract.',
      validate: {
        workflow: {
          entry: 'scroll-list',
          nodes: {
            'scroll-list': {
              action: 'ui.scroll',
              intent: 'Scroll the asset list until the target rows are visible',
              detail: 'Using the React Native bridge scroll primitive',
              test_id: 'AssetList',
              delta_y: 800,
              next: 'hud',
            },
            hud: {
              action: 'app.hud',
              intent: 'Show that the asset list scroll completed',
              text: 'Scrolled assets',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: [
        ...createStandardUiAdapters({ transport, actions: manifest.supported_official_actions }),
        ...createStandardCoreAdapters({ actions: ['end'] }),
      ],
    });

    const result = await runner.run({
      recipeDocument: recipe,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });

    assert.equal(result.status, 'pass');
    assert.deepEqual(
      commands.map((command) => command.command),
      ['hud', 'scroll', 'observeUi', 'hud', 'hud', 'hud', 'hud', 'hud'],
    );
    assert.equal(commands[1]?.payload.test_id, 'AssetList');
    assert.deepEqual(commands[2]?.payload.refs, ['ui.screen', 'ui.visible']);
    assert.equal(
      commands[3]?.payload.text,
      'Scroll the asset list until the target rows are visible',
    );
    assert.equal(commands[3]?.payload.detail, 'Using the React Native bridge scroll primitive');
    assert.equal(commands[4]?.payload.text, 'Scrolled assets');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('maps CDP scroll into-view recipes to scrollIntoView semantics', async () => {
  const calls: Array<Record<string, unknown>> = [];
  let settleCalls = 0;
  const transport = createCdpWebUiTransport({
    async withPage(_input, callback) {
      const page = {
        async scroll(options: Record<string, unknown>) {
          calls.push(options);
          return { scrolled: true };
        },
        async waitForDomSettled() {
          settleCalls += 1;
        },
      };
      return callback(page as never);
    },
  });

  const result = await transport.execute(
    'ui.scroll',
    {
      test_id: 'target-row',
      scroll_into_view: true,
    },
    {
      nodeId: 'scroll-banner',
      recipe: {},
      projectRoot: '/tmp/project',
      artifactsDir: '/tmp/artifacts',
      env: {},
      outputs: new Map(),
      getOutput: () => undefined,
      resolveProjectPath: (relativePath) => relativePath,
      resolveArtifactPath: (relativePath) => relativePath,
      registerArtifact() {},
      logger: console,
    },
  );

  assert.deepEqual(result, { scrolled: true });
  assert.equal(settleCalls, 1);
  assert.deepEqual(calls, [
    {
      selector: '[data-testid="target-row"], [data-test-id="target-row"], [data-test="target-row"]',
      intoView: true,
      deltaX: undefined,
      deltaY: undefined,
    },
  ]);
});

test('CDP observations and selectors traverse open shadow roots', async () => {
  const expressions: string[] = [];
  const page = new CdpWebPage({
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'Runtime.evaluate') {
        expressions.push(String(params.expression));
        return {
          result: {
            value: {
              x: 10,
              y: 20,
              selector: '[data-test-id="inside-shadow"]',
              tagName: 'BUTTON',
            },
          },
        };
      }
      return {};
    },
  } as never);

  await page.click('[data-test-id="inside-shadow"]');
  await page.observe(['ui.visible']);

  assert.match(expressions[0] ?? '', /querySelectorDeep/u);
  assert.match(expressions[0] ?? '', /shadowRoot/u);
  const observationExpression = expressions[1] ?? '';
  assert.match(observationExpression, /querySelectorAllDeep/u);
  assert.match(observationExpression, /shadowRoot/u);
  assert.match(observationExpression, /testAttribute/u);
  assert.match(observationExpression, /'data-test-id'/u);
  assert.match(observationExpression, /instanceof ShadowRoot/u);
  assert.doesNotMatch(observationExpression, /getAttribute\('value'\)/u);
});

test('CDP navigation waits for the loaded document before returning', async () => {
  let loadHandler: (() => void) | undefined;
  let ready = false;
  const calls: string[] = [];
  const page = new CdpWebPage({
    on(method: string, handler: () => void) {
      assert.equal(method, 'Page.loadEventFired');
      loadHandler = handler;
      return () => {
        loadHandler = undefined;
      };
    },
    async call(method: string, params: Record<string, unknown>) {
      calls.push(method);
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        if (expression.startsWith('new URL(')) {
          return { result: { value: 'https://example.test/next' } };
        }
        if (expression.startsWith('new Promise(')) return { result: { value: true } };
        return {
          result: {
            value: { ready, url: 'https://example.test/next' },
          },
        };
      }
      if (method === 'Page.navigate') {
        setTimeout(() => {
          ready = true;
          loadHandler?.();
        }, 20);
        return { loaderId: 'new-document' };
      }
      return {};
    },
  } as never);

  await page.navigate('https://example.test/next', 1_000);

  assert.deepEqual(calls, [
    'Runtime.evaluate',
    'Page.navigate',
    'Runtime.evaluate',
    'Runtime.evaluate',
  ]);
  assert.equal(loadHandler, undefined);
});

test('CDP same-document navigation waits for the requested location', async () => {
  let pollCount = 0;
  const page = new CdpWebPage({
    on() {
      return () => {};
    },
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'Page.navigate') return {};
      const expression = String(params.expression);
      if (expression.startsWith('new URL(')) {
        return { result: { value: 'https://example.test/#ready' } };
      }
      if (expression.startsWith('new Promise(')) return { result: { value: true } };
      pollCount += 1;
      return {
        result: {
          value: {
            ready: true,
            url: pollCount > 1 ? 'https://example.test/#ready' : 'https://example.test/#old',
          },
        },
      };
    },
  } as never);

  await page.navigate('#ready', 1_000);

  assert.equal(pollCount, 2);
});

test('CDP navigation waits for a quiet render frame after route readiness', async () => {
  const expressions: string[] = [];
  const page = new CdpWebPage({
    on() {
      return () => {};
    },
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'Page.navigate') return {};
      const expression = String(params.expression);
      expressions.push(expression);
      if (expression.startsWith('new URL(')) {
        return { result: { value: 'https://example.test/#ready' } };
      }
      if (expression.startsWith('new Promise(')) return { result: { value: true } };
      return {
        result: { value: { ready: true, url: 'https://example.test/#ready' } },
      };
    },
  } as never);

  await page.navigate('#ready', 1_000);

  const settleExpression = expressions.find((expression) => expression.startsWith('new Promise('));
  assert.match(settleExpression ?? '', /MutationObserver/u);
  assert.match(settleExpression ?? '', /requestAnimationFrame/u);
});

test('CDP deep text matching uses rendered text without scanning textContent', async () => {
  const expressions: string[] = [];
  const page = new CdpWebPage({
    async call(method: string, params: Record<string, unknown>) {
      assert.equal(method, 'Runtime.evaluate');
      expressions.push(String(params.expression));
      return { result: { value: true } };
    },
  } as never);

  await page.waitFor({ text: 'Review Workspace', timeoutMs: 100 });

  assert.match(expressions[0] ?? '', /renderedTextDeep/u);
  assert.match(expressions[0] ?? '', /root\.body\.innerText/u);
  assert.doesNotMatch(expressions[0] ?? '', /textContent/u);
});

test('extracts browser extension ids from CDP targets', () => {
  assert.equal(
    extensionIdFromTarget({ url: 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/home.html' }),
    'nkbihfbeogaeaoehlefnkodbefgpgknn',
  );
  assert.equal(extensionIdFromTarget({ url: 'https://example.test' }), undefined);
});
