// run and call on a fake host, fake adapters and a fake engine: the engine
// door (execution, preflight, environment, bounded healing), the recipe
// library, static validation, the action catalog, network observation, and
// the two commands' envelopes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  ADAPTER_SDK_VERSION,
  createAdapterRegistry,
  type NetworkCaptureBackend,
  type PlatformAdapter,
  type RecipeNodeEvent,
} from '@farmslot/adapter-sdk';
import {
  type RecipeActionManifestDocument,
  validateRecipeActionManifestDocument,
} from '@farmslot/protocol';
import {
  type ActionAdapter,
  type ActionExecutionContext,
  createRecipeRunner,
  createStandardCoreAdapters,
  type RecipeRunResult,
} from '@farmslot/recipe-runner';

import { defaultCallArtifactsDir, redactCallValue } from '../src/harness/commands/call.js';
import {
  actionExampleCommand,
  actionLibraryContextArgs,
  activateRecipeRuntimeEnvironment,
  type CallCommandOptions,
  configureHarnessAdapters,
  configureHarnessHost,
  type ConsoleClassifier,
  describeManifestActions,
  describeRunnableRecipe,
  handleCall,
  handleCallHelp,
  handleRun,
  harnessHost,
  listRunnableRecipes,
  newHealState,
  type RecipeEngine,
  renderHumanActionExample,
  resolveActionCapabilityMatrix,
  resolveLibrarySources,
  resolveRecipeParamValue,
  type RunCommandOptions,
  runnableLibraryRecipes,
  runNetworkCaptureAction,
  validateActionInputs,
  validateRunRecipeStatic,
} from '../src/harness/index.js';
import { startRunNetworkObservation } from '../src/harness/network-observation.js';
import {
  emitHealViolation,
  executeWithHealBounds,
  prepareHeal,
  synthesizeOneNodeRecipe,
} from '../src/harness/run-engine.js';

const DEFAULT_HOST = harnessHost();
const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

// A Git checkout whose runtime directory is ignored, as product checkouts do.
function checkout(): string {
  const root = tempRoot('recipe-cli-run-checkout-');
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, '.gitignore'), 'temp/\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'app\n');
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

const CORE_ACTIONS = JSON.parse(
  fs.readFileSync(new URL('./fixtures/proof.action-manifest.json', import.meta.url), 'utf8'),
) as RecipeActionManifestDocument;

