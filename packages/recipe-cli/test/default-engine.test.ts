import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  ADAPTER_SDK_VERSION,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';
import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';
import { type ActionAdapter, RecipeTrustError } from '@farmslot/recipe-runner';

import { configureHarnessAdapters } from '../src/harness/adapters.js';
import { createRuntimeRecipeCatalog } from '../src/harness/catalog.js';
import { createDefaultConsoleClassifier } from '../src/harness/run-diagnostics.js';
import {
  createDefaultRecipeEngine,
  preflightRecipe,
  runRecipe,
} from '../src/harness/run-engine.js';

const core = JSON.parse(
  fs.readFileSync(new URL('./fixtures/proof.action-manifest.json', import.meta.url), 'utf8'),
) as RecipeActionManifestDocument;
const declaration = (action = 'example.read', description = 'Read the target.') => ({
  description,
  execution_capabilities: ['host-read-export' as const],
  examples: [{ action, intent: 'Read the target.', next: 'done' }],
  schema: { type: 'object', properties: {}, additionalProperties: false },
});
const recipe = (nodes: Record<string, unknown>) => ({
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Generic engine proof',
  workflow: { entry: Object.keys(nodes)[0], nodes },
});

function setup(
  t: TestContext,
  actions: RecipeActionManifestDocument['actions'],
  coded: ActionAdapter[] = [],
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'default-recipe-engine-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    configureHarnessAdapters(createAdapterRegistry());
  });
  const manifestPath = path.join(root, 'manifests', 'api.action-manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL, actions }),
  );
  const runtime: PlatformAdapter = {
    id: 'api',
    sdkVersion: ADAPTER_SDK_VERSION,
    headless: true,
    resolveSlotPorts() {},
    runtimeStatus: async () => ({ decision: 'ready', reasons: [] }),
    devServer: {
      label: 'none',
      describe: () => 'headless',
      stop: () => ({ kind: 'stopped', status: 0, summary: 'headless' }),
    },
    logSources: () => [],
    appLogSource: () => null,
    hints: { launch: 'run', relaunch: 'run', runtimeProbeRecovery: () => 'check provider' },
    actions: {
      manifestPath: () => manifestPath,
      adapters: async () => coded,
      semantic: [],
      cdpTarget: { transport: 'none', probePath: '' },
    },
    harness: {
      install: { entry: 'install.mjs', fallback: 'install.mjs', node: true },
      cleanup: { entry: 'cleanup.mjs', fallback: 'cleanup.mjs', node: true },
      verify: () => ({ error: 'unsupported' }),
    },
    runtimeContext: { forbiddenFields: [] },
    launch: async () => 0,
  };
  const registry = createAdapterRegistry();
  registry.register(runtime);
  configureHarnessAdapters(registry);
  const catalog = createRuntimeRecipeCatalog({
    runtime,
    bundledLibrary: { name: 'example', root, actionNamespace: 'example' },
  });
  const engine = createDefaultRecipeEngine({ runtime, catalog });
  return { root, manifestPath, runtime, catalog, engine };
}

const runnerOptions = (
  actionSources: Awaited<
    ReturnType<ReturnType<typeof createRuntimeRecipeCatalog>['resolveActionManifest']>
  >['actionSources'],
) => ({ actionSources, trustTaskActions: false, autoHud: false });

