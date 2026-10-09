// Run evidence on a fake host and fake adapters: run options, trust input,
// suggestions, behavioral proof, execution provenance, run diagnostics, the
// framed recorder, the run report and live adapter scripts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ADAPTER_SDK_VERSION,
  type AdapterBrowser,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';
import {
  type RecipeActionManifestDocument,
  validateRecipeArtifactPackage,
} from '@farmslot/protocol';
import { createRecipeRunner, createStandardCoreAdapters } from '@farmslot/recipe-runner';

import {
  type ActiveRecipeRecording,
  beginRunDiagnostics,
  captureExecutionProvenance,
  closest,
  collectRunDiagnostics,
  configureHarnessAdapters,
  configureHarnessHost,
  type ConsoleClassifier,
  createRecordingTargetProvider,
  executedBrowser,
  executionProvenanceDrift,
  explicitRecipeTrustOptions,
  finishRunDiagnostics,
  formatRunDiagnosticsForHuman,
  harnessHost,
  indexProductProvenanceArtifact,
  liveAdapterProcessTimeoutMs,
  prepareLiveAdapterScript,
  readRunDiagnosticsDocument,
  recipeCdpPorts,
  recipeRunOptionsFromCli,
  recipeTrustFailure,
  runLiveAdapterScript,
  startRecipeRecording,
  stopRecipeRecording,
  validateRuntimeProof,
  validateRuntimeProofPlan,
  verifyConsoleCapture,
  writeExecutionProvenance,
  writeRunReport,
} from '../src/harness/index.js';

const DEFAULT_HOST = harnessHost();
const SHOP_HOST = {
  name: 'shop-harness',
  product: 'Shop',
  envPrefix: 'SHOP_HARNESS',
  recipeEnvPrefix: 'SHOP_RECIPE',
  packageName: '@acme/shop-harness',
  packageRoot: '/opt/shop-harness',
  bin: 'bin/shop-harness',
};
const PROOF_MANIFEST = fileURLToPath(
  new URL('./fixtures/proof.action-manifest.json', import.meta.url),
);

const roots: string[] = [];
function tempRoot(prefix = 'recipe-cli-evidence-'): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function fakeAdapter(id: string, extra: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id,
    sdkVersion: ADAPTER_SDK_VERSION,
    headless: false,
    resolveSlotPorts() {},
    runtimeStatus: async () => ({ decision: 'ready', reasons: [] }),
    devServer: {
      label: `${id}-server`,
      describe: () => `${id} dev server`,
      stop: () => ({ kind: 'stopped', status: 0, summary: `stopped ${id}` }),
    },
    logSources: () => [],
    appLogSource: () => null,
    hints: { launch: `launch ${id}`, relaunch: `relaunch ${id}`, runtimeProbeRecovery: () => 'x' },
    actions: {
      manifestPath: () => `/manifests/${id}.json`,
      semantic: [],
      cdpTarget: { transport: 'none', probePath: '/json/version' },
    },
    harness: {
      install: { entry: 'install.mjs', fallback: 'install.mjs', node: true },
      cleanup: { entry: 'cleanup.mjs', fallback: 'cleanup.mjs', node: true },
      verify: () => ({ error: 'no verify' }),
    },
    runtimeContext: { forbiddenFields: [] },
    launch: async () => 0,
    ...extra,
  };
}