const PING_ACTION = {
  description: 'Ping the shop.',
  execution_capabilities: ['host-read-export'],
  examples: [
    { action: 'shop.ping', count: 2, mode: 'fast', intent: 'Ping the shop twice.', next: 'done' },
  ],
  schema: {
    type: 'object',
    properties: {
      count: { type: 'number', default: 1, description: 'How many pings.' },
      mode: { type: 'string', enum: ['fast', 'slow'] },
      password: { type: 'string' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

// `web` declares shop.ping; `api` (headless) only the core actions.
function manifestFor(adapter: string): RecipeActionManifestDocument {
  return {
    $schema: CORE_ACTIONS.$schema,
    actions: {
      ...CORE_ACTIONS.actions,
      ...(adapter === 'web' ? { 'shop.ping': PING_ACTION } : {}),
    },
  } as RecipeActionManifestDocument;
}

interface Calls {
  runners: Array<{ adapter: string; trustedMutation?: string; trustTaskActions: boolean }>;
  events: RecipeNodeEvent[];
  members: string[];
  networkStarts: Record<string, unknown>[];
  performanceFinalized: Array<string | undefined>;
}

function newCalls(): Calls {
  return { runners: [], events: [], members: [], networkStarts: [], performanceFinalized: [] };
}

const pingAdapter: ActionAdapter = {
  action: 'shop.ping',
  source: { kind: 'bundled', trust: 'trusted', name: 'shop' },
  async execute(node) {
    return { output: { pong: node.count ?? 1, mode: node.mode } };
  },
};

const classifier: ConsoleClassifier<{ entries: unknown[]; problems: string[] }> = {
  records: () => [],
  classify: () => null,
  signature: (message) => message,
  loadAllowlist: () => ({ entries: [], problems: [] }),
  match: () => null,
  libraryRoots: () => [],
};

type ShopEngine = RecipeEngine<{ bound: string }, { entries: unknown[]; problems: string[] }>;

function shopEngine(libraryRoot: string, calls: Calls): ShopEngine {
  return {
    bundledLibrary: { name: 'shop', root: libraryRoot, actionNamespace: 'shop' },
    async resolveActionManifest(adapter, overridePath) {
      if (overridePath) {
        return {
          manifest: JSON.parse(
            fs.readFileSync(overridePath, 'utf8'),
          ) as RecipeActionManifestDocument,
          actionSources: new Map(),
        };
      }
      const manifestPath = path.join(libraryRoot, 'manifests', `${adapter}.action-manifest.json`);
      return {
        manifest: manifestFor(adapter),
        actionSources: new Map(
          adapter === 'web'
            ? [['shop.ping', { name: 'shop', tier: 'canonical' as const, manifestPath }]]
            : [],
        ),
      };
    },
    async validateManifest(manifest) {
      const result = validateRecipeActionManifestDocument(manifest);
      if (result.status === 'invalid') throw new Error('Manifest invalid');
      return result;
    },
    actionCapabilities: (action) =>
      action === 'shop.ping' ? ['host-read-export'] : ['arbitrary-code'],
    async createRunner(adapter, manifest, options) {
      calls.runners.push({
        adapter,
        ...(options.trustedMutation ? { trustedMutation: options.trustedMutation.bound } : {}),
        trustTaskActions: options.trustTaskActions,
      });
      // Like a host runner, report each node to the run's observers.
      const adapters = [
        ...createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
        ...(adapter === 'web' ? [pingAdapter] : []),
      ].map((entry) => ({
        ...entry,
        async execute(node: Record<string, unknown>, context: ActionExecutionContext) {
          options.onActionEvent?.({
            nodeId: context.nodeId,
            action: entry.action,
            status: 'running',
          });
          const result = await entry.execute(node, context);
          options.onActionEvent?.({
            nodeId: context.nodeId,
            action: entry.action,
            status: 'passed',
          });
          return result;
        },
      }));
      return createRecipeRunner({
        actionManifest: manifest,
        adapters,
        defaultSource: { kind: 'operator', trust: 'trusted', name: 'shop-harness' },
        logger: { info() {}, warn() {}, error() {} },
        hud: false,
        runner: { source: 'worktree', name: 'Shop test', git_ref: 'a'.repeat(40) },
      });
    },
    trustedMutation: {
      load: async ({ cli }) =>
        typeof cli.fundingToken === 'string' ? { bound: cli.fundingToken } : undefined,
      authorize: async (base, plan) => ({ bound: `${base.bound}@${plan.digest.slice(0, 15)}` }),
    },
    console: classifier,
    runnerIncludes: ['package.json'],
  };
}

function shopAdapter(
  id: string,
  calls: Calls,
  extra: Partial<PlatformAdapter> = {},
): PlatformAdapter {
  return {
    id,
    sdkVersion: ADAPTER_SDK_VERSION,
    headless: id === 'api',
    resolveSlotPorts() {
      process.env.SHOP_DEVICE = 'slot-default';
    },
    runtimeStatus: async () => ({ decision: 'ready', reasons: [] }),
    devServer: {
      label: `${id}-server`,
      describe: () => `${id} dev server`,
      stop: () => ({ kind: 'stopped', status: 0, summary: `stopped ${id}` }),
      ...(id === 'web' ? { portEnv: ['SHOP_BUNDLER_PORT'], portFlags: ['bundlerPort'] } : {}),
    },
    logSources: () => [],
    appLogSource: () => null,
    hints: { launch: `launch ${id}`, relaunch: `relaunch ${id}`, runtimeProbeRecovery: () => 'x' },
    actions: {
      manifestPath: () => `/manifests/${id}.json`,
      semantic: [],
      cdpTarget: { transport: 'none', probePath: '/json/version' },
      inputFindings: (nodeId, node) =>
        node.action === 'shop.ping' && typeof node.count === 'number' && node.count > 3
          ? [
              {
                severity: 'error',
                code: 'recipe.invalid_param',
                path: `workflow.nodes.${nodeId}.count`,
                message: 'shop.ping count must not exceed 3',
              },
            ]
          : [],
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

// `web` has a dev server, a device pin, run hooks and observation.
function webAdapter(calls: Calls): PlatformAdapter {
  const backend: NetworkCaptureBackend = {
    async start(params) {
      calls.networkStarts.push(params);
      return { started: params.id };
    },
    async end(id) {
      return {
        schemaVersion: 1,
        id,
        status: 'complete',
        startedAtEpochMs: Date.now() - 5,
        totalRequests: 2,
      };
    },
    async close() {
      calls.members.push('network.close');
    },
  };
  return shopAdapter('web', calls, {
    detect: { files: (target) => fs.existsSync(path.join(target, 'shop.json')) },
    failurePatterns: { transport: /econnrefused/u },
    run: {
      pinnedEnv: () => ({ SHOP_DEVICE: process.env.SHOP_DEVICE }),
      envKeys: ['SHOP_DEVICE', 'SHOP_ACTIVE'],
      activateEnv() {
        calls.members.push('run.activateEnv');
        process.env.SHOP_ACTIVE = '1';
      },
      async prepareRuntime(_projectRoot, options) {
        calls.members.push(`run.prepareRuntime:${options.cdpPort ?? ''}`);
      },
      runtimeCheck(context) {
        calls.members.push(`run.runtimeCheck:${context.heal}`);
        return async () => {
          calls.members.push('run.runtimeCheck.healthcheck');
          return null;
        };
      },
      childEnv: (base) => ({ ...base, SHOP_CHILD: 'yes' }),
      async teardown() {
        calls.members.push('run.teardown');
      },
      violationUserAction: (violation) =>
        violation.code === 'SHOP_STATE' ? `shop: ${violation.code}` : undefined,
    },
    observation: {
      network: { backend: async () => backend, actions: true },
      performance: {
        start: async () => ({
          onActionEvent: (event) => calls.events.push(event),
          finalize: async (manifestPath) => {
            calls.performanceFinalized.push(manifestPath);
          },
        }),
      },
    },
  });
}

function bundledLibrary(): string {
  const root = tempRoot('recipe-cli-shop-library-');
  fs.mkdirSync(path.join(root, 'recipes'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'recipes', 'hello.recipe.json'),
    JSON.stringify({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Hello',
      description: 'Say hello. Twice.',
      paramsSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Who.', default: 'shop' } },
        required: ['name'],
        additionalProperties: false,
      },
      workflow: {
        entry: 'greet',
        nodes: {
          greet: {
            action: 'command',
            cmd: 'echo hello',
            intent: 'Greet the shop.',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    }),
  );
  return root;
}

function recipeFile(dir: string, nodes: Record<string, unknown>): string {
  const file = path.join(dir, 'proof.recipe.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Shop proof',
      description: 'Exercise the engine.',
      workflow: { entry: Object.keys(nodes)[0], nodes },
    }),
  );
  return file;
}

async function capture<T>(
  run: () => Promise<T>,
): Promise<{ value: T; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  const write = process.stdout.write;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '));
  // String writes are the command's; the test runner reports in binary chunks.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string') {
      return (write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    }
    stdout.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await run(), stdout, stderr };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
}

function lastJson(lines: string[]): Record<string, unknown> {
  const text = lines.join('\n');
  return JSON.parse(text.slice(text.lastIndexOf('\n{') + 1)) as Record<string, unknown>;
}

let calls: Calls;
let engine: ShopEngine;
let library: string;
let runOptions: RunCommandOptions<{ bound: string }, { entries: unknown[]; problems: string[] }>;
let callOptions: CallCommandOptions<{ bound: string }, { entries: unknown[]; problems: string[] }>;
const listed: string[] = [];
const savedEnv = { ...process.env };

beforeEach(() => {
  configureHarnessHost({
    name: 'shop-harness',
    product: 'Shop',
    envPrefix: 'SHOP_HARNESS',
    recipeEnvPrefix: 'SHOP_RECIPE',
    packageName: '@acme/shop-harness',
    packageRoot: tempRoot('recipe-cli-shop-host-'),
    bin: 'bin/shop-harness',
  });
  calls = newCalls();
  const registry = createAdapterRegistry();
  registry.register(webAdapter(calls));
  registry.register(shopAdapter('api', calls));
  configureHarnessAdapters(registry);
  library = bundledLibrary();
  engine = shopEngine(library, calls);
  listed.length = 0;
  runOptions = {
    engine,
    plan: {
      steps: (target) => [
        { step: 'seed.file', confidence: 'static', status: 'ok', detail: `seed in ${target}` },
      ],
      launchDetail: 'would open the shop',
    },
    list: async () => {
      listed.push('run --list');
      return 0;
    },
    describe: async (recipe) => {
      listed.push(`run ${recipe} --describe`);
      return 0;
    },
  };
  callOptions = {
    engine,
    list: async () => {
      listed.push('call --list');
      return 0;
    },
  };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FARMSLOT_RECIPE_SOURCE_') || key === 'RECIPE_LIBRARY_PATH')
      delete process.env[key];
  }
});

afterEach(() => {
  configureHarnessHost(DEFAULT_HOST);
  configureHarnessAdapters(createAdapterRegistry());
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('engine door', () => {
  test('a one-node call recipe keeps its inputs but owns its structure', () => {
    const recipe = synthesizeOneNodeRecipe('shop.ping', {
      intent: 'human supplied',
      count: 2,
      status: 'running',
      action: 'malicious.override',
      next: 'malicious-node',
    });
    assert.equal(recipe.title, 'shop-harness call shop.ping');
    assert.deepEqual((recipe.workflow as { nodes: Record<string, unknown> }).nodes.call, {
      intent: 'human supplied',
      count: 2,
      status: 'running',
      action: 'shop.ping',
      next: 'done',
    });
    const defaulted = synthesizeOneNodeRecipe('shop.ping', {});
    assert.match(
      String((defaulted.workflow as { nodes: { call: { intent: string } } }).nodes.call.intent),
      /Complete the requested shop\.ping operation/u,
    );
  });

  test('call values are redacted by key, and each call gets its own artifacts', () => {
    assert.deepEqual(
      redactCallValue({
        password: 'secret',
        nested: { privateKey: '0xsecret', address: '0xpublic' },
        accounts: [{ mnemonic: 'seed words', name: 'dev1' }],
        apiKey: 'api-secret',
        vault: 'encrypted-secret',
      }),
      {
        password: '<redacted>',
        nested: { privateKey: '<redacted>', address: '0xpublic' },
        accounts: [{ mnemonic: '<redacted>', name: 'dev1' }],
        apiKey: '<redacted>',
        vault: '<redacted>',
      },
    );
    assert.equal(redactCallValue('plain', 'apiKey'), '<redacted>');
    const first = defaultCallArtifactsDir('/tmp/checkout', 'shop.ping');
    assert.notEqual(defaultCallArtifactsDir('/tmp/checkout', 'shop.ping'), first);
    assert.match(first, /\/temp\/recipe\/calls\/shop\.ping-/u);
  });

  test('a failed execution runs once and records no hidden recovery', async () => {
    const root = tempRoot('recipe-cli-heal-');
    const tracePath = path.join(root, 'trace.json');
    let attempts = 0;
    const state = newHealState();
    const exec = async () => {
      attempts += 1;
      fs.writeFileSync(
        tracePath,
        JSON.stringify({ entries: [{ ok: false, error: 'cdp offline econnrefused' }] }),
      );
      return {
        status: 'fail',
        tracePath,
        summaryPath: '',
        artifactManifestPath: '',
      } as RecipeRunResult;
    };
    const { result, violation } = await executeWithHealBounds(exec, root, state);
    assert.equal(result.status, 'fail');
    assert.equal(violation, null);
    assert.equal(attempts, 1);
    assert.deepEqual(state, newHealState());
    const passed = await executeWithHealBounds(
      async () => ({ status: 'pass', tracePath }) as RecipeRunResult,
      root,
      state,
    );
    assert.equal(passed.violation, null);
  });

  test('keeps the pinned device over the slot default, applies the platform env, and restores every key', () => {
    const target = tempRoot('recipe-cli-env-');
    process.env.SHOP_DEVICE = 'pinned';
    delete process.env.SHOP_BUNDLER_PORT;
    const restore = activateRecipeRuntimeEnvironment('web', target, {
      cdpPort: '9333',
      watcherPort: '8088',
    });
    assert.equal(process.env.SHOP_DEVICE, 'pinned');
    assert.equal(process.env.SHOP_ACTIVE, '1');
    assert.equal(process.env.CDP_PORT, '9333');
    assert.equal(process.env.RECIPE_CDP_PORT, '9333');
    assert.equal(process.env.WATCHER_PORT, '8088');
    assert.equal(process.env.SHOP_BUNDLER_PORT, '8088');
    assert.equal(process.env.RECIPE_WATCHER_PORT, savedEnv.RECIPE_WATCHER_PORT);
    restore();
    assert.equal(process.env.SHOP_ACTIVE, undefined);
    assert.equal(process.env.SHOP_BUNDLER_PORT, undefined);
    assert.equal(process.env.SHOP_DEVICE, 'pinned');
  });

  test('prepares heal: the platform runtime check runs in the healthcheck phase', async () => {
    const target = tempRoot('recipe-cli-prepare-');
    const phases: string[] = [];
    const prepared = await prepareHeal('web', target, { heal: 'off' }, true, {
      onPhase: (phase) => phases.push(phase),
    });
    assert.deepEqual(typeof prepared === 'number' ? prepared : prepared.heal, 'off');
    assert.deepEqual(phases, ['install', 'healthcheck']);
    assert.deepEqual(calls.members, ['run.runtimeCheck:off', 'run.runtimeCheck.healthcheck']);

    const invalid = await capture(() => prepareHeal('web', target, { heal: 'sometimes' }, false));
    assert.equal(invalid.value, 2);
    process.env.SHOP_HARNESS_RECIPE_RUNNING = '1';
    const busy = await capture(() => prepareHeal('api', target, {}, false));
    assert.equal(busy.value, 4);
    assert.match(busy.stderr.join('\n'), /✗ shop-harness: a recipe is currently running/u);
    assert.match(busy.stderr.join('\n'), /shop-harness status --target/u);
  });

  test('words a heal-bound violation with the platform, then the violation, then the evidence', async () => {
    const result = {
      summaryPath: '/tmp/s.json',
      tracePath: '/tmp/t.json',
      artifactManifestPath: '/tmp/m.json',
    };
    const json = await capture(async () => {
      emitHealViolation(
        true,
        'run',
        result,
        { code: 'SHOP_STATE', exitCode: 1, message: 'm' },
        newHealState(),
        'web',
      );
      emitHealViolation(
        true,
        'run',
        result,
        { code: 'OTHER', exitCode: 1, message: 'm', userAction: 'retry later' },
        newHealState(),
        'web',
      );
      return emitHealViolation(
        true,
        'call',
        result,
        { code: 'OTHER', exitCode: 3, message: 'm' },
        newHealState(),
      );
    });
    assert.equal(json.value, 3);
    assert.deepEqual(
      json.stdout.map(
        (line) => (JSON.parse(line) as { error: { userAction: string } }).error.userAction,
      ),
      [
        'shop: SHOP_STATE',
        'retry later',
        'inspect /tmp/s.json and /tmp/t.json; fix the application or recipe failure before retrying',
      ],
    );
    const human = await capture(async () =>
      emitHealViolation(
        false,
        'call',
        result,
        { code: 'APP_LOGIC_FAILURE', exitCode: 1, message: 'm', originalError: 'Error: boom' },
        newHealState(),
      ),
    );
    assert.match(human.stderr[0] ?? '', /^✗ shop-harness call: boom/u);
  });
});

describe('recipe validation', () => {
  test('resolves exact parameter templates only when the parameter exists', () => {
    assert.deepEqual(
      resolveRecipeParamValue(
        {
          a: '{{params.count}}',
          b: ['{{params.nested.value}}', '{{params.missing}}'],
          c: 'x {{params.count}}',
        },
        { count: 3, nested: { value: true } },
      ),
      { a: 3, b: [true, '{{params.missing}}'], c: 'x {{params.count}}' },
    );
  });

  test("runs the adapter's input checks on every node after parameters resolve", () => {
    const recipe = {
      workflow: {
        nodes: {
          ping: { action: 'shop.ping', count: '{{params.count}}' },
          done: { action: 'end', status: 'pass' },
          broken: 'not a node',
        },
      },
    };
    assert.deepEqual(validateActionInputs(recipe, 'web', { count: 5 }), [
      {
        severity: 'error',
        code: 'recipe.invalid_param',
        path: 'workflow.nodes.ping.count',
        message: 'shop.ping count must not exceed 3',
      },
    ]);
    assert.deepEqual(validateActionInputs(recipe, 'web', { count: 2 }), []);
    assert.deepEqual(validateActionInputs(recipe, 'unregistered', { count: 5 }), []);
    assert.deepEqual(validateActionInputs({ workflow: {} }, 'web'), []);
  });

  test('a bare action name is not a recipe: the hint is the call that runs it', async () => {
    const target = checkout();
    const validated = await validateRunRecipeStatic(engine, 'ping', 'web', { target });
    assert.equal(validated.usageError?.code, 'RECIPE_NOT_FOUND');
    assert.match(
      validated.usageError?.message ?? '',
      /no packaged library recipe matched\. Library recipes for web: hello \(shop-harness run <name>\)\. This is an action, not a recipe\. Use: shop-harness call shop\.ping --adapter web --target /u,
    );
    const unparseable = path.join(target, 'broken.recipe.json');
    fs.writeFileSync(unparseable, '{');
    assert.equal(
      (await validateRunRecipeStatic(engine, unparseable, 'web', {})).usageError?.code,
      'RECIPE_UNPARSEABLE',
    );
  });
});

describe('recipe library', () => {
  test('always resolves the bundled library, and keeps its name for the bundled root', async () => {
    const sources = await resolveLibrarySources(engine, undefined);
    assert.deepEqual(sources.at(-1), {
      name: 'shop',
      root: library,
      provenance: { kind: 'bundled', trust: 'trusted', name: 'shop' },
    });
    const elsewhere = tempRoot('recipe-cli-impostor-');
    await assert.rejects(
      resolveLibrarySources(engine, `shop=${elsewhere}`),
      /Recipe library source shop must resolve to /u,
    );
  });

  test('lists, describes and resolves bundled recipes', async () => {
    const sources = await resolveLibrarySources(engine, undefined);
    assert.deepEqual(
      (await runnableLibraryRecipes(engine, 'api', sources)).map((recipe) => recipe.ref),
      ['hello'],
    );
    const [hello] = await listRunnableRecipes(engine, 'api');
    assert.deepEqual(hello?.parameters, [
      { name: 'name', type: 'string', required: true, default: 'shop', description: 'Who.' },
    ]);
    const described = await describeRunnableRecipe(engine, 'hello', 'api', sources);
    assert.ok('recipe' in described);
    assert.deepEqual(described.recipe.actions, ['command', 'end']);
    assert.equal(described.recipe.title, 'Hello');
    const missing = await describeRunnableRecipe(engine, 'nope', 'api');
    assert.ok('notFound' in missing);
    assert.match(missing.notFound, /recipe not found: nope/u);
  });
});

describe('action catalog', () => {
  test("describes actions with the catalog's namespace, source and risk", () => {
    const [ping] = describeManifestActions(engine, manifestFor('web')).filter(
      (entry) => entry.name === 'shop.ping',
    );
    assert.equal(ping?.category, 'shop');
    assert.equal(ping?.source, 'shop');
    assert.deepEqual(ping?.capabilities, ['host-read-export']);
    assert.deepEqual(ping?.fields, ['count', 'mode', 'password']);
    const command = describeManifestActions(engine, manifestFor('web')).find(
      (entry) => entry.name === 'command',
    );
    assert.equal(command?.source, 'official');
  });

  test('renders a runnable example with the host name and redacted secrets', () => {
    const [ping] = describeManifestActions(engine, manifestFor('web')).filter(
      (entry) => entry.name === 'shop.ping',
    );
    assert.ok(ping);
    assert.equal(
      actionExampleCommand(ping, 'web', '/tmp/slot one', '/usr/local/bin/shop-harness', {
        mode: 'slwo',
        password: 'hunter2',
      }),
      "shop-harness call shop.ping count=2 mode=slow 'password=<password>' --adapter web --target '/tmp/slot one'",
    );
    const example = renderHumanActionExample(ping, 'web', '/tmp/x', 'shop-harness');
    assert.match(example ?? '', /Example call:[\s\S]*shop-harness call shop\.ping count=2/u);
  });

  test('builds the capability matrix over the registered adapters', async () => {
    const matrix = await resolveActionCapabilityMatrix(engine);
    assert.deepEqual(matrix.find((row) => row.name === 'shop.ping')?.satisfyingAdapters, ['web']);
    assert.equal(
      actionLibraryContextArgs(engine, [
        { name: 'shop', root: library },
        { name: 'team', root: '/libs/team one' },
        { root: '/libs/anon' },
      ]),
      " --library 'team=/libs/team one' --library /libs/anon",
    );
  });
});

describe('network observation', () => {
  test('captures the whole run, summarizes node events, and indexes the summary', async () => {
    const artifacts = tempRoot('recipe-cli-network-');
    const manifestPath = path.join(artifacts, 'artifact-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ artifacts: [] }));
    const observer = await startRunNetworkObservation(
      'web',
      artifacts,
      artifacts,
      {},
      { cdpPort: '9222' },
    );
    assert.ok(observer);
    assert.equal(calls.networkStarts[0]?.id, 'run-network');
    observer.onActionEvent({ nodeId: 'ping', action: 'shop.ping', status: 'running' });

    const context = { artifactsDir: artifacts, nodeId: 'capture' } as Parameters<
      typeof runNetworkCaptureAction
    >[2];
    const started = await runNetworkCaptureAction(
      'web',
      { phase: 'start', id: 'focus', url_includes: ['/api'] },
      context,
    );
    assert.deepEqual(started.output, {
      action: 'app.network_capture',
      phase: 'start',
      started: 'focus',
    });
    const ended = await runNetworkCaptureAction('web', { phase: 'end', id: 'focus' }, context);
    assert.deepEqual(ended.artifacts, [
      { path: 'network/focus-summary.json', type: 'report', nodeId: 'capture' },
    ]);
    await assert.rejects(
      runNetworkCaptureAction('web', { phase: 'middle', id: 'focus' }, context),
      /phase=start\|end and a non-empty id/u,
    );

    await observer.finalize(manifestPath);
    const summary = JSON.parse(
      fs.readFileSync(path.join(artifacts, 'network/run-summary.json'), 'utf8'),
    );
    assert.equal(summary.totalRequests, 2);
    assert.deepEqual(
      summary.nodeEvents.map((event: { nodeId: string; status: string }) => [
        event.nodeId,
        event.status,
      ]),
      [['ping', 'running']],
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.artifacts.at(-1), {
      path: 'network/run-summary.json',
      type: 'report',
      label: 'Automatic network observation',
      category: 'diagnostic',
    });
    assert.deepEqual(calls.members, ['network.close']);
    await assert.rejects(
      runNetworkCaptureAction('web', { phase: 'start', id: 'late' }, context),
      /^Error: Web network observation is unavailable: run observer was not started\.$/u,
    );
  });

  test('names the adapter whose session failed to start, else the dispatching one', async () => {
    const registry = createAdapterRegistry();
    registry.register(webAdapter(calls));
    registry.register(
      shopAdapter('kiosk', calls, {
        observation: {
          network: {
            backend: async () => {
              throw new Error('no CDP port');
            },
            actions: true,
          },
        },
      }),
    );
    configureHarnessAdapters(registry);
    const artifacts = tempRoot('recipe-cli-network-broken-');
    const observer = await startRunNetworkObservation('kiosk', artifacts, artifacts, {});
    const context = { artifactsDir: artifacts, nodeId: 'capture' } as Parameters<
      typeof runNetworkCaptureAction
    >[2];
    await assert.rejects(
      runNetworkCaptureAction('web', { phase: 'start', id: 'focus' }, context),
      /^Error: Kiosk network observation is unavailable: no CDP port\.$/u,
    );
    await observer?.finalize();
  });

  test("the host's AUTO_NETWORK_CAPTURE=0 skips the whole-run capture", async () => {
    const artifacts = tempRoot('recipe-cli-network-off-');
    const observer = await startRunNetworkObservation('web', artifacts, artifacts, {
      SHOP_HARNESS_AUTO_NETWORK_CAPTURE: '0',
    });
    await observer?.finalize();
    assert.deepEqual(calls.networkStarts, []);
    assert.equal(fs.existsSync(path.join(artifacts, 'network/run-summary.json')), false);
    assert.equal(await startRunNetworkObservation('api', artifacts, artifacts, {}), undefined);
  });
});

describe('run', () => {
  test('--plan lists the host steps and the platform launch, without executing', async () => {
    const target = checkout();
    const recipe = recipeFile(target, { done: { action: 'end', status: 'pass' } });
    const web = await capture(() =>
      handleRun([recipe, '--plan', '--adapter', 'web', '--target', target, '--json'], runOptions),
    );
    assert.equal(web.value, 0);
    const plan = lastJson(web.stdout).plan as Array<{ step: string; detail: string }>;
    assert.deepEqual(
      plan.map((item) => item.step),
      [
        'resolve.recipe',
        'resolve.adapter',
        'resolve.artifactsDir',
        'validate.manifest',
        'validate.schema',
        'seed.file',
        'overlay.ensure',
        'launch.app',
        'execute.nodes',
      ],
    );
    assert.equal(plan.find((item) => item.step === 'launch.app')?.detail, 'would open the shop');
    assert.equal(calls.runners.length, 0);

    const headless = await capture(() =>
      handleRun([recipe, '--plan', '--adapter', 'api', '--target', target], {
        ...runOptions,
        plan: undefined,
      }),
    );
    assert.equal(headless.value, 0);
    assert.doesNotMatch(headless.stdout.join('\n'), /launch\.app|seed\.file/u);
    const defaults = await capture(() =>
      handleRun([recipe, '--plan', '--adapter', 'web', '--target', target, '--json'], {
        ...runOptions,
        plan: undefined,
      }),
    );
    assert.equal(
      (lastJson(defaults.stdout).plan as Array<{ step: string; detail: string }>).find(
        (item) => item.step === 'launch.app',
      )?.detail,
      'would launch/attach the app + heal transport before executing',
    );
  });

  test('--list and --describe are the host views; --describe refuses --plan', async () => {
    assert.equal(await handleRun(['--list'], runOptions), 0);
    assert.equal(await handleRun(['hello', '--describe'], runOptions), 0);
    assert.deepEqual(listed, ['run --list', 'run hello --describe']);
    const conflict = await capture(() =>
      handleRun(['hello', '--describe', '--plan', '--json'], runOptions),
    );
    assert.equal(conflict.value, 2);
    assert.match(conflict.stdout.join('\n'), /choose one: shop-harness run --list/u);
    await assert.rejects(handleRun(['--domain', 'x'], runOptions), /require run --list/u);
  });

  test('executes through the engine with observation, platform hooks and the report', async () => {
    const target = checkout();
    const artifacts = tempRoot('recipe-cli-run-artifacts-');
    const recipe = recipeFile(target, {
      ping: { action: 'shop.ping', mode: 'fast', intent: 'Ping the shop.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    });
    const run = await capture(() =>
      handleRun(
        [
          recipe,
          '--adapter',
          'web',
          '--target',
          target,
          '--heal',
          'off',
          '--artifacts-dir',
          artifacts,
          '--cdp-port',
          '9444',
          '--json',
        ],
        runOptions,
      ),
    );
    assert.equal(run.value, 0, run.stderr.join('\n'));
    const envelope = lastJson(run.stdout);
    assert.equal(envelope.status, 'pass');
    assert.equal(envelope.adapter, 'web');
    assert.ok(fs.existsSync(String(envelope.reportPath)));
    assert.deepEqual(
      calls.runners.map((runner) => runner.adapter),
      ['web', 'web'],
    );
    assert.ok(calls.members.includes('run.prepareRuntime:9444'));
    assert.ok(calls.members.includes('run.teardown'));
    assert.deepEqual(
      calls.events.map((event) => `${event.nodeId}:${event.status}`),
      ['ping:running', 'ping:passed'],
    );
    const result = envelope.result as { artifactManifestPath: string };
    assert.deepEqual(calls.performanceFinalized, [result.artifactManifestPath]);
    const summary = JSON.parse(
      fs.readFileSync(path.join(artifacts, 'network/run-summary.json'), 'utf8'),
    );
    assert.equal(summary.nodeEvents.length, 2);
    const provenance = JSON.parse(
      fs.readFileSync(path.join(artifacts, 'execution-provenance.json'), 'utf8'),
    );
    assert.deepEqual(
      provenance.snapshots.map((snapshot: { phase: string }) => snapshot.phase),
      ['start', 'pre-execute', 'end'],
    );
  });

  test('refuses before validation when the host refuses the device', async () => {
    const target = checkout();
    const recipe = recipeFile(target, { done: { action: 'end', status: 'pass' } });
    const refused = await capture(() =>
      handleRun([recipe, '--adapter', 'web', '--target', target, '--json'], {
        ...runOptions,
        targetDevice: (command, adapter) => ({
          ok: false,
          code: 'DEVICE_AMBIGUOUS',
          message: `${command} on ${adapter} needs --device`,
          userAction: 'pass --device',
        }),
      }),
    );
    assert.equal(refused.value, 2);
    assert.deepEqual(lastJson(refused.stdout).error, {
      code: 'DEVICE_AMBIGUOUS',
      message: 'run on web needs --device',
      userAction: 'pass --device',
    });
    const missing = await capture(() =>
      handleRun(
        [recipe, '--adapter', 'web', '--target', path.join(target, 'nope'), '--json'],
        runOptions,
      ),
    );
    assert.equal(missing.value, 2);
    assert.match(missing.stdout.join('\n'), /pass --target <shop-checkout>/u);
  });

  test('names the adapters that satisfy an undeclared action', async () => {
    const target = checkout();
    const recipe = recipeFile(target, {
      ping: { action: 'shop.ping', mode: 'fast', intent: 'Ping the shop.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    });
    const refused = await capture(() =>
      handleRun([recipe, '--adapter', 'api', '--target', target, '--json'], runOptions),
    );
    assert.equal(refused.value, 5);
    const error = lastJson(refused.stdout).error as Record<string, unknown>;
    assert.deepEqual(error.missingCapabilities, [
      { capability: 'shop.ping', satisfyingAdapters: ['web'] },
    ]);
    assert.match(String(error.userAction), /Inspect: shop-harness actions --matrix --json/u);
    const notFound = await capture(() =>
      handleRun(['nope', '--adapter', 'api', '--target', target, '--json'], runOptions),
    );
    assert.equal(
      (lastJson(notFound.stdout).error as { userAction: string }).userAction,
      'shop-harness run --list --adapter api --json',
    );
  });
});

describe('call', () => {
  test('runs one action and reports its output with redacted inputs', async () => {
    const target = checkout();
    const artifacts = tempRoot('recipe-cli-call-artifacts-');
    const call = await capture(() =>
      handleCall(
        // The adapter's port flag takes a value, so `port=8099` is not an action input.
        [
          'ping',
          'mode=fast',
          'password=hunter2',
          '--bundler-port',
          'port=8099',
          '--adapter',
          'web',
          '--target',
          target,
          '--heal',
          'off',
          '--artifacts-dir',
          artifacts,
          '--json',
        ],
        callOptions,
      ),
    );
    assert.equal(call.value, 0, call.stderr.join('\n'));
    const envelope = lastJson(call.stdout);
    assert.equal(envelope.resolvedAction, 'shop.ping');
    assert.deepEqual(envelope.args, { mode: 'fast', password: '<redacted>' });
    assert.deepEqual(envelope.defaultsUsed, { count: 1 });
    assert.deepEqual(envelope.output, { pong: 1, mode: 'fast' });
    assert.deepEqual(calls.runners.at(-1), { adapter: 'web', trustTaskActions: true });
  });

  test('binds the trusted mutation the engine loads from the command line to the plan', async () => {
    const target = checkout();
    const call = await capture(() =>
      handleCall(
        [
          'shop.ping',
          'mode=slow',
          '--adapter',
          'web',
          '--target',
          target,
          '--heal',
          'off',
          '--funding-token',
          'grant',
          '--json',
        ],
        callOptions,
      ),
    );
    assert.equal(call.value, 0, call.stderr.join('\n'));
    const bound = calls.runners.map((runner) => runner.trustedMutation ?? '');
    assert.equal(bound.length, 4);
    assert.deepEqual([bound[0], bound[2]], ['grant', 'grant']);
    assert.match(bound[1] ?? '', /^grant@sha256:[0-9a-f]{8}$/u);
    assert.equal(bound[3], bound[1]);
  });

  test('teaches unknown, unavailable and invalid actions', async () => {
    const target = checkout();
    const unknown = await capture(() =>
      handleCall(['nothing', '--adapter', 'web', '--target', target, '--json'], callOptions),
    );
    assert.equal(unknown.value, 2);
    assert.deepEqual(lastJson(unknown.stdout).error, {
      code: 'ACTION_UNKNOWN',
      message: 'unknown action "nothing" for the web adapter.',
      userAction: 'shop-harness actions --adapter web --json',
    });
    const unavailable = await capture(() =>
      handleCall(['ping', '--adapter', 'api', '--target', target, '--json'], callOptions),
    );
    const refusal = lastJson(unavailable.stdout).error as Record<string, unknown>;
    assert.equal(refusal.code, 'ACTION_CAPABILITY_UNAVAILABLE');
    assert.deepEqual(refusal.satisfyingAdapters, ['web']);
    const invalid = await capture(() =>
      handleCall(
        ['ping', 'count=5', 'mode=fats', '--adapter', 'web', '--target', target, '--json'],
        callOptions,
      ),
    );
    assert.equal(invalid.value, 5);
    const failure = lastJson(invalid.stdout);
    assert.deepEqual(
      (failure.findings as Array<{ path: string }>).map((finding) => finding.path),
      ['workflow.nodes.call.mode', 'workflow.nodes.call.count'],
    );
    assert.deepEqual(failure.parameterHelp, [
      {
        issue: 'invalid',
        name: 'mode',
        type: 'string',
        validValues: ['fast', 'slow'],
        received: 'fats',
        suggestion: 'fast',
      },
    ]);
  });

  test('without an action, teaches with the host example or the generic fallback', async () => {
    const guarded = await capture(() => handleCall(['--adapter', 'api'], callOptions));
    assert.equal(guarded.value, 2);
    assert.match(
      guarded.stderr.join('\n'),
      /call requires <action> first: shop-harness call <action>/u,
    );
    const target = checkout();
    fs.writeFileSync(path.join(target, 'shop.json'), '{}');
    const cwd = process.cwd();
    try {
      process.chdir(target);
      const fallback = await capture(() => handleCall([], callOptions));
      assert.equal(fallback.value, 2);
      assert.match(
        fallback.stderr.join('\n'),
        /Example: shop-harness call command --adapter web\n {2}See the vocabulary: shop-harness actions --adapter web/u,
      );
      const preferred = await capture(() =>
        handleCall([], {
          ...callOptions,
          exampleAction: (names) => names.find((name) => name.startsWith('shop.')),
        }),
      );
      assert.match(
        preferred.stderr.join('\n'),
        /Example: shop-harness call shop\.ping --adapter web/u,
      );
      process.chdir(tempRoot('recipe-cli-no-checkout-'));
      const generic = await capture(() => handleCall([], callOptions));
      assert.match(
        generic.stderr.join('\n'),
        /Example: shop-harness call <action>\n {2}See the vocabulary: shop-harness actions$/u,
      );
    } finally {
      process.chdir(cwd);
    }
    assert.equal(await handleCall(['--list'], callOptions), 0);
    assert.deepEqual(listed, ['call --list']);
  });

  test('--help renders the matching action above the generic help', async () => {
    const target = checkout();
    const help = await capture(() =>
      handleCallHelp(['ping', '--help', '--adapter', 'web', '--target', target], 'GENERIC', {
        catalog: engine,
      }),
    );
    assert.equal(help.value, 0);
    const text = help.stdout.join('');
    assert.match(text, /shop-harness call shop\.ping \[key=value/u);
    assert.match(text, /mode +string \(required\) \[one of: fast, slow\]/u);
    assert.match(text, /shop-harness call ping count=2/u);
    assert.match(text, /GENERIC/u);
    const none = await capture(() =>
      handleCallHelp(['zzz', '--adapter', 'web', '--target', target], 'GENERIC', {
        catalog: engine,
      }),
    );
    assert.match(
      none.stdout.join(''),
      /No action matches "zzz" for the web adapter[\s\S]*shop-harness actions --adapter web/u,
    );
  });
});
