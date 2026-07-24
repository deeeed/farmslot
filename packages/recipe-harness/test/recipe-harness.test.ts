import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  OFFICIAL_RECIPE_ACTIONS,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionCatalogEntry,
  type RecipeActionManifestDocument,
  validateRecipeArtifactPackage,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createStandardUiAdapters, type UiActionTransport } from '../src/adapters/ui.js';
import { runRecipeHarnessCli } from '../src/cli/index.js';
import { parseRecipeParamAssignments, validateRecipeCliInput } from '../src/cli/support.js';
import { readJsonFile, writeJsonFile } from '../src/core/json.js';
import { writeFileWithinRoot } from '../src/core/path.js';
import { cleanupAbortedRunVideoRecording } from '../src/core/recording-cleanup.js';
import {
  createRecipeRunner as createRawRecipeRunner,
  defineActionAdapter,
} from '../src/core/runner.js';
import type { VideoRecorder, VideoRecorderStartRequest } from '../src/core/types.js';
import { createCaptureHelperVideoRecorder } from '../src/recording/capture-helper.js';
import { extensionIdFromTarget } from '../src/runtime/browser-extension.js';
import { CdpWebPage, createCdpWebUiTransport } from '../src/runtime/cdp.js';
import {
  createReactNativeBridgeUiTransport,
  type ReactNativeBridgeCommand,
} from '../src/runtime/react-native-bridge.js';
import { RECIPE_HARNESS_VERSION } from '../src/version.js';

const officialActions = new Set<string>(OFFICIAL_RECIPE_ACTIONS);

const stringParam = { type: 'string' } as const;
const numberParam = { type: 'number' } as const;
const openObjectParam = { type: 'object', additionalProperties: true } as const;
const objectArrayParam = {
  type: 'array',
  items: { type: ['string', 'object'], additionalProperties: true },
} as const;

const testActionProperties: Record<string, Record<string, unknown>> = {
  command: { cmd: stringParam },
  assert_file: { path: stringParam },
  assert_json: { path: stringParam, assert: openObjectParam },
  assert_output: { source: stringParam, stream: stringParam, contains: stringParam },
  watch_logs: { path: stringParam, contains: stringParam, scope: stringParam },
  index_artifacts: { artifacts: objectArrayParam },
  wait: { ms: numberParam },
  switch: { value: stringParam, equals: stringParam },
  'ui.press': { note: stringParam, selector: stringParam },
  'ui.scroll': { detail: stringParam, test_id: stringParam, delta_y: numberParam },
  'app.hud': { text: stringParam },
  'demo.consume': { count: numberParam },
  'example.route': { source: openObjectParam },
};

function testActionSchema(action: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: testActionProperties[action] ?? {},
    additionalProperties: false,
  };
}

function testAction(
  action: string,
  overrides: Partial<RecipeActionCatalogEntry> = {},
): RecipeActionCatalogEntry {
  return {
    description: `Test ${action}.`,
    ...(action === 'call' || action === 'end' ? {} : { schema: testActionSchema(action) }),
    ...(!officialActions.has(action) ? { execution_capabilities: [] } : {}),
    examples:
      action === 'end'
        ? [{ action, status: 'pass' }]
        : action === 'call'
          ? [
              {
                action,
                intent: 'Reuse the requested test recipe.',
                ref: 'test.child',
                params: {},
                next: 'done',
              },
            ]
          : [{ action, intent: 'Confirm the requested test state.', next: 'done' }],
    ...overrides,
  };
}

function withTestSchemas(manifest: RecipeActionManifestDocument): RecipeActionManifestDocument {
  return {
    ...manifest,
    actions: Object.fromEntries(
      Object.entries(manifest.actions).map(([action, entry]) => [
        action,
        {
          description: entry.description ?? `Test ${action}.`,
          ...entry,
          ...(action === 'call' || action === 'end'
            ? {}
            : {
                schema: entry.schema ?? testActionSchema(action),
              }),
          examples:
            entry.examples.length > 0
              ? entry.examples
              : action === 'end'
                ? [{ action, status: 'pass' }]
                : action === 'call'
                  ? [
                      {
                        action,
                        intent: 'Reuse the requested test recipe.',
                        ref: 'test.child',
                        params: {},
                        next: 'done',
                      },
                    ]
                  : [
                      {
                        action,
                        intent: 'Confirm the requested test state.',
                        next: 'done',
                      },
                    ],
          ...(action === 'switch' && !entry.result_cases ? { result_cases: ['match'] } : {}),
        },
      ]),
    ),
  };
}

function testManifest(actions: readonly string[]): RecipeActionManifestDocument {
  return withTestSchemas({
    $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
    actions: Object.fromEntries(actions.map((action) => [action, testAction(action)])),
  });
}

const coreActionManifest: RecipeActionManifestDocument = testManifest([
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
]);