function useAdapters(...adapters: PlatformAdapter[]): void {
  const registry = createAdapterRegistry();
  for (const adapter of adapters) registry.register(adapter);
  configureHarnessAdapters(registry);
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function checkout(prefix: string, files: Record<string, string>): string {
  const root = tempRoot(prefix);
  git(root, 'init', '-q');
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  );
  return root;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  configureHarnessHost(SHOP_HOST);
  useAdapters(fakeAdapter('web'));
});
afterEach(() => {
  configureHarnessHost(DEFAULT_HOST);
  configureHarnessAdapters(createAdapterRegistry());
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('run options', () => {
  test('reads ports, slot, video, HUD and trust from the command line', () => {
    assert.deepEqual(
      recipeRunOptionsFromCli('web', {
        cdpPort: '9222',
        watcherPort: '8081',
        slot: 'mini-2',
        recordVideo: 'full-run',
        hud: 'hide',
        sourceTrust: 'untrusted',
        approvePlan: 'sha256:plan',
      }),
      {
        cdpPort: '9222',
        watcherPort: '8081',
        slot: 'mini-2',
        validationRuntimeDir: undefined,
        recordVideo: 'full-run',
        autoHud: false,
        source: { trust: 'untrusted', kind: 'recipe-file' },
        approval: { planDigest: 'sha256:plan' },
      },
    );
    const defaults = recipeRunOptionsFromCli('web', { recordVideo: 'step' });
    assert.equal(defaults.recordVideo, false);
    assert.equal(defaults.autoHud, undefined);
    assert.equal(recipeRunOptionsFromCli('web', { hud: 'show' }).autoHud, true);
  });

  test('--watcher-port is the one dev-server port option; the platform adds its options', () => {
    useAdapters(
      fakeAdapter('rn'),
      fakeAdapter('web', {
        run: { platformOptions: (cli) => ({ reuseBrowser: cli.reuseBrowser === true }) },
      }),
    );
    const options = recipeRunOptionsFromCli('web', { watcherPort: '8088', reuseBrowser: true });
    assert.equal(options.watcherPort, '8088');
    assert.deepEqual(options.platform, { reuseBrowser: true });
    assert.equal(recipeRunOptionsFromCli('rn', { metroPort: '8081' }).watcherPort, undefined);
    assert.equal('platform' in recipeRunOptionsFromCli('rn', {}), false);
  });
});

describe('recipe trust input', () => {
  test('maps explicit source provenance and exact approval', () => {
    assert.deepEqual(
      explicitRecipeTrustOptions({
        sourceTrust: 'untrusted',
        sourceKind: 'task',
        sourceName: 'pr-body',
        sourceDigest: 'sha256:source',
        approvalDigest: 'sha256:plan',
      }),
      {
        source: { trust: 'untrusted', kind: 'task', name: 'pr-body', digest: 'sha256:source' },
        approval: { planDigest: 'sha256:plan' },
      },
    );
  });

  test('omits absent trust input and applies fail-closed partial defaults', () => {
    assert.deepEqual(explicitRecipeTrustOptions({}), {});
    assert.deepEqual(explicitRecipeTrustOptions({ sourceTrust: 'untrusted' }), {
      source: { trust: 'untrusted', kind: 'recipe-file' },
    });
    assert.deepEqual(explicitRecipeTrustOptions({ sourceKind: 'task' }), {
      source: { trust: 'unknown', kind: 'task' },
    });
    assert.deepEqual(explicitRecipeTrustOptions({ approvalDigest: 'sha256:plan' }), {
      approval: { planDigest: 'sha256:plan' },
    });
  });

  test('rejects non-trust errors instead of turning unrelated failures into policy errors', () => {
    assert.equal(recipeTrustFailure(null), undefined);
    assert.equal(recipeTrustFailure('failure'), undefined);
    assert.equal(
      recipeTrustFailure({ code: 'RUN_FAILED', message: 'bad', userAction: 'retry' }),
      undefined,
    );
    assert.equal(
      recipeTrustFailure({ code: 'RECIPE_BAD', message: 7, userAction: 'retry' }),
      undefined,
    );
    assert.equal(recipeTrustFailure({ code: 'RECIPE_BAD', message: 'bad' }), undefined);
  });

  test('normalizes trust failures without exposing recipe node payloads', () => {
    assert.deepEqual(
      recipeTrustFailure({
        code: 'RECIPE_TRUST_REQUIRED',
        message: 'Approval required.',
        userAction: 'approve the plan',
        failure: {
          recipeDigest: 'sha256:plan',
          trust: 'untrusted',
          blocked: [
            {
              nodeId: 'danger',
              action: 'command',
              capabilities: ['host-exec', 7],
              origin: { kind: 'task', name: 'pr-body', path: '/secret/path' },
              adapterOrigin: {
                kind: 'custom-adapter',
                trust: 'untrusted',
                digest: 'sha256:adapter',
                path: '/secret/adapter',
              },
              cmd: 'secret command',
            },
            {
              nodeId: 'read',
              action: 'state_read',
              capabilities: ['host-read-export'],
              origin: { kind: 'task' },
            },
            { nodeId: 'unknown', action: 'custom', capabilities: [] },
            null,
            { nodeId: 7, action: 'invalid', capabilities: [] },
          ],
        },
      }),
      {
        code: 'RECIPE_TRUST_REQUIRED',
        message: 'Approval required.',
        userAction:
          'approve the plan; rerun with the same project root, artifact directory, and execution environment',
        details: {
          recipeDigest: 'sha256:plan',
          trust: 'untrusted',
          blocked: [
            {
              nodeId: 'danger',
              action: 'command',
              capabilities: ['host-exec'],
              source: 'task',
              implementation: {
                kind: 'custom-adapter',
                trust: 'untrusted',
                digest: 'sha256:adapter',
              },
            },
            {
              nodeId: 'read',
              action: 'state_read',
              capabilities: ['host-read-export'],
              source: 'task',
            },
            { nodeId: 'unknown', action: 'custom', capabilities: [], source: 'unknown' },
          ],
        },
      },
    );
  });

  test('keeps valid trust errors concise when optional details are absent or malformed', () => {
    assert.deepEqual(
      recipeTrustFailure({
        code: 'RECIPE_SOURCE_INVALID',
        message: 'Invalid source.',
        userAction: 'fix provenance',
      }),
      { code: 'RECIPE_SOURCE_INVALID', message: 'Invalid source.', userAction: 'fix provenance' },
    );
    assert.equal(
      recipeTrustFailure({
        code: 'RECIPE_APPROVAL_MISMATCH',
        message: 'Wrong approval.',
        userAction: 'approve again',
        failure: { recipeDigest: 'sha256:next', trust: 'untrusted', blocked: [] },
      })?.userAction,
      'approve again; rerun with the same project root, artifact directory, and execution environment',
    );
    assert.deepEqual(
      recipeTrustFailure({
        code: 'RECIPE_APPROVAL_MISMATCH',
        message: 'Wrong approval.',
        userAction: 'approve again',
        failure: { recipeDigest: 7, trust: false, blocked: 'invalid' },
      }),
      {
        code: 'RECIPE_APPROVAL_MISMATCH',
        message: 'Wrong approval.',
        userAction: 'approve again',
        details: {},
      },
    );
  });
});

describe('suggestions', () => {
  test('suggests the nearest candidate, counting a swap as one edit, and nothing far away', () => {
    assert.equal(closest('launc', ['launch', 'logs', 'last']), 'launch');
    assert.equal(closest('lunach', ['launch', 'run']), 'launch');
    assert.equal(closest('--categoriesx', ['--categories', '--category']), '--categories');
    assert.equal(closest('zzzzzz', ['launch', 'run']), undefined);
    assert.equal(closest('run', []), undefined);
    // Ties go to the alphabetically first candidate.
    assert.equal(closest('cat', ['bat', 'hat']), 'bat');
  });
});

describe('behavioral proof', () => {
  const command = {
    action: 'command',
    cmd: 'printf expected',
    intent: 'Execute the runtime command.',
    next: 'assert',
  };
  const assertion = {
    action: 'assert_output',
    source: 'run',
    contains: 'expected',
    proves: ['behavior'],
    intent: 'Verify runtime output.',
    next: 'done',
  };
  const done = { action: 'end', status: 'pass' };

  async function execute(nodes: Record<string, Record<string, unknown>>) {
    const dir = tempRoot('runtime-proof-');
    const manifest = JSON.parse(
      fs.readFileSync(PROOF_MANIFEST, 'utf8'),
    ) as RecipeActionManifestDocument;
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
      runner: { source: 'worktree', name: 'Proof test', git_ref: 'a'.repeat(40) },
    });
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Runtime proof test',
      proofTargets: [{ id: 'behavior', claim: 'Command produces expected runtime output' }],
      workflow: { entry: 'run', nodes },
    };
    await runner.run({
      recipeDocument: recipe,
      artifactsDir: dir,
      projectRoot: dir,
      source: { kind: 'operator', trust: 'trusted', name: 'Test' },
    });
    const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const manifestFile = read('artifact-manifest.json') as { artifacts: { path: string }[] };
    return {
      recipe,
      summary: read('summary.json'),
      trace: read('trace.json'),
      manifest: manifestFile,
      recipeResolution: read('recipe-resolution.json'),
      resolvedRecipes: {},
      artifactPaths: [
        'recipe.json',
        'summary.json',
        'trace.json',
        'artifact-manifest.json',
        'recipe-resolution.json',
        ...manifestFile.artifacts.map((item) => item.path),
      ],
    } as unknown as Parameters<typeof validateRuntimeProof>[0];
  }

  test('accepts executed output assertions and refuses a missing smoke target', async () => {
    const bundle = await execute({ run: command, assert: assertion, done });
    validateRuntimeProof(bundle, 'behavior');
    assert.throws(() => validateRuntimeProof(bundle, 'missing'), /Smoke target/u);
  });

  test('rejects a passing package that only labels a command as proof', async () => {
    const bundle = await execute({
      run: { ...command, proves: ['behavior'], next: 'done' },
      done,
    });
    assert.equal(validateRecipeArtifactPackage(bundle).status, 'valid');
    assert.throws(() => validateRuntimeProof(bundle, 'behavior'), /no executed runtime assertion/u);
  });

  test('rejects failed runtime assertions', async () => {
    const bundle = await execute({
      run: command,
      assert: { ...assertion, contains: 'absent' },
      done,
    });
    assert.throws(() => validateRuntimeProof(bundle, 'behavior'));
  });

  test('accepts either executed assertion branch for the same proof target', async () => {
    const bundle = await execute({
      run: { ...command, next: 'choose' },
      choose: {
        action: 'switch',
        value: 'left',
        equals: 'left',
        cases: { match: 'left' },
        default: 'right',
        intent: 'Select the applicable assertion.',
      },
      left: assertion,
      right: { ...assertion, contains: 'not-selected' },
      done,
    });
    validateRuntimeProof(bundle, 'behavior');
  });

  const target = { id: 'market', claim: 'The selected market is displayed.' };
  const observe = {
    action: 'command',
    cmd: 'printf ETH',
    intent: 'Read market state.',
    next: 'check',
  };
  const check = {
    action: 'assert_output',
    source: 'observe',
    contains: 'ETH',
    proves: ['market'],
    intent: 'Assert selected market.',
    next: 'done',
  };
  const press = { action: 'ui.press', test_id: 'market-ETH', intent: 'Open ETH.', next: 'check' };
  const wait = {
    action: 'ui.wait_for',
    text: 'ETH',
    proves: ['market'],
    intent: 'Observe ETH after selection.',
    next: 'done',
  };
  type PlanNode = Parameters<typeof validateRuntimeProofPlan>[0]['workflow']['nodes'][string];
  function plan(nodes: Record<string, Record<string, unknown>>, proofTargets = [target]) {
    return {
      proofTargets,
      workflow: { nodes: nodes as unknown as Record<string, PlanNode> },
    };
  }
  function rejects(
    document: ReturnType<typeof plan>,
    documents?: Map<string, ReturnType<typeof plan>>,
  ) {
    assert.equal(
      validateRuntimeProofPlan(document, documents)[0]?.code,
      'proof.no_runtime_assertion',
    );
  }

  test('plan: an output assertion over an observation is eligible, legacy node source too', () => {
    assert.deepEqual(validateRuntimeProofPlan(plan({ observe, check, done })), []);
    assert.deepEqual(
      validateRuntimeProofPlan(
        plan({ observe, check: { ...check, source: undefined, node: 'observe' }, done }),
      ),
      [],
    );
  });

  test('plan: missing targets, bindings and command-only bindings fail', () => {
    assert.equal(validateRuntimeProofPlan(plan({ done }, []))[0]?.code, 'proof.targets_missing');
    rejects(plan({ observe, check: { ...check, proves: undefined }, done }));
    rejects(plan({ observe: { ...observe, proves: ['market'], next: 'done' }, done }));
    rejects(plan({ check, done }));
    rejects(plan({ observe: { action: 'wait', next: 'check' }, check, done }));
  });

  test('plan: a UI wait needs an input somewhere in the composition', () => {
    rejects(plan({ check: wait, done }));
    rejects(plan({ observe: { action: 'ui.navigate', next: 'check' }, check: wait, done }));
    assert.deepEqual(validateRuntimeProofPlan(plan({ press, check: wait, done })), []);
  });

  test('plan: calls bind parent targets to nested assertions; JSON needs a path', () => {
    const leaf = plan({ observe, check: { ...check, proves: undefined }, done }, []);
    const middle = plan({ child: { action: 'call', ref: 'test.leaf', next: 'done' }, done }, []);
    const root = plan({
      child: { action: 'call', ref: 'test.middle', proves: ['market'], next: 'done' },
      done,
    });
    assert.deepEqual(
      validateRuntimeProofPlan(
        root,
        new Map([
          ['test.middle', middle],
          ['test.leaf', leaf],
        ]),
      ),
      [],
    );
    rejects(
      root,
      new Map([
        ['test.middle', middle],
        ['test.leaf', plan({ observe, done }, [])],
      ]),
    );
    assert.deepEqual(
      validateRuntimeProofPlan(
        plan({ check: { action: 'assert_json', path: 'proof.json', proves: ['market'] }, done }),
      ),
      [],
    );
    rejects(plan({ check: { action: 'assert_json', proves: ['market'] }, done }));
  });
});