test('headless SDK runtime executes a real command and retains the artifact package', async (t) => {
  const { root, catalog, engine } = setup(t, {
    command: core.actions.command!,
    index_artifacts: {
      description: 'Retain files.',
      examples: [
        {
          action: 'index_artifacts',
          artifacts: ['actual.txt'],
          intent: 'Retain files.',
          next: 'done',
        },
      ],
      schema: {
        type: 'object',
        properties: { artifacts: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    },
  });
  const { manifest, actionSources } = await catalog.resolveActionManifest('api');
  const runner = await engine.createRunner('api', manifest, runnerOptions(actionSources));
  const result = await runner.run({
    projectRoot: root,
    artifactsDir: path.join(root, 'artifacts'),
    source: { kind: 'operator', trust: 'trusted' },
    recipeDocument: recipe({
      write: {
        action: 'command',
        cmd: `"${process.execPath}" -e "require('node:fs').writeFileSync('actual.txt','actual side effect')"`,
        intent: 'Write a real file.',
        next: 'index',
      },
      index: {
        action: 'index_artifacts',
        artifacts: ['actual.txt'],
        intent: 'Retain the output.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    }),
  });
  assert.equal(result.status, 'pass');
  assert.equal(fs.readFileSync(path.join(root, 'actual.txt'), 'utf8'), 'actual side effect');
  assert.equal(
    fs.readFileSync(path.join(root, 'artifacts', 'actual.txt'), 'utf8'),
    'actual side effect',
  );
  for (const file of [result.summaryPath, result.artifactManifestPath, result.tracePath])
    assert.ok(fs.statSync(file).size > 0);
  assert.equal('diagnosticsPath' in result, false);
});

test('full preflight enforces plan-bound authorization before any command runs', async (t) => {
  const { root, engine } = setup(t, { command: core.actions.command! });
  const document = recipe({
    write: {
      action: 'command',
      cmd: `"${process.execPath}" -e "require('node:fs').writeFileSync('forbidden.txt','bad')"`,
      intent: 'Execute a command.',
      next: 'done',
    },
    done: { action: 'end', status: 'pass' },
  });
  const artifacts = path.join(root, 'artifacts');
  const source = { kind: 'task' as const, trust: 'untrusted' as const };
  let planDigest: string | undefined;
  await assert.rejects(
    preflightRecipe(engine, 'api', document, artifacts, root, undefined, { source }),
    (error: unknown) => {
      assert.ok(error instanceof RecipeTrustError);
      assert.equal(error.code, 'RECIPE_TRUST_REQUIRED');
      planDigest = error.failure.recipeDigest;
      return true;
    },
  );
  assert.ok(planDigest);
  const execution = await preflightRecipe(engine, 'api', document, artifacts, root, undefined, {
    source,
    approval: { planDigest },
  });
  assert.equal(execution.plan?.digest, planDigest);
  const changed = recipe({
    ...document.workflow.nodes,
    write: {
      ...(document.workflow.nodes.write as Record<string, unknown>),
      cmd: 'echo different command',
    },
  });
  await assert.rejects(
    preflightRecipe(engine, 'api', changed, artifacts, root, undefined, {
      source,
      approval: { planDigest },
    }),
    (error: unknown) =>
      error instanceof RecipeTrustError && error.code === 'RECIPE_APPROVAL_MISMATCH',
  );
  assert.equal(fs.existsSync(path.join(root, 'forbidden.txt')), false);
  assert.equal(fs.existsSync(artifacts), false);
});

test('missing runtime handler is refused instead of manufacturing app status', async (t) => {
  const { catalog, engine } = setup(t, { 'app.status': declaration('app.status') });
  const { manifest, actionSources } = await catalog.resolveActionManifest('api');
  await assert.rejects(
    engine.createRunner('api', manifest, runnerOptions(actionSources)),
    /app.status has no registered adapter/u,
  );
});

test('read-only preflight checks provider policy without publishing execution authority', async (t) => {
  const { root, engine: base } = setup(t, { 'example.read': declaration('example.read') }, [
    {
      action: 'example.read',
      source: { kind: 'bundled', trust: 'trusted', name: 'example', digest: 'sha256:example' },
      execute: async () => {
        throw new Error('preflight executed an action');
      },
    },
  ]);
  const document = recipe({
    read: { action: 'example.read', intent: 'Read the provider.', next: 'done' },
    done: { action: 'end', status: 'pass' },
  });
  const artifacts = path.join(root, 'artifacts');
  const lifecycle: string[] = [];
  const executionHooks = {
    load: async () => {
      throw new Error('preflight loaded execution authority');
    },
    authorize: async () => {
      throw new Error('preflight published execution authority');
    },
  };
  const engine = {
    ...base,
    trustedMutation: {
      ...executionHooks,
      preflight: async () => {
        lifecycle.push('policy checked');
      },
    },
  };
  const execution = await preflightRecipe(engine, 'api', document, artifacts, root, undefined, {
    readOnly: true,
  });
  assert.deepEqual(lifecycle, ['policy checked']);
  assert.deepEqual(execution.provenanceSnapshots, []);
  assert.equal(fs.existsSync(artifacts), false);
  await assert.rejects(
    runRecipe(engine, 'api', document, artifacts, root, undefined, {}, execution),
    /Read-only preflight cannot execute/u,
  );
  await assert.rejects(
    preflightRecipe(
      { ...base, trustedMutation: executionHooks },
      'api',
      document,
      artifacts,
      root,
      undefined,
      { readOnly: true },
    ),
    { code: 'MUTATION_PREFLIGHT_UNAVAILABLE' },
  );
  await assert.rejects(
    preflightRecipe(
      {
        ...engine,
        trustedMutation: {
          ...engine.trustedMutation,
          preflight: async () => {
            throw new Error('Provider policy refused the plan');
          },
        },
      },
      'api',
      document,
      artifacts,
      root,
      undefined,
      { readOnly: true },
    ),
    /Provider policy refused/u,
  );
  assert.equal(fs.existsSync(artifacts), false);
});

test('composed action precedence preserves shadows and actual coded implementation provenance', async (t) => {
  const coded: ActionAdapter = {
    action: 'example.read',
    source: {
      kind: 'bundled',
      trust: 'trusted',
      name: 'actual-provider',
      digest: 'sha256:actual-provider',
    },
    resolveSourceDigest: async () => 'sha256:actual-provider',
    capabilities: ['host-read-export'],
    execute: async () => ({ output: { actual: true } }),
  };
  const { root, runtime, catalog } = setup(
    t,
    { 'example.read': declaration('example.read', 'Bundled description') },
    [coded],
  );
  const engine = createDefaultRecipeEngine({
    runtime,
    catalog,
    runtimeSource: { kind: 'custom-adapter', trust: 'trusted', name: 'fallback-provider' },
    resolveRuntimeDigest: async () => 'sha256:fallback-provider',
  });
  const team = path.join(root, 'team');
  fs.mkdirSync(path.join(team, 'manifests'), { recursive: true });
  fs.writeFileSync(
    path.join(team, 'manifests', 'shared.action-manifest.json'),
    JSON.stringify({
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: { 'example.read': declaration('example.read', 'Team description') },
    }),
  );
  const { manifest, actionSources } = await catalog.resolveActionManifest('api', undefined, [
    { name: 'team', root: team, provenance: { kind: 'library', trust: 'untrusted' } },
  ]);
  assert.equal(manifest.actions['example.read']?.description, 'Team description');
  assert.deepEqual(actionSources.get('example.read')?.shadows, ['example']);
  assert.equal(actionSources.get('example.read')?.trust, 'untrusted');
  const runner = await engine.createRunner(runtime.id, manifest, runnerOptions(actionSources));
  const plan = await runner.preflight({
    projectRoot: root,
    artifactsDir: path.join(root, 'artifacts'),
    source: { kind: 'operator', trust: 'trusted' },
    recipeDocument: recipe({
      read: { action: 'example.read', intent: 'Read actual provider.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    }),
  });
  const action = plan.nodes.find((node) => node.action === 'example.read')!;
  assert.equal(action.adapterOrigin?.name, 'actual-provider');
  assert.equal(action.adapterOrigin?.digest, 'sha256:actual-provider');
  assert.ok(action.capabilities.includes('host-read-export'));
  const result = await runner.run({
    projectRoot: root,
    artifactsDir: path.join(root, 'artifacts'),
    source: { kind: 'operator', trust: 'trusted' },
    recipeDocument: recipe({
      read: { action: 'example.read', intent: 'Read actual provider.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    }),
  });
  assert.equal(result.status, 'pass');
});

test('generic diagnostics treats unclassified application logs as review findings', () => {
  const classifier = createDefaultConsoleClassifier([]);
  assert.equal(classifier.classify({ line: 'INFO ready', continuation: [] }), null);
  assert.equal(
    classifier.classify({ line: '{"level":"error","message":"failed"}', continuation: [] })?.level,
    'error',
  );
  assert.equal(
    classifier.classify({ line: 'unknown log format', continuation: [] })?.source,
    'unclassified-application-log',
  );
});

test('runtime parent manifests and shared bundled declarations merge under the derived runtime', async (t) => {
  const { root, manifestPath, runtime, catalog } = setup(t, {
    'example.read': declaration('example.read', 'Derived'),
  });
  const parent = path.join(root, 'parent.json');
  fs.writeFileSync(
    parent,
    JSON.stringify({
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        'example.read': declaration('example.read', 'Parent'),
        'example.parent': declaration('example.parent'),
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'manifests', 'shared.action-manifest.json'),
    JSON.stringify({
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: { 'example.shared': declaration('example.shared') },
    }),
  );
  runtime.actions.manifestPaths = () => [parent, manifestPath];
  const { manifest, actionSources } = await catalog.resolveActionManifest('api');
  assert.equal(manifest.actions['example.read']?.description, 'Derived');
  assert.ok(manifest.actions['example.parent']);
  assert.ok(manifest.actions['example.shared']);
  assert.equal(actionSources.get('example.parent')?.manifestPath, parent);
});

test('live script execution uses the approved prepared bytes and retains its output artifact', async (t) => {
  const { root, catalog, engine } = setup(t, { 'example.read': declaration() });
  const script = path.join(root, 'actions', 'api', 'example', 'read.mjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';\nimport path from 'node:path';\nconst input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\nfs.writeFileSync(path.join(input.context.artifactsDir, 'live.txt'), 'original bytes');\nfs.writeFileSync(input.outputPath, JSON.stringify({actual:true, artifacts:[{path:'live.txt',type:'text'}]}));\n`,
  );
  const { manifest, actionSources } = await catalog.resolveActionManifest('api');
  const runner = await engine.createRunner('api', manifest, runnerOptions(actionSources));
  const request = {
    projectRoot: root,
    artifactsDir: path.join(root, 'artifacts'),
    source: { kind: 'operator' as const, trust: 'trusted' as const },
    recipeDocument: recipe({
      read: {
        action: 'example.read',
        intent: 'Execute the prepared implementation.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    }),
  };
  const plan = await runner.preflight(request);
  assert.match(
    plan.nodes.find((node) => node.action === 'example.read')!.adapterOrigin!.digest!,
    /^sha256:/u,
  );
  fs.writeFileSync(script, 'throw new Error("unapproved replacement");');
  const result = await runner.run(request);
  assert.equal(result.status, 'pass');
  assert.equal(fs.readFileSync(path.join(root, 'artifacts', 'live.txt'), 'utf8'), 'original bytes');
  const artifacts = JSON.parse(fs.readFileSync(result.artifactManifestPath, 'utf8')) as {
    artifacts: Array<{ path: string }>;
  };
  assert.ok(artifacts.artifacts.some((entry) => entry.path === 'live.txt'));
});