test('tracked core action manifests match the bundled adapter contract', async () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const manifestPaths = [
    'apps/companion/scripts/agentic/recipe/action-manifest.json',
    'docs/examples/recipes/farmslot-v1.action-manifest.json',
    'packages/expo-recipe/templates/scripts/agentic/recipe/action-manifest.json',
    'packages/expo-recipe/templates/scripts/agentic/recipe/action-manifest.with-bridge.json',
  ];
  const adapters = new Map(
    createStandardCoreAdapters().map((adapter) => [adapter.action, adapter] as const),
  );
  const commandAdapter = adapters.get('command');
  const assertOutputAdapter = adapters.get('assert_output');
  assert.ok(commandAdapter);
  assert.ok(assertOutputAdapter);
  const projectRoot = await createTempRoot();
  const outputs = new Map<string, unknown>([
    ['command', { exitCode: 0, stdout: 'ready\n', stderr: '' }],
  ]);

  try {
    for (const relativePath of manifestPaths) {
      const manifest = JSON.parse(
        await readFile(path.join(repoRoot, relativePath), 'utf-8'),
      ) as RecipeActionManifestDocument;
      const command = manifest.actions.command;
      const assertOutput = manifest.actions.assert_output;
      assert.deepEqual(
        Object.keys(command.schema?.properties as Record<string, unknown>).sort(),
        ['allow_failure', 'cmd', 'cwd', 'timeout_ms'],
        relativePath,
      );
      assert.deepEqual(command.schema?.required, ['cmd'], relativePath);
      assert.deepEqual(
        Object.keys(assertOutput.schema?.properties as Record<string, unknown>).sort(),
        ['assert', 'contains', 'match', 'source', 'stream'],
        relativePath,
      );
      assert.deepEqual(assertOutput.schema?.required, ['source'], relativePath);

      const context = {
        nodeId: 'example',
        recipe: {},
        projectRoot,
        artifactsDir: path.join(projectRoot, 'artifacts'),
        env: {},
        outputs,
        getOutput: (nodeId: string) => outputs.get(nodeId),
        resolveProjectPath: (relativePath: string) => path.join(projectRoot, relativePath),
        resolveArtifactPath: (relativePath: string) =>
          path.join(projectRoot, 'artifacts', relativePath),
        getRunFileOffset: () => undefined,
        registerArtifact: () => undefined,
        logger: { info() {}, warn() {}, error() {} },
      };
      await commandAdapter.execute(command.examples[0], context);
      await assertOutputAdapter.execute(assertOutput.examples[0], context);
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function createRecipeRunner(options: Parameters<typeof createRawRecipeRunner>[0]) {
  return createRawRecipeRunner({
    ...options,
    actionManifest: withTestSchemas(options.actionManifest),
    adapters: options.adapters.map((adapter) => ({
      ...adapter,
      source: adapter.source ?? {
        kind: 'bundled',
        trust: 'trusted',
        name: 'recipe harness test',
      },
    })),
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'recipe harness test' },
  });
}

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

function recipeDocument(
  nodes: Record<string, Record<string, unknown>>,
  options: {
    entry?: string;
    teardown?: string;
    description?: string;
    paramsSchema?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: options.description ?? 'Exercises the Recipe v1 runtime contract.',
    ...(options.paramsSchema ? { paramsSchema: options.paramsSchema } : {}),
    workflow: {
      entry: options.entry ?? Object.keys(nodes)[0],
      nodes,
      ...(options.teardown ? { teardown: options.teardown } : {}),
    },
  };
}

test('CLI parameter parsing preserves prototype-sensitive keys for loud schema validation', () => {
  const params = parseRecipeParamAssignments(['__proto__={"polluted":true}']);
  assert.deepEqual(Object.keys(params), ['__proto__']);
  assert.equal(Object.hasOwn(params, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(params), Object.prototype);
});

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
    title: 'Recipe harness smoke',
    description: 'Runs a command, asserts outputs, and publishes artifacts.',
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
  };
}

function createSingleActionRecipe(node: Record<string, unknown>): unknown {
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Single action security check',
    description: 'Exercises one adapter through the real runner.',
    workflow: {
      entry: 'check',
      nodes: {
        check: { ...node, intent: 'Exercise the selected adapter', next: 'done' },
        done: { action: 'end', status: 'pass' },
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
      'recipe-resolution.json',
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
    const recipeResolution = await readJsonFile(path.join(artifactsDir, 'recipe-resolution.json'));
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
    assert.equal(
      (summary as { harness?: { version?: string } }).harness?.version,
      RECIPE_HARNESS_VERSION,
    );

    const packageResult = validateRecipeArtifactPackage({
      recipe,
      manifest,
      recipeResolution,
      artifactPaths: await listRelativeFiles(artifactsDir),
    });
    assert.equal(packageResult.status, 'valid', JSON.stringify(packageResult.findings));
    assert.deepEqual(packageResult.findings, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('project read and artifact export actions reject symlink escapes', async () => {
  const tempRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  try {
    const outsideFile = path.join(outsideRoot, 'secret.json');
    await writeFile(outsideFile, '{"secret":true}\n');
    await symlink(outsideFile, path.join(tempRoot, 'linked.json'));
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });

    for (const [index, node] of [
      { action: 'assert_file', path: 'linked.json' },
      {
        action: 'assert_json',
        path: 'linked.json',
        assert: { path: '$.secret', operator: 'eq', value: true },
      },
      { action: 'index_artifacts', artifacts: ['linked.json'] },
    ].entries()) {
      const result = await runner.run({
        recipeDocument: createSingleActionRecipe(node),
        artifactsDir: path.join(tempRoot, `artifacts-${index}`),
        projectRoot: tempRoot,
      });
      assert.equal(result.status, 'fail');
      const trace = JSON.parse(await readFile(result.tracePath, 'utf-8')) as Array<{
        error?: string;
      }>;
      assert.match(trace.find((entry) => entry.error)?.error ?? '', /resolves outside its root/u);
    }

    await assert.rejects(
      runner.run({
        recipeDocument: createSingleActionRecipe({ action: 'watch_logs', path: 'linked.json' }),
        artifactsDir: path.join(tempRoot, 'watch-artifacts'),
        projectRoot: tempRoot,
      }),
      /resolves outside its root/u,
    );
  } finally {
    await Promise.all([
      rm(tempRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  }
});

test('artifact writes reject pre-existing symlink destinations', async () => {
  const tempRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  try {
    await writeFile(path.join(tempRoot, 'proof.txt'), 'approved proof\n');
    const artifactsDir = path.join(tempRoot, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const outsideFile = path.join(outsideRoot, 'untouched.txt');
    await writeFile(outsideFile, 'do not replace\n');
    await symlink(outsideFile, path.join(artifactsDir, 'proof.txt'));
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipeDocument: createSingleActionRecipe({
        action: 'index_artifacts',
        artifacts: ['proof.txt'],
      }),
      artifactsDir,
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'fail');
    assert.equal(await readFile(outsideFile, 'utf-8'), 'do not replace\n');
  } finally {
    await Promise.all([
      rm(tempRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  }
});

test('artifact parent rejection does not create directories through an escaping symlink', async () => {
  const tempRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  try {
    const artifactsDir = path.join(tempRoot, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    await symlink(outsideRoot, path.join(artifactsDir, 'escape'));
    await assert.rejects(
      writeFileWithinRoot(artifactsDir, 'escape/created-before-reject/proof.txt', 'proof\n'),
      /resolves outside its root/u,
    );
    await assert.rejects(
      readFile(path.join(outsideRoot, 'created-before-reject', 'proof.txt')),
      /ENOENT/u,
    );
    await assert.rejects(access(path.join(outsideRoot, 'created-before-reject')), /ENOENT/u);
  } finally {
    await Promise.all([
      rm(tempRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
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
      title: 'stale watch_logs proof',
      description: 'Pre-run stale markers must not satisfy watch_logs.',
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
    };
    const failResult = await runner.run({
      recipeDocument: failRecipe,
      artifactsDir: path.join(tempRoot, 'artifacts-fail'),
      projectRoot: tempRoot,
    });
    assert.equal(failResult.status, 'fail');

    const passRecipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'fresh watch_logs proof',
      description: 'Run-scoped watch_logs sees lines emitted during this run.',
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
    };
    const passResult = await runner.run({
      recipeDocument: passRecipe,
      artifactsDir: path.join(tempRoot, 'artifacts-pass'),
      projectRoot: tempRoot,
    });
    assert.equal(passResult.status, 'pass');

    const fileScopeRecipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'file scoped watch_logs proof',
      description: 'Recipes can explicitly scan the whole file when needed.',
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
    };
    const fileScopeResult = await runner.run({
      recipeDocument: fileScopeRecipe,
      artifactsDir: path.join(tempRoot, 'artifacts-file-scope'),
      projectRoot: tempRoot,
    });
    assert.equal(fileScopeResult.status, 'pass');

    const libraryRoot = path.join(tempRoot, 'watch-library');
    await mkdir(path.join(libraryRoot, 'recipes', 'local'), { recursive: true });
    await writeJsonFile(path.join(libraryRoot, 'recipes', 'local', 'watch-stale.recipe.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Checks that called recipes share the run-scoped log baseline.',
      workflow: {
        entry: 'watch',
        nodes: {
          watch: {
            action: 'watch_logs',
            intent: 'Check stale markers do not satisfy run-scoped log matching in recipes.',
            path: 'logs/app.log',
            contains: 'STALE_MARKER',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    const nestedRecipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Nested recipe scoped watch_logs proof',
      description: 'Run-scoped watch_logs also applies inside called recipes.',
      workflow: {
        entry: 'append',
        nodes: {
          append: {
            action: 'command',
            intent: 'Append a fresh marker before calling the recipe.',
            cmd: "node -e \"require('fs').appendFileSync('logs/app.log','FLOW_FRESH_MARKER\\n')\"",
            next: 'call-recipe',
          },
          'call-recipe': {
            action: 'call',
            intent: 'Run a recipe whose watch_logs node must use the run baseline.',
            ref: 'local.watch-stale',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    };
    const nestedResult = await runner.run({
      recipeDocument: nestedRecipe,
      librarySources: [
        {
          name: 'watch-library',
          root: libraryRoot,
          provenance: { kind: 'library', trust: 'trusted', name: 'watch-library' },
        },
      ],
      artifactsDir: path.join(tempRoot, 'artifacts-nested'),
      projectRoot: tempRoot,
    });
    assert.equal(nestedResult.status, 'fail');
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

test('record-video stages privately and rejects a symlinked artifact destination', async () => {
  const tempRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  try {
    const artifactsDir = path.join(tempRoot, 'artifacts');
    await mkdir(path.join(artifactsDir, 'videos'), { recursive: true });
    const outsideFile = path.join(outsideRoot, 'untouched.mp4');
    await writeFile(outsideFile, 'do not replace');
    await symlink(outsideFile, path.join(artifactsDir, 'videos', 'recipe-run.mp4'));
    let recorderOutputPath = '';
    const recorder: VideoRecorder = {
      name: 'fake-recorder',
      async start(request) {
        recorderOutputPath = request.outputPath;
        return {
          async stop() {
            await writeFile(request.outputPath, 'safe staged mp4');
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
      artifactsDir,
      projectRoot: tempRoot,
      recordVideo: true,
    });

    assert.equal(result.status, 'fail');
    assert.equal(await readFile(outsideFile, 'utf-8'), 'do not replace');
    assert.equal(recorderOutputPath.startsWith(`${artifactsDir}${path.sep}`), false);
  } finally {
    await Promise.all([
      rm(tempRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
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

test('executes preparation, proof, and teardown through one explicit graph', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Explicit lifecycle recipe',
      description: 'Expresses preparation and proof in one graph with guaranteed teardown.',
      workflow: {
        entry: 'prepare',
        teardown: 'restore',
        nodes: {
          prepare: {
            action: 'command',
            intent: 'Prepare deterministic state before evaluating the claim.',
            cmd: "node -e \"require('fs').writeFileSync('order.txt','prepare\\n')\"",
            next: 'proof',
          },
          proof: {
            action: 'command',
            intent: 'Capture the runtime evidence for the claim.',
            cmd: "node -e \"require('fs').appendFileSync('order.txt','proof\\n')\"",
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
          restore: {
            action: 'command',
            intent: 'Restore the environment after evidence collection.',
            cmd: "node -e \"require('fs').appendFileSync('order.txt','teardown\\n')\"",
            next: 'restored',
          },
          restored: { action: 'end', status: 'pass' },
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
      'prepare\nproof\nteardown\n',
    );
    const trace = await readJsonFile(result.tracePath);
    assert.deepEqual(
      (trace as Array<{ nodeId: string }>).map((entry) => entry.nodeId),
      ['prepare', 'proof', 'done', 'restore', 'restored'],
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runs teardown after a main graph action fails', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Guarantees cleanup even when evidence collection fails.',
      workflow: {
        entry: 'fail-proof',
        teardown: 'cleanup',
        nodes: {
          'fail-proof': {
            action: 'command',
            intent: 'Exercise the failing proof path.',
            cmd: 'node -e "process.exit(7)"',
            next: 'unexpected',
          },
          unexpected: { action: 'end', status: 'pass' },
          cleanup: {
            action: 'command',
            intent: 'Record that cleanup still completed.',
            cmd: "node -e \"require('fs').writeFileSync('cleanup.txt','done')\"",
            next: 'clean',
          },
          clean: { action: 'end', status: 'pass' },
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
    assert.equal(await readFile(path.join(tempRoot, 'cleanup.txt'), 'utf-8'), 'done');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runs teardown when an output reference cannot be resolved', async () => {
  const tempRoot = await createTempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipeDocument: recipeDocument(
        {
          consume: {
            action: 'command',
            intent: 'Use the value produced by the missing step.',
            cmd: '{{outputs.missing.cmd}}',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
          cleanup: {
            action: 'command',
            intent: 'Record that cleanup still completed.',
            cmd: "node -e \"require('fs').writeFileSync('cleanup.txt','done')\"",
            next: 'clean',
          },
          clean: { action: 'end', status: 'pass' },
        },
        { teardown: 'cleanup' },
      ),
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'fail');
    assert.equal(await readFile(path.join(tempRoot, 'cleanup.txt'), 'utf-8'), 'done');
    const trace = (await readJsonFile(result.tracePath)) as Array<{
      nodeId: string;
      ok: boolean;
      error?: string;
    }>;
    assert.match(trace[0]?.error ?? '', /output missing\.cmd is not defined/u);
    assert.deepEqual(
      trace.map(({ nodeId, ok }) => ({ nodeId, ok })),
      [
        { nodeId: 'consume', ok: false },
        { nodeId: 'cleanup', ok: true },
        { nodeId: 'clean', ok: true },
      ],
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a teardown failure cannot be masked by a passing main graph', async () => {
  const tempRoot = await createTempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'Reports teardown failure as the final recipe result.',
        workflow: {
          entry: 'done',
          teardown: 'fail-cleanup',
          nodes: {
            done: { action: 'end', status: 'pass' },
            'fail-cleanup': {
              action: 'command',
              intent: 'Exercise teardown failure precedence.',
              cmd: 'node -e "process.exit(9)"',
              next: 'clean',
            },
            clean: { action: 'end', status: 'pass' },
          },
        },
      },
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'fail');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('external recipe roots can call a library recipe with the same filename ref', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    await mkdir(path.join(libraryRoot, 'recipes'), { recursive: true });
    await writeJsonFile(
      path.join(libraryRoot, 'recipes', 'smoke.recipe.json'),
      recipeDocument({ done: { action: 'end', status: 'pass' } }),
    );
    const recipePath = path.join(tempRoot, 'smoke.recipe.json');
    await writeJsonFile(
      recipePath,
      recipeDocument({
        call: {
          action: 'call',
          intent: 'Run the library smoke recipe.',
          ref: 'smoke',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      }),
    );
    const artifactsDir = path.join(tempRoot, 'artifacts');
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipePath,
      librarySources: [
        {
          name: 'collision-library',
          root: libraryRoot,
          provenance: { kind: 'library', trust: 'trusted', name: 'collision-library' },
        },
      ],
      artifactsDir,
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'pass');
    const resolution = (await readJsonFile(path.join(artifactsDir, 'recipe-resolution.json'))) as {
      root?: { ref?: string };
      edges?: Array<{ from?: string; to?: string }>;
    };
    assert.match(resolution.root?.ref ?? '', /^\$root:sha256:[a-f0-9]{64}$/u);
    assert.equal(resolution.edges?.[0]?.to, 'smoke');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runs nested parameterized recipes with defaults and explicit falsy overrides', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    await mkdir(path.join(libraryRoot, 'recipes', 'example'), { recursive: true });
    await writeJsonFile(
      path.join(libraryRoot, 'recipes', 'example', 'write.recipe.json'),
      recipeDocument(
        {
          write: {
            action: 'command',
            intent: 'Write the resolved recipe parameters.',
            cmd: "printf '%s:%s' '{{params.text}}' '{{params.enabled}}' > '{{params.path}}'",
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
        {
          paramsSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', default: 'default.txt' },
              text: { type: 'string', default: 'hello' },
              enabled: { type: 'boolean', default: true },
            },
          },
        },
      ),
    );
    await writeJsonFile(
      path.join(libraryRoot, 'recipes', 'example', 'parent.recipe.json'),
      recipeDocument({
        'call-default': {
          action: 'call',
          intent: 'Run the child recipe with defaults.',
          ref: 'example.write',
          next: 'call-overrides',
        },
        'call-overrides': {
          action: 'call',
          intent: 'Run the child recipe with explicit falsy values.',
          ref: 'example.write',
          params: { path: 'override.txt', text: '', enabled: false },
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      }),
    );
    await writeJsonFile(
      path.join(libraryRoot, 'recipes', 'unrelated.recipe.json'),
      recipeDocument({
        unused: {
          action: 'another-platform.action',
          intent: 'Remain available to another runner without blocking this recipe.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      }),
    );

    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const artifactsDir = path.join(tempRoot, 'artifacts');
    const result = await runner.run({
      recipeDocument: recipeDocument({
        'call-parent': {
          action: 'call',
          intent: 'Run the composed parent recipe.',
          ref: 'example.parent',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      }),
      librarySources: [
        {
          name: 'test-library',
          root: libraryRoot,
          provenance: {
            kind: 'library',
            trust: 'trusted',
            name: 'test-library',
          },
        },
      ],
      artifactsDir,
      projectRoot: tempRoot,
    });

    assert.equal(result.status, 'pass');
    assert.equal(await readFile(path.join(tempRoot, 'default.txt'), 'utf-8'), 'hello:true');
    assert.equal(await readFile(path.join(tempRoot, 'override.txt'), 'utf-8'), ':false');
    const trace = (await readJsonFile(result.tracePath)) as Array<{
      nodeId?: string;
      recipe?: { ref?: string; digest?: string; source?: string; file?: string };
    }>;
    assert.ok(trace.some((entry) => entry.nodeId === 'call-parent/call-default/write'));
    assert.ok(trace.some((entry) => entry.nodeId === 'call-parent/call-overrides/write'));
    assert.deepEqual(trace.find((entry) => entry.nodeId === 'call-parent')?.recipe, {
      ref: 'example.parent',
      digest: trace.find((entry) => entry.nodeId === 'call-parent')?.recipe?.digest,
      source: 'test-library',
      file: 'recipes/example/parent.recipe.json',
    });
    assert.match(
      trace.find((entry) => entry.nodeId === 'call-parent')?.recipe?.digest ?? '',
      /^sha256:[a-f0-9]{64}$/u,
    );
    const resolution = (await readJsonFile(path.join(artifactsDir, 'recipe-resolution.json'))) as {
      dependencies?: unknown[];
      edges?: unknown[];
    };
    assert.equal(resolution.dependencies?.length, 2);
    assert.equal(resolution.edges?.length, 3);
    assert.equal(
      (await listRelativeFiles(artifactsDir)).filter((entry) =>
        entry.startsWith('resolved-recipes/'),
      ).length,
      2,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('preserves typed parent outputs across recipe call parameters', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    await mkdir(path.join(libraryRoot, 'recipes', 'example'), { recursive: true });
    await writeJsonFile(
      path.join(libraryRoot, 'recipes', 'example', 'consume.recipe.json'),
      recipeDocument(
        {
          consume: {
            action: 'demo.consume',
            intent: 'Use the count produced by the parent recipe.',
            count: '{{params.count}}',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
        {
          paramsSchema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
            required: ['count'],
            additionalProperties: false,
          },
        },
      ),
    );
    const actionManifest: RecipeActionManifestDocument = withTestSchemas({
      ...testManifest(['call', 'end']),
      actions: {
        ...testManifest(['call', 'end']).actions,
        'demo.produce': testAction('demo.produce', {
          description: 'Produce a typed count.',
          schema: { type: 'object', additionalProperties: false },
        }),
        'demo.consume': testAction('demo.consume', {
          description: 'Consume a typed count.',
          schema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
            required: ['count'],
            additionalProperties: false,
          },
          examples: [
            {
              action: 'demo.consume',
              intent: 'Consume the typed test count.',
              count: 1,
              next: 'done',
            },
          ],
        }),
      },
    });
    let consumed: unknown;
    const runner = createRecipeRunner({
      actionManifest,
      adapters: [
        defineActionAdapter({
          action: 'demo.produce',
          async execute() {
            return { output: { count: 7 } };
          },
        }),
        defineActionAdapter({
          action: 'demo.consume',
          async execute(node) {
            consumed = node.count;
            return { output: { count: node.count } };
          },
        }),
      ],
    });
    const document = recipeDocument({
      produce: {
        action: 'demo.produce',
        intent: 'Produce the count needed by the child recipe.',
        next: 'consume',
      },
      consume: {
        action: 'call',
        intent: 'Reuse the typed count consumer.',
        ref: 'example.consume',
        params: { count: '{{outputs.produce.count}}' },
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    });
    const request = {
      recipeDocument: document,
      librarySources: [
        {
          name: 'typed-output-library',
          root: libraryRoot,
          provenance: {
            kind: 'library' as const,
            trust: 'trusted' as const,
            name: 'typed-output-library',
          },
        },
      ],
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    };
    await runner.preflight(request);
    const result = await runner.run(request);
    assert.equal(result.status, 'pass');
    assert.equal(consumed, 7);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects action values whose resolved output violates the manifest schema', async () => {
  const tempRoot = await createTempRoot();
  try {
    let consumed = false;
    const actionManifest: RecipeActionManifestDocument = withTestSchemas({
      ...testManifest(['end']),
      actions: {
        ...testManifest(['end']).actions,
        'demo.produce': testAction('demo.produce', {
          schema: { type: 'object', additionalProperties: false },
        }),
        'demo.consume': testAction('demo.consume', {
          schema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
            required: ['count'],
            additionalProperties: false,
          },
          examples: [
            {
              action: 'demo.consume',
              intent: 'Consume the typed test count.',
              count: 1,
              next: 'done',
            },
          ],
        }),
      },
    });
    const runner = createRecipeRunner({
      actionManifest,
      adapters: [
        defineActionAdapter({
          action: 'demo.produce',
          async execute() {
            return { output: { count: 'seven' } };
          },
        }),
        defineActionAdapter({
          action: 'demo.consume',
          async execute() {
            consumed = true;
            return {};
          },
        }),
      ],
    });
    const result = await runner.run({
      recipeDocument: recipeDocument({
        produce: {
          action: 'demo.produce',
          intent: 'Produce a value for the next step.',
          next: 'consume',
        },
        consume: {
          action: 'demo.consume',
          intent: 'Use the produced count.',
          count: '{{outputs.produce.count}}',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      }),
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'fail');
    assert.equal(consumed, false);
    const trace = (await readJsonFile(result.tracePath)) as Array<{ error?: string }>;
    assert.match(trace.at(-1)?.error ?? '', /invalid_param_value_type/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects invalid nested call parameters during preflight', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    await mkdir(path.join(libraryRoot, 'recipes'), { recursive: true });
    await writeJsonFile(
      path.join(libraryRoot, 'recipes', 'child.recipe.json'),
      recipeDocument(
        {
          done: { action: 'end', status: 'pass' },
        },
        {
          paramsSchema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
            required: ['count'],
            additionalProperties: false,
          },
        },
      ),
    );
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    await assert.rejects(
      runner.preflight({
        recipeDocument: recipeDocument({
          child: {
            action: 'call',
            intent: 'Reuse the typed child recipe.',
            ref: 'child',
            params: { count: 'seven' },
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        }),
        librarySources: [{ root: libraryRoot }],
        artifactsDir: path.join(tempRoot, 'artifacts'),
        projectRoot: tempRoot,
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'RECIPE_PARAMS_INVALID' &&
        /params\.count/u.test(error.message),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects recipe call cycles before running actions', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    await mkdir(path.join(libraryRoot, 'recipes'), { recursive: true });
    for (const [ref, target] of [
      ['a', 'b'],
      ['b', 'a'],
    ]) {
      await writeJsonFile(
        path.join(libraryRoot, 'recipes', `${ref}.recipe.json`),
        recipeDocument({
          call: {
            action: 'call',
            intent: `Call recipe ${target}.`,
            ref: target,
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        }),
      );
    }
    let actionRuns = 0;
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters().map((adapter) =>
        adapter.action === 'wait'
          ? {
              ...adapter,
              async execute(node, context) {
                actionRuns += 1;
                return adapter.execute(node, context);
              },
            }
          : adapter,
      ),
    });
    await assert.rejects(
      runner.preflight({
        recipeDocument: recipeDocument({
          call: {
            action: 'call',
            intent: 'Enter the cyclic dependency graph.',
            ref: 'a',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        }),
        librarySources: [
          {
            name: 'cycle-library',
            root: libraryRoot,
            provenance: { kind: 'library', trust: 'trusted', name: 'cycle-library' },
          },
        ],
        artifactsDir: path.join(tempRoot, 'artifacts'),
        projectRoot: tempRoot,
      }),
      /cycle detected/u,
    );
    assert.equal(actionRuns, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects depth overflow and invalid nested parameters before side effects', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    await mkdir(path.join(libraryRoot, 'recipes'), { recursive: true });
    for (let level = 1; level <= 8; level += 1) {
      await writeJsonFile(
        path.join(libraryRoot, 'recipes', `level-${level}.recipe.json`),
        recipeDocument(
          level === 8
            ? { done: { action: 'end', status: 'pass' } }
            : {
                call: {
                  action: 'call',
                  intent: `Call recipe level ${level + 1}.`,
                  ref: `level-${level + 1}`,
                  next: 'done',
                },
                done: { action: 'end', status: 'pass' },
              },
        ),
      );
    }
    await writeJsonFile(
      path.join(libraryRoot, 'recipes', 'required.recipe.json'),
      recipeDocument(
        { done: { action: 'end', status: 'pass' } },
        {
          paramsSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['value'],
            properties: { value: { type: 'string' } },
          },
        },
      ),
    );

    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const source = {
      name: 'preflight-library',
      root: libraryRoot,
      provenance: { kind: 'library' as const, trust: 'trusted' as const },
    };
    const rootCalling = (ref: string, beforeCall = false) =>
      recipeDocument(
        {
          ...(beforeCall
            ? {
                write: {
                  action: 'command',
                  intent: 'Create a marker only after composition preflight succeeds.',
                  cmd: 'touch should-not-run.txt',
                  next: 'call',
                },
              }
            : {}),
          call: { action: 'call', intent: `Call ${ref}.`, ref, next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
        { entry: beforeCall ? 'write' : 'call' },
      );

    await runner.preflight({
      recipeDocument: rootCalling('level-2'),
      librarySources: [source],
      artifactsDir: path.join(tempRoot, 'accepted-artifacts'),
      projectRoot: tempRoot,
    });
    await assert.rejects(
      runner.run({
        recipeDocument: rootCalling('level-1', true),
        librarySources: [source],
        artifactsDir: path.join(tempRoot, 'depth-artifacts'),
        projectRoot: tempRoot,
      }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'RECIPE_CALL_DEPTH_EXCEEDED',
    );
    await assert.rejects(
      runner.run({
        recipeDocument: rootCalling('required', true),
        librarySources: [source],
        artifactsDir: path.join(tempRoot, 'params-artifacts'),
        projectRoot: tempRoot,
      }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'RECIPE_PARAMS_INVALID',
    );
    assert.ok(!(await readdir(tempRoot)).includes('should-not-run.txt'));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('routes from declared result cases and ignores adapter-owned status or destinations', async () => {
  const tempRoot = await createTempRoot();
  try {
    const actionManifest: RecipeActionManifestDocument = {
      ...coreActionManifest,
      actions: {
        ...coreActionManifest.actions,
        'example.route': testAction('example.route', {
          description: 'Return a semantic result case.',
          schema: { type: 'object', additionalProperties: false },
          result_cases: ['match'],
        }),
      },
    };
    const runner = createRecipeRunner({
      actionManifest,
      adapters: [
        ...createStandardCoreAdapters(),
        defineActionAdapter({
          action: 'example.route',
          source: { kind: 'bundled', trust: 'trusted', name: 'recipe harness test' },
          async execute() {
            return { case: 'match', status: 'fail', next: 'wrong' } as never;
          },
        }),
      ],
    });
    const result = await runner.run({
      recipeDocument: recipeDocument({
        route: {
          action: 'example.route',
          intent: 'Select the path from the observed semantic case.',
          cases: { match: 'right' },
          default: 'wrong',
        },
        right: { action: 'end', status: 'pass' },
        wrong: { action: 'end', status: 'fail' },
      }),
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'pass');
    const trace = (await readJsonFile(result.tracePath)) as Array<{ nodeId?: string }>;
    assert.deepEqual(
      trace.map((entry) => entry.nodeId),
      ['route', 'right'],
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('switch routes on resolved string parameters without exposing runtime internals', async () => {
  const tempRoot = await createTempRoot();
  try {
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipeDocument: recipeDocument(
        {
          choose: {
            action: 'switch',
            value: '{{params.mode}}',
            equals: 'background_resume',
            intent: 'Choose the requested lifecycle preparation path.',
            cases: { match: 'background' },
            default: 'warm',
          },
          background: { action: 'end', status: 'pass' },
          warm: { action: 'end', status: 'fail' },
        },
        {
          paramsSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: {
                type: 'string',
                enum: ['warm', 'background_resume'],
                default: 'warm',
              },
            },
          },
        },
      ),
      params: { mode: 'background_resume' },
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
    });
    assert.equal(result.status, 'pass');
    const trace = (await readJsonFile(result.tracePath)) as Array<{
      nodeId?: string;
      case?: string;
      output?: unknown;
    }>;
    assert.deepEqual(
      trace.map((entry) => entry.nodeId),
      ['choose', 'background'],
    );
    assert.equal(trace[0]?.case, 'match');
    assert.deepEqual(trace[0]?.output, {
      matched: true,
      value: 'background_resume',
      expected: 'background_resume',
    });
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
    const recipe = recipeDocument({
      'assert-subject': {
        action: 'assert_json',
        intent: 'Verify the subject JSON satisfies all documented assertion operators.',
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
    });
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
  const echoAdapter = defineActionAdapter({
    action: 'example.echo',
    async execute(node) {
      return { output: { message: node.message } };
    },
  });
  const customManifest: RecipeActionManifestDocument = {
    ...testManifest(['end']),
    actions: {
      ...testManifest(['end']).actions,
      'example.echo': testAction('example.echo', {
        description: 'Echo a test message.',
        schema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          additionalProperties: false,
        },
      }),
    },
  };

  assert.throws(
    () =>
      createRecipeRunner({
        actionManifest: testManifest(['end']),
        adapters: [echoAdapter],
      }),
    /not declared/,
  );
  assert.throws(
    () => createRecipeRunner({ actionManifest: customManifest, adapters: [] }),
    /no registered adapter/,
  );
  assert.doesNotThrow(() =>
    createRecipeRunner({ actionManifest: customManifest, adapters: [echoAdapter] }),
  );
});

test('official registry membership does not enable an action absent from the manifest allowlist', () => {
  assert.throws(
    () =>
      createRecipeRunner({
        actionManifest: testManifest(['end']),
        adapters: createStandardCoreAdapters({ actions: ['command', 'end'] }),
      }),
    /Adapter command is not declared by the recipe action manifest/u,
  );
});

test('writes failure trace and summary with a non-pass result', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipe = recipeDocument({
      run: {
        action: 'command',
        intent: 'Run a command that exits non-zero to prove failure artifacts.',
        cmd: 'node -e "process.exit(7)"',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    });
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

test('validates composed artifact packages from their retained dependency graph', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'recipe-library');
    const recipePath = path.join(tempRoot, 'recipe.json');
    const manifestPath = path.join(tempRoot, 'action-manifest.json');
    const artifactsDir = path.join(tempRoot, 'artifacts');
    await writeJsonFile(
      path.join(libraryRoot, 'recipes/team/nested.recipe.json'),
      recipeDocument(
        { done: { action: 'end', status: 'pass' } },
        { description: 'Provides a retained nested dependency.' },
      ),
    );
    await writeJsonFile(
      recipePath,
      recipeDocument({
        nested: {
          action: 'call',
          ref: 'team.nested',
          intent: 'Run the retained dependency.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      }),
    );
    await writeJsonFile(manifestPath, coreActionManifest);

    await runRecipeHarnessCli([
      'run',
      recipePath,
      '--artifacts-dir',
      artifactsDir,
      '--action-manifest',
      manifestPath,
      '--project-root',
      tempRoot,
      '--json',
    ]);

    const result = await validateRecipeCliInput({
      recipePath,
      actionManifestPath: manifestPath,
      artifactDir: artifactsDir,
      baseDir: tempRoot,
    });
    assert.equal(result.status, 'valid');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('CLI discovers, describes, and runs a parameterized library recipe by id', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const shadowLibraryRoot = path.join(tempRoot, 'shadow-library');
    const recipePath = path.join(libraryRoot, 'recipes/demo/check.recipe.json');
    const manifestPath = path.join(tempRoot, 'action-manifest.json');
    const artifactsDir = path.join(tempRoot, 'artifacts');
    await writeJsonFile(recipePath, {
      ...recipeDocument(
        {
          check: {
            action: 'wait',
            ms: '{{params.delay}}',
            intent: 'Check the explicit recipe parameter.',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
        {
          description: 'Proves direct library execution and parameter overrides.',
          paramsSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              delay: {
                type: 'integer',
                default: 1,
                description: 'Wait duration in milliseconds',
              },
            },
          },
        },
      ),
      title: 'Parameterized check',
    });
    await writeJsonFile(
      path.join(shadowLibraryRoot, 'recipes/demo/check.recipe.json'),
      await readJsonFile(recipePath),
    );
    await writeJsonFile(manifestPath, coreActionManifest);

    const listOutput = await captureConsoleLog(() =>
      runRecipeHarnessCli([
        'run',
        '--list',
        '--library',
        `team=${libraryRoot}`,
        '--library',
        `personal=${shadowLibraryRoot}`,
        '--json',
      ]),
    );
    assert.match(listOutput, /"ref": "demo\.check"/);
    assert.match(listOutput, /"default": 1/);
    assert.match(listOutput, /"shadows": \[\s*"personal"\s*\]/);

    const humanListOutput = await captureConsoleLog(() =>
      runRecipeHarnessCli([
        'run',
        '--list',
        '--library',
        `team=${libraryRoot}`,
        '--library',
        `personal=${shadowLibraryRoot}`,
      ]),
    );
    assert.match(humanListOutput, /demo\.check.*\(shadows: personal\)/);

    const describeOutput = await captureConsoleLog(() =>
      runRecipeHarnessCli([
        'run',
        'demo.check',
        '--describe',
        '--library',
        `team=${libraryRoot}`,
        '--json',
      ]),
    );
    assert.match(describeOutput, /"title": "Parameterized check"/);
    assert.match(describeOutput, /"name": "delay"/);

    const runOutput = await captureConsoleLog(() =>
      runRecipeHarnessCli([
        'run',
        'demo.check',
        'delay=0',
        '--library',
        `team=${libraryRoot}`,
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
    const recipe = recipeDocument(
      { done: { action: 'end', status: 'pass' } },
      { description: 'Exercises optional artifact-manifest validation.' },
    );
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
    const manifest = testManifest(['ui.press', 'app.hud', 'end']);
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
      ...recipeDocument(
        {
          'press-buy': {
            action: 'ui.press',
            intent: 'Open the purchase path for the selected asset.',
            note: 'Artifact note that must not become HUD text',
            selector: '[data-testid="buy"]',
            next: 'show-hud',
          },
          'show-hud': {
            action: 'app.hud',
            intent: 'Explain that the purchase path is ready for review.',
            text: 'Buying',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
        { description: 'Exercises official ui/app adapters through a project transport.' },
      ),
      title: 'UI adapter smoke',
    };
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: [
        ...createStandardUiAdapters({ transport, actions: Object.keys(manifest.actions) }),
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
      'recipe-complete:app.hud',
    ]);
    assert.equal(hudPayloads[0]?.text, 'Open the purchase path for the selected asset.');
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
      ...testManifest(['ui.scroll', 'app.hud', 'end']),
      observers: [
        {
          ref: 'ui.screen',
          default_for: ['ui.scroll'],
        },
        {
          ref: 'ui.visible',
          default_for: ['ui.scroll'],
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
      ...recipeDocument(
        {
          'scroll-list': {
            action: 'ui.scroll',
            intent: 'Make the target asset rows visible for review.',
            detail: 'Using the React Native bridge scroll primitive',
            test_id: 'AssetList',
            delta_y: 800,
            next: 'hud',
          },
          hud: {
            action: 'app.hud',
            intent: 'Explain that the target asset rows are ready for review.',
            text: 'Scrolled assets',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
        { description: 'Exercises official ui/app actions through the RN bridge contract.' },
      ),
      title: 'React Native bridge smoke',
    };
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: [
        ...createStandardUiAdapters({ transport, actions: Object.keys(manifest.actions) }),
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
      ['hud', 'scroll', 'observeUi', 'hud', 'hud', 'hud'],
    );
    assert.equal(commands[1]?.payload.test_id, 'AssetList');
    assert.deepEqual(commands[2]?.payload.refs, ['ui.screen', 'ui.visible']);
    assert.equal(commands[3]?.payload.text, 'Make the target asset rows visible for review.');
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

test('maps typed numeric recipe parameters to CDP input text', async () => {
  const values: string[] = [];
  const transport = createCdpWebUiTransport({
    async withPage(_input, callback) {
      const page = {
        async setInput(_selector: string, value: string) {
          values.push(value);
          return { value };
        },
        async waitForDomSettled() {},
      };
      return callback(page as never);
    },
  });

  await transport.execute(
    'ui.set_input',
    { selector: '[data-testid="limit-price-input"] input', value: 2000 },
    {
      nodeId: 'set-limit-price',
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

  assert.deepEqual(values, ['2000']);
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

  assert.deepEqual(calls, ['Runtime.evaluate', 'Page.navigate', 'Runtime.evaluate']);
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

test('CDP navigation defers DOM settlement to the shared settle wrapper', async () => {
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

  assert.equal(
    expressions.find((expression) => expression.startsWith('new Promise(')),
    undefined,
  );

  await page.waitForDomSettled(100);
  const settleExpression = expressions.find((expression) => expression.startsWith('new Promise('));
  assert.match(settleExpression ?? '', /MutationObserver/u);
  assert.match(settleExpression ?? '', /requestAnimationFrame/u);
  assert.match(settleExpression ?? '', /element\.shadowRoot/u);
  assert.match(settleExpression ?? '', /setInterval\(discoverRoots/u);
  assert.match(settleExpression ?? '', /document\.getAnimations/u);
  assert.match(settleExpression ?? '', /animation\.playState === 'running'/u);
  assert.match(settleExpression ?? '', /reject\(new Error\('DOM remained active/u);
});

test('CDP ui.navigate honors the settle contract through the shared wrapper', async () => {
  const makeContext = () =>
    ({
      nodeId: 'navigate-node',
      recipe: {},
      projectRoot: '/tmp/project',
      artifactsDir: '/tmp/artifacts',
      env: {},
      outputs: new Map(),
      getOutput: () => undefined,
      resolveProjectPath: (relativePath: string) => relativePath,
      resolveArtifactPath: (relativePath: string) => relativePath,
      registerArtifact() {},
      logger: console,
    }) as never;
  let settleCalls = 0;
  const transport = createCdpWebUiTransport({
    async withPage(_input, callback) {
      const page = {
        async navigate() {
          return { loaderId: 'doc' };
        },
        async waitForDomSettled() {
          settleCalls += 1;
          throw new Error('CDP document did not settle within 100ms');
        },
      };
      return callback(page as never);
    },
  });

  const skipped = await transport.execute(
    'ui.navigate',
    { target: '#live', settle: false },
    makeContext(),
  );
  assert.deepEqual(skipped, { loaderId: 'doc' });
  assert.equal(settleCalls, 0);

  const warned = await transport.execute('ui.navigate', { target: '#next' }, makeContext());
  assert.deepEqual(warned, {
    loaderId: 'doc',
    settlementWarning: 'CDP document did not settle within 100ms',
  });
  assert.equal(settleCalls, 1);
});

test('CDP settlement ignores infinite animations while waiting for quiet DOM', async () => {
  const expressions: string[] = [];
  const page = new CdpWebPage({
    async call(method: string, params: Record<string, unknown>) {
      assert.equal(method, 'Runtime.evaluate');
      expressions.push(String(params.expression));
      return { result: { value: true } };
    },
  } as never);

  await page.waitForDomSettled(100);

  const settleExpression = expressions[0] ?? '';
  assert.match(settleExpression, /getTiming\(\)\.iterations !== Infinity/u);
  assert.match(settleExpression, /finiteAnimations\.some/u);
  assert.doesNotMatch(settleExpression, /animations\.some\(/u);
});

test('CDP settlement failure preserves the successful action result with a warning', async () => {
  const transport = createCdpWebUiTransport({
    async withPage(_input, callback) {
      const page = {
        async clickText() {
          return { clicked: true, text: 'Ready Workspace' };
        },
        async waitForDomSettled() {
          throw new Error('CDP document did not settle within 100ms');
        },
      };
      return callback(page as never);
    },
  });

  const result = await transport.execute(
    'ui.press',
    { text: 'Ready Workspace', timeout_ms: 100 },
    {
      nodeId: 'open-ready',
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

  assert.deepEqual(result, {
    clicked: true,
    text: 'Ready Workspace',
    settlementWarning: 'CDP document did not settle within 100ms',
  });
});

test('CDP settle false skips DOM settlement entirely', async () => {
  let settleCalls = 0;
  const transport = createCdpWebUiTransport({
    async withPage(_input, callback) {
      const page = {
        async clickText() {
          return { clicked: true };
        },
        async waitForDomSettled() {
          settleCalls += 1;
        },
      };
      return callback(page as never);
    },
  });

  const result = await transport.execute(
    'ui.press',
    { text: 'Live status', settle: false },
    {
      nodeId: 'open-live',
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

  assert.deepEqual(result, { clicked: true });
  assert.equal(settleCalls, 0);
});

test('CDP click hit-testing crosses shadow boundaries with composed ancestry', async () => {
  const expressions: string[] = [];
  const page = new CdpWebPage({
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'Runtime.evaluate') {
        expressions.push(String(params.expression));
        return { result: { value: { x: 1, y: 2, selector: 's', tagName: 'BUTTON' } } };
      }
      return {};
    },
  } as never);

  await page.click('[data-test-id="inside-shadow"]');

  const clickExpression = expressions[0] ?? '';
  assert.match(clickExpression, /composedContains/u);
  assert.match(clickExpression, /root instanceof ShadowRoot \? root\.host : null/u);
  assert.doesNotMatch(clickExpression, /element\.contains\(hit\)/u);
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
  assert.match(expressions[0] ?? '', /NodeFilter\.SHOW_TEXT/u);
  assert.match(expressions[0] ?? '', /isRenderedDeep\(node\.parentElement\)/u);
  assert.doesNotMatch(expressions[0] ?? '', /textContent/u);
});

test('CDP visible observations omit labels for non-rendered targets', async () => {
  const expressions: string[] = [];
  const page = new CdpWebPage({
    async call(_method: string, params: Record<string, unknown>) {
      expressions.push(String(params.expression));
      return { result: { value: { items: [], hidden_or_offscreen: [] } } };
    },
  } as never);

  await page.observe(['ui.visible']);

  const expression = expressions[0] ?? '';
  assert.match(expression, /label: includeLabel \? textFor\(el\) : undefined/u);
  assert.match(expression, /itemFor\(el, rendered \? rect : undefined, rendered\)/u);
  assert.match(expression, /root instanceof ShadowRoot \? root\.host/u);
  assert.match(expression, /Number\(style\.opacity \|\| 1\) <= 0/u);
  assert.doesNotMatch(expression, /'\[data-testid\]'/u);
  assert.match(expression, /parts\.join\(' > '\)/u);
  assert.doesNotMatch(expression, /el\.textContent/u);
});

test('CDP screen observations omit query parameters and sensitive fragments', async () => {
  const expressions: string[] = [];
  const page = new CdpWebPage({
    async call(_method: string, params: Record<string, unknown>) {
      expressions.push(String(params.expression));
      return { result: { value: {} } };
    },
  } as never);

  await page.observe(['ui.screen']);

  const expression = expressions[0] ?? '';
  assert.match(expression, /location\.origin \+ location\.pathname/u);
  assert.match(expression, /const hashPath = location\.hash\.split\('\?'\)\[0\]/u);
  assert.match(expression, /!hashPath\.includes\('='\)/u);
  assert.doesNotMatch(expression, /url: location\.href/u);
});

test('CDP visible waits use viewport visibility and presses validate hit targets', async () => {
  const expressions: string[] = [];
  const page = new CdpWebPage({
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'Runtime.evaluate') {
        expressions.push(String(params.expression));
        return { result: { value: { x: 10, y: 20, selector: '#submit', tagName: 'BUTTON' } } };
      }
      return {};
    },
  } as never);

  await page.waitFor({ selector: '#submit', expected: 'visible', timeoutMs: 100 });
  await page.click('#submit');

  assert.match(expressions[0] ?? '', /isVisibleDeep\(el\)/u);
  assert.match(expressions[1] ?? '', /clickablePointDeep\(el\)/u);
  assert.match(expressions[1] ?? '', /elementFromPoint/u);
  assert.match(expressions[1] ?? '', /Target is disabled/u);
  assert.match(expressions[1] ?? '', /Target is obscured/u);
});

test('extracts browser extension ids from CDP targets', () => {
  assert.equal(
    extensionIdFromTarget({ url: 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/home.html' }),
    'nkbihfbeogaeaoehlefnkodbefgpgknn',
  );
  assert.equal(extensionIdFromTarget({ url: 'https://example.test' }), undefined);
});