describe('execution provenance', () => {
  const recipeDocument = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Smoke',
    description: 'Complete without actions.',
    workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
  };

  test('writes the record without a manifest, and refuses a manifest it cannot read', async () => {
    const artifactsDir = path.join(tempRoot(), 'artifacts');
    const provenancePath = await writeExecutionProvenance(artifactsDir, [], []);
    assert.deepEqual(JSON.parse(fs.readFileSync(provenancePath, 'utf8')), {
      schemaVersion: 1,
      valid: true,
      snapshots: [],
      drift: [],
    });
    await assert.rejects(
      writeExecutionProvenance(artifactsDir, [], [], path.join(artifactsDir, 'missing.json')),
      /missing\.json/u,
    );
  });

  test('records stable snapshots, then recipe, library and product drift', async () => {
    const product = checkout('provenance-product-', { 'app/value.ts': 'export const v = 1;\n' });
    const library = checkout('provenance-library-', { 'recipes/smoke.recipe.json': '{}\n' });
    const runner = checkout('provenance-runner-', { 'src/runner.ts': 'export const r = 1;\n' });
    const recipePath = path.join(product, 'smoke.recipe.json');
    fs.writeFileSync(recipePath, `${JSON.stringify(recipeDocument)}\n`);
    const input = {
      adapter: 'web',
      projectRoot: product,
      recipeDocument,
      recipePath,
      librarySources: [{ name: 'team', root: library }],
      runnerRoot: runner,
      runnerIncludes: ['src'],
    };
    const start = await captureExecutionProvenance(input, 'start');
    const preExecute = await captureExecutionProvenance(input, 'pre-execute');
    assert.deepEqual(executionProvenanceDrift(start, preExecute), []);
    assert.equal(start.product.head, git(product, 'rev-parse', 'HEAD'));
    assert.equal(start.libraries[0]?.head, git(library, 'rev-parse', 'HEAD'));

    fs.writeFileSync(path.join(product, 'app/value.ts'), 'export const v = 2;\n');
    fs.writeFileSync(path.join(library, 'recipes/smoke.recipe.json'), '{"changed":true}\n');
    git(library, 'add', '.');
    git(library, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '-m', 'x');
    fs.writeFileSync(recipePath, `${JSON.stringify({ ...recipeDocument, title: 'Changed' })}\n`);
    const end = await captureExecutionProvenance(input, 'end');
    const fields = executionProvenanceDrift(start, end).map((entry) => entry.field);
    for (const field of [
      'recipeDigest',
      'product.status',
      'product.sourceFingerprint',
      'libraries[0].head',
      'libraries[0].sourceFingerprint',
    ])
      assert.ok(fields.includes(field), field);

    const artifactsDir = path.join(product, 'artifacts');
    fs.mkdirSync(artifactsDir);
    const manifestPath = path.join(artifactsDir, 'artifact-manifest.json');
    fs.writeFileSync(manifestPath, '{"artifacts":[]}\n');
    const provenancePath = await writeExecutionProvenance(
      artifactsDir,
      [start, end],
      executionProvenanceDrift(start, end),
      manifestPath,
    );
    assert.equal(JSON.parse(fs.readFileSync(provenancePath, 'utf8')).valid, false);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.artifacts[0].metadata, {
      valid: false,
      errorCode: 'PROVENANCE_DRIFT',
    });
  });

  test('binds only the included runner paths, and the command helpers', async () => {
    const product = checkout('provenance-product-', { 'app/value.ts': 'export const v = 1;\n' });
    const runner = checkout('provenance-runner-', {
      'src/runner.ts': 'export const r = 1;\n',
      'docs/notes.md': 'notes\n',
    });
    const helperPath = path.join(product, 'temp', 'tasks', 'wait.mjs');
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, 'export const proof = 1;\n');
    const input = {
      adapter: 'web',
      projectRoot: product,
      recipeDocument,
      runnerRoot: runner,
      runnerIncludes: ['src'],
      helperPaths: [helperPath],
    };
    const start = await captureExecutionProvenance(input, 'start');
    assert.equal(start.helpers[0]?.path, 'temp/tasks/wait.mjs');
    fs.writeFileSync(path.join(runner, 'docs/notes.md'), 'changed\n');
    assert.deepEqual(
      executionProvenanceDrift(start, await captureExecutionProvenance(input, 'pre-execute')),
      [],
    );
    fs.writeFileSync(path.join(runner, 'src/runner.ts'), 'export const r = 2;\n');
    fs.writeFileSync(helperPath, 'export const proof = 2;\n');
    const fields = executionProvenanceDrift(
      start,
      await captureExecutionProvenance(input, 'end'),
    ).map((entry) => entry.field);
    for (const field of [
      'runner.status',
      'runner.sourceFingerprint',
      'helpers[0].sourceFingerprint',
    ])
      assert.ok(fields.includes(field), field);
  });

  test('the runner defaults to the host package root', async () => {
    const runner = checkout('provenance-host-', { 'bin/shop-harness': '#!/bin/sh\n' });
    configureHarnessHost({ ...SHOP_HOST, packageRoot: runner });
    const snapshot = await captureExecutionProvenance(
      { adapter: 'web', projectRoot: tempRoot(), recipeDocument, runnerIncludes: ['bin'] },
      'start',
    );
    assert.equal(snapshot.runner.head, git(runner, 'rev-parse', 'HEAD'));
    assert.equal(snapshot.product.status, 'not-a-git-checkout');
  });

  test('excludes operation records through a checkout alias, not product changes', async () => {
    const product = checkout('provenance-observed-', {
      'app/value.ts': 'export const v = 1;\n',
      'temp/recipe/runtime/operations/record.json': '{}\n',
    });
    const alias = path.join(tempRoot('provenance-alias-'), 'checkout');
    fs.symlinkSync(product, alias, 'dir');
    const observations = path.join(alias, 'temp/recipe/runtime/operations');
    const input = {
      adapter: 'web',
      projectRoot: alias,
      recipeDocument,
      excludedProductRoots: [observations],
      runnerRoot: product,
      runnerIncludes: ['app'],
    };
    const start = await captureExecutionProvenance(input, 'start');
    fs.writeFileSync(path.join(observations, 'record.json'), '{"updated":true}\n');
    assert.deepEqual(
      executionProvenanceDrift(start, await captureExecutionProvenance(input, 'pre-execute')),
      [],
    );
    fs.writeFileSync(path.join(alias, 'app/value.ts'), 'export const v = 2;\n');
    const fields = executionProvenanceDrift(
      start,
      await captureExecutionProvenance(input, 'end'),
    ).map((entry) => entry.field);
    assert.ok(fields.includes('product.sourceFingerprint'));
  });

  test('fingerprints the checkout root with the platform fingerprint; refuses symlinked helpers', async () => {
    useAdapters(fakeAdapter('web', { sourceFingerprint: () => 'web-fingerprint' }));
    const product = checkout('provenance-platform-', { 'app/value.ts': 'export const v = 1;\n' });
    const input = { adapter: 'web', projectRoot: product, recipeDocument, runnerIncludes: [] };
    const snapshot = await captureExecutionProvenance(input, 'start');
    assert.equal(snapshot.product.sourceFingerprint, 'web-fingerprint');
    const helper = path.join(product, 'helper.mjs');
    fs.symlinkSync(path.join(product, 'app/value.ts'), helper);
    await assert.rejects(
      captureExecutionProvenance({ ...input, helperPaths: [helper] }, 'start'),
      /symbolic link/u,
    );
  });
});

// A console classifier for logs of `LEVEL  message` lines; the allowlist is
// `<root>/allow.json`, a list of signatures.
interface FakeAllowlist {
  entries: { signature: string; file: string }[];
  problems: string[];
}
const classifier: ConsoleClassifier<FakeAllowlist> = {
  records: (text) =>
    text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => ({ line, continuation: [] })),
  classify(record) {
    const match = /\b(WARN|ERROR|EXCEPTION)\s+(.*)$/u.exec(record.line);
    if (!match) return null;
    const level = ({ WARN: 'warning', ERROR: 'error', EXCEPTION: 'exception' } as const)[
      match[1] as 'WARN' | 'ERROR' | 'EXCEPTION'
    ];
    const message = match[2] ?? '';
    return {
      level,
      source: 'app',
      message,
      firstFrame: null,
      key: { signature: message, continuation: '', first_frame: '' },
    };
  },
  signature: (message) => message.replace(/\d+/gu, 'N'),
  loadAllowlist(libraryRoots) {
    const entries = libraryRoots.flatMap((root) => {
      const file = path.join(root, 'allow.json');
      if (!fs.existsSync(file)) return [];
      return (JSON.parse(fs.readFileSync(file, 'utf8')) as string[]).map((signature) => ({
        signature,
        file,
      }));
    });
    return { entries, problems: [] };
  },
  match(event, allowlist) {
    const index = allowlist.entries.findIndex((entry) => entry.signature === event.key.signature);
    const entry = allowlist.entries[index];
    return entry ? { reason: 'known noise', index, file: entry.file } : null;
  },
  libraryRoots: () => [],
};

describe('run diagnostics', () => {
  function makeLog(contents = ''): string {
    const file = path.join(tempRoot('diagnostics-'), 'app.log');
    fs.writeFileSync(file, contents);
    return file;
  }

  test('collects only output emitted after the baseline', () => {
    const file = makeLog('ERROR  old failure\n');
    const before = fs.statSync(file);
    fs.appendFileSync(file, 'WARN  new warning\n');
    const document = collectRunDiagnostics(
      { source: { label: 'app', path: file }, offset: before.size, inode: before.ino },
      classifier,
    );
    assert.equal(document.status, 'review');
    assert.deepEqual(document.counts, { total: 1, warning: 1, error: 0, exception: 0, info: 0 });
    assert.match(document.findings[0]?.preview ?? '', /new warning/u);
  });

  test('groups equivalent events and redacts secrets and query strings', () => {
    const file = makeLog(
      [
        'ERROR  token=abc apiKey=one vault=locked https://example.test/path?key=value',
        'ERROR  token=def apiKey=two vault=open https://example.test/path?different=value',
      ].join('\n'),
    );
    const document = collectRunDiagnostics(
      { source: { label: 'app', path: file }, offset: 0 },
      classifier,
    );
    assert.equal(document.counts.error, 1);
    assert.equal(document.findings[0]?.count, 2);
    const preview = document.findings[0]?.preview ?? '';
    for (const redacted of ['token=[REDACTED]', 'apiKey=[REDACTED]', '?[REDACTED_QUERY]'])
      assert.ok(preview.includes(redacted), redacted);
    assert.ok(!preview.includes('abc'));
  });

  test('combines buffered issues and reports clean and unavailable honestly', () => {
    const file = makeLog('ordinary info\n');
    const baseline = { source: { label: 'app', path: file }, offset: 0 };
    assert.equal(
      collectRunDiagnostics(baseline, classifier, [{ level: 'exception', text: 'boom' }]).status,
      'review',
    );
    assert.equal(collectRunDiagnostics(baseline, classifier, []).status, 'clean');
    assert.equal(
      collectRunDiagnostics({ ...baseline, source: { label: 'x', path: `${file}.x` } }, classifier)
        .status,
      'unavailable',
    );
    const unverified = collectRunDiagnostics(baseline, classifier, undefined, null, {
      verified: false,
      detail: 'no collector',
    });
    assert.equal(unverified.status, 'unavailable');
    assert.match(unverified.note, /Console capture was not verified: no collector\./u);
  });

  test('downgrades allowlisted noise to info and keeps it last', () => {
    const library = tempRoot('diagnostics-library-');
    fs.writeFileSync(path.join(library, 'allow.json'), JSON.stringify(['known noise']));
    const file = makeLog('WARN  known noise\nERROR  real failure\n');
    const document = collectRunDiagnostics(
      { source: { label: 'app', path: file }, offset: 0 },
      classifier,
      undefined,
      classifier.loadAllowlist([library]),
    );
    assert.deepEqual(
      document.findings.map((finding) => [finding.level, finding.allowlisted?.reason]),
      [
        ['error', undefined],
        ['info', 'known noise'],
      ],
    );
    assert.deepEqual(document.allowlist, { entries: 1, applied: 1, problems: [] });
    assert.equal(document.counts.total, 1);
  });

  test('reads the platform request log and its in-app buffer through the adapter', async () => {
    const root = tempRoot('diagnostics-platform-');
    const appLog = path.join(root, 'app.log');
    const requestLog = path.join(root, 'requests.jsonl');
    fs.writeFileSync(appLog, '');
    fs.writeFileSync(requestLog, 'refused before\n');
    useAdapters(
      fakeAdapter('web', {
        appLogSource: () => ({ label: 'app', path: appLog }),
        diagnostics: {
          requestLog: {
            path: () => requestLog,
            findings: (lines) =>
              lines
                .filter((line) => line.startsWith('refused'))
                .map((line) => ({ level: 'error' as const, source: 'requests', text: line })),
          },
          issueBuffer: {
            arm: () => true,
            collect: () => [{ level: 'warn', text: 'buffered warning' }],
          },
        },
      }),
    );
    const baseline = await beginRunDiagnostics('web', root);
    assert.deepEqual(baseline?.issueBuffer, { adapter: 'web', projectRoot: root });
    fs.appendFileSync(requestLog, 'refused during\nok\n');
    const summaryPath = path.join(root, 'summary.json');
    const artifactManifestPath = path.join(root, 'artifact-manifest.json');
    fs.writeFileSync(summaryPath, '{}\n');
    fs.writeFileSync(artifactManifestPath, '{"artifacts":[]}\n');
    const result = await finishRunDiagnostics(
      baseline,
      { summaryPath, artifactManifestPath, tracePath: path.join(root, 'trace.json') } as Parameters<
        typeof finishRunDiagnostics
      >[1],
      classifier,
    );
    const document = readRunDiagnosticsDocument(result.diagnosticsPath);
    assert.deepEqual(
      document?.findings.map((finding) => [finding.source, finding.preview]),
      [
        [undefined, 'buffered warning'],
        ['requests', 'refused during'],
      ],
    );
    assert.equal(document?.source.inAppBuffer, 'collected');
    assert.deepEqual(result.sideFindings?.counts.total, 2);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(artifactManifestPath, 'utf8')).artifacts.map(
        (artifact: { path: string }) => artifact.path,
      ),
      ['diagnostics.json', 'diagnostics-app-log.txt'],
    );
    assert.equal(JSON.parse(fs.readFileSync(summaryPath, 'utf8')).sideFindings.status, 'review');
    assert.deepEqual(formatRunDiagnosticsForHuman(document, 'web').slice(0, 1), [
      `REVIEW — ${document?.note}`,
    ]);
  });

  test('verifies console capture through the platform control', async () => {
    const controls: string[] = [];
    useAdapters(
      fakeAdapter('web', {
        diagnostics: {
          console: {
            start: async () => {},
            files: () => ({ extensionLog: 'e.log', pageLog: 'p.log', pidFile: 'c.pid' }),
            cdpPort: () => '9222',
            verifyControl: async (capture) => {
              controls.push(capture.cdpPort);
              return { ok: true, detail: 'collector ok; control line arrived' };
            },
          },
        },
      }),
    );
    const spec = {
      adapter: 'web',
      projectRoot: '/checkout',
      extensionLog: 'e.log',
      pageLog: 'p.log',
      pidFile: 'c.pid',
    };
    assert.deepEqual(await verifyConsoleCapture({ ...spec, startError: 'boom' }), {
      verified: false,
      detail: 'the console collector did not start: boom',
    });
    assert.deepEqual(await verifyConsoleCapture(spec), {
      verified: false,
      detail: 'no CDP port for the console collector',
    });
    assert.deepEqual(await verifyConsoleCapture({ ...spec, cdpPort: '9222' }), {
      verified: true,
      detail: 'collector ok; control line arrived',
    });
    assert.deepEqual(controls, ['9222']);
  });

  test('a headless platform reports N/A, a missing document UNAVAILABLE', () => {
    useAdapters(fakeAdapter('cli', { headless: true }), fakeAdapter('web'));
    assert.match(formatRunDiagnosticsForHuman(null, 'cli')[0] ?? '', /^N\/A — Cli is headless/u);
    assert.match(formatRunDiagnosticsForHuman(null, 'web')[0] ?? '', /^UNAVAILABLE/u);
    assert.equal(readRunDiagnosticsDocument('/missing/diagnostics.json'), null);
  });
});

describe('run recording', () => {
  const ACTIVE_PID_ENV = 'SHOP_RECIPE_ACTIVE_RECORDING_PID';

  function fixture() {
    const root = tempRoot('recording-timing-');
    const videos = path.join(root, 'videos');
    fs.mkdirSync(videos);
    const stagingDir = fs.mkdtempSync(path.join(videos, '.private-'));
    const stagedPath = path.join(stagingDir, 'full-run.mp4');
    const bytes = Buffer.from('finalized recorder fixture');
    fs.writeFileSync(stagedPath, bytes);
    const artifactManifestPath = path.join(root, 'artifact-manifest.json');
    const tracePath = path.join(root, 'trace.json');
    fs.writeFileSync(artifactManifestPath, JSON.stringify({ artifacts: [] }));
    fs.writeFileSync(tracePath, '[]');
    const sidecar = {
      version: 1,
      recording_id: 'test-recording',
      video_file: 'full-run.mp4',
      video_digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      frames_ms: [0, 40, 80],
      duration_ms: 100,
      clock: {
        source: 'coremedia-host-clock',
        earliest_zero_unix_ms: 1000,
        latest_zero_unix_ms: 1001,
      },
    };
    fs.writeFileSync(`${stagedPath}.timing.json`, JSON.stringify(sidecar));
    process.env[ACTIVE_PID_ENV] = '123456';
    const recording = {
      pid: 123456,
      exited: true,
      finalized: false,
      nativeTiming: true,
      completedVideo: true,
      completedRecordingId: 'test-recording',
      stagingDir,
      stagedPath,
      outputPath: path.join(videos, 'full-run.mp4'),
      relativePath: 'videos/full-run.mp4',
      stdout: '',
      stderr: '',
      activePidEnv: ACTIVE_PID_ENV,
      previousActiveRecordingPid: '42',
    } as unknown as ActiveRecipeRecording;
    const artifacts = () =>
      JSON.parse(fs.readFileSync(artifactManifestPath, 'utf8')).artifacts as Array<
        Record<string, unknown>
      >;
    const result = { artifactManifestPath, tracePath } as Parameters<typeof stopRecipeRecording>[1];
    return { recording, sidecar, result, artifacts, bytes };
  }

  test('publishes native timing and its timeline beside the footage, and restores the pid env', async () => {
    const f = fixture();
    await stopRecipeRecording(f.recording, f.result);
    assert.deepEqual(fs.readFileSync(f.recording.outputPath), f.bytes);
    assert.ok(fs.lstatSync(`${f.recording.outputPath}.timing.json`).isFile());
    const video = f.artifacts().find((artifact) => artifact.type === 'video');
    assert.equal(video?.timelinePath, 'videos/full-run.mp4.timeline.json');
    assert.equal(fs.existsSync(f.recording.stagingDir), false);
    assert.equal(process.env[ACTIVE_PID_ENV], '42');
  });

  for (const mode of ['missing', 'wrong-id', 'wrong-digest'] as const) {
    test(`keeps the video with an explicit gap for ${mode} timing`, async () => {
      const f = fixture();
      const file = `${f.recording.stagedPath}.timing.json`;
      if (mode === 'missing') fs.unlinkSync(file);
      if (mode === 'wrong-id')
        fs.writeFileSync(file, JSON.stringify({ ...f.sidecar, recording_id: 'another' }));
      if (mode === 'wrong-digest')
        fs.writeFileSync(file, JSON.stringify({ ...f.sidecar, video_digest: 'sha256:0' }));
      await stopRecipeRecording(f.recording, f.result);
      assert.deepEqual(fs.readFileSync(f.recording.outputPath), f.bytes);
      assert.equal(f.artifacts().length, 1);
      assert.ok(f.artifacts()[0]?.timelineUnavailableReason);
    });
  }

  test('does not turn an unfinished recording into footage', async () => {
    const f = fixture();
    f.recording.completedVideo = false;
    await assert.rejects(
      stopRecipeRecording(f.recording, f.result),
      /Missing finalized video completion/u,
    );
    assert.equal(fs.existsSync(f.recording.outputPath), false);
    assert.equal(f.artifacts().length, 0);
  });

  const interruption = {
    frames: 2400,
    mediaTimeMs: 79966.7,
    cause:
      'com.apple.ScreenCaptureKit.SCStreamErrorDomain -3805: Failed during stream due to application connection being interrupted',
  };

  test('keeps a stream-interrupted recording as partial footage and returns the interruption', async () => {
    const f = fixture();
    Object.assign(f.recording, {
      completedVideo: false,
      completedRecordingId: undefined,
      exitCode: 3,
      interruption: { ...interruption, recordingId: 'test-recording' },
    });
    const kept = await stopRecipeRecording(f.recording, f.result);
    assert.equal(kept?.videoPath, 'videos/full-run.mp4');
    assert.match(kept?.message ?? '', /^CAPTURE_INTERRUPTED: .*2400 frames .*-3805/u);
    assert.deepEqual(fs.readFileSync(f.recording.outputPath), f.bytes);
    const video = f.artifacts().find((artifact) => artifact.type === 'video');
    assert.deepEqual(video?.interruption, interruption);
    // The interruption event carries the recording identity, so native timing still verifies.
    assert.equal(video?.timelinePath, 'videos/full-run.mp4.timeline.json');
  });

  for (const [label, exitCode, event] of [
    ['an exit 3 without the interruption event', 3, undefined],
    ['an interruption event without exit 3', 1, { ...interruption, recordingId: 'test-recording' }],
  ] as const) {
    test(`does not keep footage for ${label}`, async () => {
      const f = fixture();
      Object.assign(f.recording, { completedVideo: false, exitCode, interruption: event });
      await assert.rejects(
        stopRecipeRecording(f.recording, f.result),
        /Missing finalized video completion/u,
      );
      assert.equal(f.artifacts().length, 0);
    });
  }

  test('records nothing unless asked, or for a platform without a framed recorder', async () => {
    const root = tempRoot();
    assert.equal(await startRecipeRecording('web', root, root, {}), undefined);
    if (process.platform === 'darwin')
      assert.equal(await startRecipeRecording('web', root, root, { record: true }), undefined);
  });

  test('the recording target comes from the platform; a platform without one refuses', async () => {
    useAdapters(
      fakeAdapter('web', { recording: { target: async () => ({ kind: 'pid', pid: 4242 }) } }),
      fakeAdapter('cli'),
    );
    const context = {
      nodeId: 'run',
      node: {},
      recipe: {},
      projectRoot: '/checkout',
      artifactsDir: '/artifacts',
      env: {},
    } as unknown as Parameters<
      ReturnType<typeof createRecordingTargetProvider>['resolveRecordingTarget']
    >[0];
    assert.deepEqual(await createRecordingTargetProvider('web').resolveRecordingTarget(context), {
      kind: 'pid',
      pid: 4242,
    });
    await assert.rejects(
      createRecordingTargetProvider('cli').resolveRecordingTarget(context),
      /--record-video is not implemented for the cli adapter\./u,
    );
  });
});

describe('run report', () => {
  function runFiles(root: string) {
    const summaryPath = path.join(root, 'summary.json');
    const tracePath = path.join(root, 'trace.json');
    const artifactManifestPath = path.join(root, 'artifact-manifest.json');
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({ status: 'pass', durationMs: 1500, passed: 1, total: 1 }),
    );
    fs.writeFileSync(
      tracePath,
      JSON.stringify({
        entries: [
          {
            nodeId: 'read',
            action: 'state_read',
            durationMs: 20,
            output: { account: '0x1234567890abcdef1234567890abcdef12345678', count: 2 },
          },
        ],
      }),
    );
    fs.writeFileSync(artifactManifestPath, '{"artifacts":[]}\n');
    return { summaryPath, tracePath, artifactManifestPath };
  }

  test('writes report.md under the host product name and indexes it', () => {
    const root = tempRoot();
    const files = runFiles(root);
    const report = writeRunReport(files);
    const text = fs.readFileSync(report.path, 'utf8');
    assert.match(text, /^# Shop Recipe Run\n\nStatus: pass\nDuration: 1\.5s\nNodes: 1\/1 passed/u);
    assert.deepEqual(report.preview, [
      'PASS read (state_read, 20ms): account=0x1234...5678, count=2',
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(files.artifactManifestPath, 'utf8')).artifacts[0], {
      path: 'report.md',
      type: 'report',
      label: 'Human run report',
      category: 'system',
    });
  });

  test('binds the browser to the one CDP port and records what the platform reports', () => {
    interface WebBrowser extends AdapterBrowser {
      version?: string;
    }
    const web: PlatformAdapter<object, WebBrowser> = {
      ...(fakeAdapter('web') as PlatformAdapter<object, WebBrowser>),
      run: {
        launchedBrowser: (_target, _artifacts, cdpPort) => ({
          boundTo: `slot:${cdpPort}`,
          version: '1',
        }),
        browserProvenance: (browser) => ({ browser_version: browser.version }),
      },
    };
    useAdapters(web, fakeAdapter('cli'));
    const root = tempRoot();
    const manifestPath = runFiles(root).artifactManifestPath;
    assert.equal(executedBrowser('cli', root, manifestPath, ['9222']), null);
    assert.deepEqual(executedBrowser('web', root, manifestPath, []), {
      boundTo: 'none',
      reason: 'the run had no known CDP port',
    });
    assert.deepEqual(executedBrowser('web', root, manifestPath, ['1', '2']), {
      boundTo: 'none',
      reason: 'the run drove several CDP ports (1, 2)',
    });
    const browser = executedBrowser('web', root, manifestPath, ['9222']);
    indexProductProvenanceArtifact(manifestPath, root, 'web', browser);
    const entry = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).artifacts[0];
    assert.equal(entry.path, 'product-provenance.json');
    assert.equal(entry.metadata.adapter, 'web');
    assert.equal(entry.metadata.browser_version, '1');
    const provenance = JSON.parse(
      fs.readFileSync(path.join(root, 'product-provenance.json'), 'utf8'),
    );
    assert.deepEqual(provenance.browser, { boundTo: 'slot:9222', version: '1' });
    assert.equal(provenance.git_ref, 'unknown');
  });

  test('collects the CDP ports a run gave its actions', () => {
    assert.deepEqual(
      recipeCdpPorts({
        env: { RECIPE_CDP_PORT: '9222' },
        params: { port: '9333' },
        recipeDocument: {
          paramsSchema: { properties: { fallback: { default: '9444' } } },
          workflow: {
            nodes: {
              a: { cdp_port: '{{params.port}}' },
              b: { cdp_port: '{{ params.fallback }}' },
              c: { cdp_port: '{{params.unknown}}' },
            },
          },
        },
      }),
      ['9222', '9333', '9444', 'unresolved {{params.unknown}}'],
    );
  });
});

describe('live adapter scripts', () => {
  function context(root: string) {
    return {
      nodeId: 'probe',
      projectRoot: root,
      artifactsDir: path.join(root, 'artifacts'),
      env: {},
      registerArtifact() {},
    };
  }

  test('leaves the action timeout room to report its own result', () => {
    assert.equal(liveAdapterProcessTimeoutMs({ timeout_ms: 45000 }), 60000);
    assert.equal(liveAdapterProcessTimeoutMs({ timeout_ms: 45000, settle_ms: 12000 }), 62000);
    assert.equal(liveAdapterProcessTimeoutMs({ settle_ms: 12000 }), 72000);
    assert.equal(
      liveAdapterProcessTimeoutMs({ target_timeout_ms: 90000, unlock_timeout_ms: 90000 }),
      185000,
    );
    assert.equal(
      liveAdapterProcessTimeoutMs({ timeout_ms: 45000, live_adapter_timeout_ms: 47000 }),
      47000,
    );
    assert.equal(liveAdapterProcessTimeoutMs({ timeout_ms: 'abc' }), 60000);
    assert.equal(liveAdapterProcessTimeoutMs({ live_adapter_timeout_ms: Infinity }), 60000);
    assert.equal(liveAdapterProcessTimeoutMs({}), 60000);
  });

  test('runs a namespaced action with the host env names, temp prefix and context extras', async () => {
    const root = tempRoot('live-adapter-');
    const libraryRoot = path.join(root, 'live');
    const script = path.join(libraryRoot, 'web', 'team', 'probe.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(
      script,
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "const input = JSON.parse(readFileSync(process.env.SHOP_RECIPE_ADAPTER_INPUT, 'utf8'));",
        'writeFileSync(process.env.SHOP_RECIPE_ADAPTER_OUTPUT, JSON.stringify({',
        '  context: input.context, inputPath: process.argv[2], output: input.outputPath,',
        '}));',
      ].join('\n'),
    );
    process.env.SHOP_RECIPE_LIVE_ADAPTER_DIR = libraryRoot;
    const live = await runLiveAdapterScript({
      platform: 'web',
      action: 'shop.team.probe',
      namespace: 'shop',
      node: {},
      context: context(root),
      contextExtras: { grant: { id: 'g1' } },
    });
    assert.equal(live?.script, script);
    const result = live?.result as {
      context: Record<string, unknown>;
      inputPath: string;
      output: string;
    };
    assert.deepEqual(Object.keys(result.context), [
      'nodeId',
      'projectRoot',
      'artifactsDir',
      'grant',
    ]);
    assert.match(path.basename(path.dirname(result.inputPath)), /^shop-harness-live-adapter-/u);
    assert.equal(fs.existsSync(path.dirname(result.inputPath)), false, 'the temp dir is removed');
    assert.equal(
      await runLiveAdapterScript({
        platform: 'web',
        action: 'other.team.probe',
        namespace: 'shop',
        node: {},
        context: context(root),
      }),
      null,
    );
  });

  test('bundles with the exact esbuild and es-module-lexer the package pins', async () => {
    // Prepared bytes, and so every approved sourceDigest, change with the bundler
    // patch version: the pins are exact and must be what actually resolves.
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const pinned = {
      esbuild: manifest.dependencies.esbuild,
      lexer: manifest.dependencies['es-module-lexer'],
    };
    assert.match(pinned.esbuild ?? '', /^\d+\.\d+\.\d+$/u);
    assert.match(pinned.lexer ?? '', /^\d+\.\d+\.\d+$/u);
    const esbuild = await import('esbuild');
    assert.equal(esbuild.version, pinned.esbuild);
    let directory = path.dirname(fileURLToPath(import.meta.resolve('es-module-lexer')));
    let lexer: { name?: string; version?: string } = {};
    while (lexer.name !== 'es-module-lexer' && directory !== path.dirname(directory)) {
      const candidate = path.join(directory, 'package.json');
      if (fs.existsSync(candidate))
        lexer = JSON.parse(fs.readFileSync(candidate, 'utf8')) as typeof lexer;
      if (lexer.name !== 'es-module-lexer') directory = path.dirname(directory);
    }
    assert.equal(lexer.version, pinned.lexer);
  });

  test('executes the approved bundle even when an imported source changes afterward', async () => {
    const root = tempRoot('prepared-adapter-');
    const outside = tempRoot('adapter-dependency-');
    const actionPath = path.join(root, 'web', 'team', 'probe.mjs');
    const payloadPath = path.join(outside, 'payload.mjs');
    fs.mkdirSync(path.dirname(actionPath), { recursive: true });
    fs.writeFileSync(payloadPath, 'export const value = "approved";\n');
    fs.writeFileSync(
      actionPath,
      `import { readFile, writeFile } from 'node:fs/promises';\n` +
        `import { value } from ${JSON.stringify(payloadPath)};\n` +
        `const input = JSON.parse(await readFile(process.argv[2], 'utf8'));\n` +
        `await writeFile(input.outputPath, JSON.stringify({ value }));\n`,
    );
    const prepare = () =>
      prepareLiveAdapterScript({
        platform: 'web',
        action: 'team.probe',
        namespace: 'shop',
        implementationRoot: root,
      });
    const approved = await prepare();
    assert.ok(approved);
    fs.writeFileSync(payloadPath, 'export const value = "changed";\n');
    assert.notEqual((await prepare())?.sourceDigest, approved.sourceDigest);
    const executed = await runLiveAdapterScript({
      platform: 'web',
      action: 'team.probe',
      namespace: 'shop',
      node: {},
      context: context(root),
      prepared: approved,
    });
    assert.deepEqual(executed?.result, { value: 'approved' });
  });

  test('rejects computed dynamic imports unless runtime imports are allowed', async () => {
    const root = tempRoot('dynamic-adapter-');
    const actionPath = path.join(root, 'web', 'team', 'probe.mjs');
    fs.mkdirSync(path.dirname(actionPath), { recursive: true });
    fs.writeFileSync(
      actionPath,
      `const dependency = new URL('./payload.mjs', import.meta.url);\n` +
        `await import(dependency.href);\n`,
    );
    const options = {
      platform: 'web',
      action: 'team.probe',
      namespace: 'shop',
      implementationRoot: root,
    };
    const error: unknown = await prepareLiveAdapterScript(options).catch((failure) => failure);
    assert.equal((error as { code?: string }).code, 'RECIPE_TRUST_UNBOUND_IMPORT');
    assert.match(recipeTrustFailure(error)?.userAction ?? '', /static import/u);
    const allowed = await prepareLiveAdapterScript({ ...options, allowRuntimeImports: true });
    assert.equal(allowed?.action, 'team.probe');
  });

  test('a missing implementation root is no live adapter', async () => {
    const root = tempRoot('missing-actions-');
    assert.equal(
      await prepareLiveAdapterScript({
        platform: 'web',
        action: 'shop.wallet.unlock',
        namespace: 'shop',
        implementationRoot: path.join(root, 'actions'),
      }),
      null,
    );
  });
});
