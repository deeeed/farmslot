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
  type RecipeRecordingOptions,
  type RecipeRunResult,
} from '@farmslot/recipe-runner';

import {
  actionExampleCommand,
  actionLibraryContextArgs,
  renderActionDetail,
  renderHumanActionExample,
  resolveActionCapabilityMatrix,
} from '../src/harness/catalog.js';
import { acquireCheckoutLock } from '../src/harness/checkout-lock.js';
import { callArtifactsLayout, redactCallValue } from '../src/harness/commands/call.js';
import { renderHumanActionCatalog } from '../src/harness/commands/discover.js';
import { provenanceFailure, reportTrustFailure } from '../src/harness/commands/run.js';
import {
  assertConformanceReportCurrent,
  checkRecipeConformance,
  conformanceChecksPass,
  recipeConformanceIdentity,
  type RecipeConformanceOptions,
  writeRecipeConformanceReport,
} from '../src/harness/conformance.js';
import {
  activateRecipeRuntimeEnvironment,
  type CallCommandOptions,
  configureHarnessAdapters,
  configureHarnessHost,
  type ConsoleClassifier,
  countRecipeNodes,
  createRecordingTargetProvider,
  type DescribedAction,
  describeManifestActions,
  describeRunnableRecipe,
  handleActions,
  handleCall,
  handleCallHelp,
  handleRun,
  harnessHost,
  listRunnableRecipes,
  newHealState,
  parseArgs,
  ProvenanceDriftError,
  type RecipeEngine,
  recipeRuntimePath,
  resolveHarnessContext,
  resolveLibrarySources,
  type RunCommandOptions,
  runnableLibraryRecipes,
  runNetworkCaptureAction,
  setHarnessContext,
  validateActionInputs,
  validateCommandNodes,
  validateRunRecipeStatic,
} from '../src/harness/index.js';
import { startRunNetworkObservation } from '../src/harness/network-observation.js';
import {
  emitHealViolation,
  executeWithHealBounds,
  healViolationError,
  prepareHeal,
  runRecipe,
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

// A team library's action, declared for every adapter when a `team` source is configured.
const WAVE_ACTION = {
  description: 'Wave at the team.',
  execution_capabilities: ['host-read-export'],
  examples: [{ action: 'team.wave', intent: 'Wave at the team.', next: 'done' }],
  schema: { type: 'object', properties: {}, additionalProperties: false },
};

// `web` declares shop.ping; `api` (headless) only the core actions.
function manifestFor(adapter: string, team = false): RecipeActionManifestDocument {
  return {
    $schema: CORE_ACTIONS.$schema,
    actions: {
      ...CORE_ACTIONS.actions,
      ...(adapter === 'web' ? { 'shop.ping': PING_ACTION } : {}),
      ...(team ? { 'team.wave': WAVE_ACTION } : {}),
    },
  } as RecipeActionManifestDocument;
}

interface Calls {
  runners: Array<{ adapter: string; trustedMutation?: string; trustTaskActions: boolean }>;
  // The HUD policy each runner was created with (undefined: the engine's default, on).
  autoHud: Array<boolean | undefined>;
  // Each trustedMutation hook call, as `<hook>:<adapter it received>`.
  mutationHooks: string[];
  events: RecipeNodeEvent[];
  members: string[];
  networkStarts: Record<string, unknown>[];
  performanceFinalized: Array<string | undefined>;
}

function newCalls(): Calls {
  return {
    runners: [],
    autoHud: [],
    mutationHooks: [],
    events: [],
    members: [],
    networkStarts: [],
    performanceFinalized: [],
  };
}

const pingAdapter: ActionAdapter = {
  action: 'shop.ping',
  source: { kind: 'bundled', trust: 'trusted', name: 'shop' },
  async execute(node, context) {
    if (node.count !== 0) return { output: { pong: node.count ?? 1, mode: node.mode } };
    // count 0: report a screenshot taken through a fallback provider, as a platform action would.
    fs.writeFileSync(path.join(context.artifactsDir, 'shot.png'), 'png');
    return {
      output: { pong: 0, mode: node.mode },
      artifacts: [
        {
          path: 'shot.png',
          type: 'screenshot',
          label: 'Ping shot',
          metadata: { provider: 'cdp', fallbackFrom: 'native', fallbackReason: 'native timed out' },
        },
      ],
    };
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

function shopEngine(
  libraryRoot: string,
  calls: Calls,
  recording?: (adapter: string) => RecipeRecordingOptions,
): ShopEngine {
  return {
    bundledLibrary: { name: 'shop', root: libraryRoot, actionNamespace: 'shop' },
    async resolveActionManifest(adapter, overridePath, sources) {
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
        manifest: manifestFor(
          adapter,
          sources?.some((source) => source.name === 'team'),
        ),
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
      calls.autoHud.push(options.autoHud);
      // Like a host runner, report each node to the run's observers.
      const adapters = [
        ...createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
        ...(adapter === 'web' ? [pingAdapter] : []),
        ...(manifest.actions['app.network_capture']
          ? [
              {
                action: 'app.network_capture',
                source: { kind: 'bundled', trust: 'trusted', name: 'shop' },
                execute: (node: Record<string, unknown>, context: ActionExecutionContext) =>
                  runNetworkCaptureAction(adapter, node, context),
              } satisfies ActionAdapter,
            ]
          : []),
        ...(manifest.actions['app.hud']
          ? [
              {
                action: 'app.hud',
                source: { kind: 'bundled', trust: 'trusted', name: 'shop' },
                execute: () => Promise.resolve({ output: { hud: false, cleared: true } }),
              } satisfies ActionAdapter,
            ]
          : []),
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
        ...(recording ? { recording: recording(adapter) } : {}),
        runner: { source: 'worktree', name: 'Shop test', git_ref: 'a'.repeat(40) },
      });
    },
    trustedMutation: {
      preflight: async ({ adapter }) => {
        calls.mutationHooks.push(`preflight:${adapter}`);
      },
      load: async ({ cli, adapter }) => {
        calls.mutationHooks.push(`load:${adapter}`);
        return typeof cli.fundingToken === 'string' ? { bound: cli.fundingToken } : undefined;
      },
      authorize: async (base, plan, { adapter }) => {
        calls.mutationHooks.push(`authorize:${adapter}`);
        return { bound: `${base.bound}@${plan.digest.slice(0, 15)}` };
      },
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
      ...(id === 'web' ? { portEnv: ['SHOP_BUNDLER_PORT'] } : {}),
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

function streamComplete(lines: string[]): Record<string, unknown> {
  const events = lines
    .flatMap((line) => line.split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const complete = events.find((event) => event.event === 'complete');
  assert.ok(complete, 'stream has a complete event');
  return complete;
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
  runOptions = {
    engine,
    plan: {
      steps: (target) => [
        { step: 'seed.file', confidence: 'static', status: 'ok', detail: `seed in ${target}` },
      ],
      launchDetail: 'would open the shop',
    },
  };
  callOptions = { engine };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FARMSLOT_RECIPE_SOURCE_') || key === 'RECIPE_LIBRARY_PATH')
      delete process.env[key];
  }
});

afterEach(() => {
  setHarnessContext(undefined);
  configureHarnessHost(DEFAULT_HOST);
  configureHarnessAdapters(createAdapterRegistry());
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function emptyPoolDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-no-pools-'));
  pools.push(dir);
  return dir;
}
const pools: string[] = [];
afterEach(() => {
  for (const dir of pools.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// What createHarnessCli does before a command runs: resolve the invocation's
// context, which the commands read for an adapter no flag names.
async function withResolvedContext<T>(
  tokens: readonly string[],
  invoke: () => Promise<T>,
): Promise<T> {
  // An empty pool directory: the machine's own pools never reach the tests.
  setHarnessContext(await resolveHarnessContext({ tokens, slotPoolDir: emptyPoolDir() }));
  try {
    return await invoke();
  } finally {
    setHarnessContext(undefined);
  }
}

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
    const first = callArtifactsLayout('shop.ping');
    assert.notEqual(callArtifactsLayout('shop.ping').fresh, first.fresh);
    assert.match(first.fresh, /^calls\/shop\.ping-[0-9a-f-]{36}$/u);
    assert.equal(first.taskSubdir, first.fresh);
  });

  test('counts a v1 node graph (a call node once) and the arrays older recipes kept', () => {
    const v1 = {
      workflow: {
        entry: 'session',
        nodes: {
          session: { action: 'call', ref: 'shop.session', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    };
    assert.equal(countRecipeNodes(v1), 2);
    assert.equal(countRecipeNodes({ workflow: { entry: 'a', nodes: {} } }), 0);
    assert.equal(
      countRecipeNodes({ workflow: { setup: [{ id: 'a' }], main: [{ id: 'b' }, { id: 'c' }] } }),
      3,
    );
    assert.equal(countRecipeNodes({ nodes: [1, 2] }), 2);
    assert.equal(countRecipeNodes({ steps: [1] }), 1);
    for (const shapeless of [{}, { workflow: { entry: 'a' } }, 'recipe', null]) {
      assert.equal(countRecipeNodes(shapeless), undefined);
    }
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

  test('a lone capture interruption fails typed CAPTURE_INTERRUPTED; other failures classify as before', async () => {
    const root = tempRoot('recipe-cli-capture-');
    const tracePath = path.join(root, 'trace.json');
    const message =
      'CAPTURE_INTERRUPTED: the recording stream stopped after 2400 frames (80.0 s): com.apple.ScreenCaptureKit.SCStreamErrorDomain -3805: Failed during stream due to application connection being interrupted. The partial video is kept at videos/recipe-run.mp4.';
    const captureFailure = { ok: false, error: message, error_code: 'CAPTURE_INTERRUPTED' };
    const run =
      (entries: unknown[], bare = false) =>
      async () => {
        fs.writeFileSync(tracePath, JSON.stringify(bare ? entries : { entries }));
        return {
          status: 'fail',
          tracePath,
          summaryPath: '',
          artifactManifestPath: '',
          captureInterruption: {
            frames: 2400,
            mediaTimeMs: 79966.7,
            cause:
              'com.apple.ScreenCaptureKit.SCStreamErrorDomain -3805: Failed during stream due to application connection being interrupted',
            videoPath: 'videos/recipe-run.mp4',
            message,
          },
        } as RecipeRunResult;
      };
    const lone = await executeWithHealBounds(run([captureFailure]), root, newHealState());
    assert.equal(lone.violation?.code, 'CAPTURE_INTERRUPTED');
    assert.equal(lone.violation?.retryable, true);
    assert.equal(lone.violation?.exitCode, 4);
    assert.equal(lone.violation?.message, message);
    assert.match(lone.violation?.userAction ?? '', /videos\/recipe-run\.mp4/u);

    const withAppFailure = await executeWithHealBounds(
      run([captureFailure, { ok: false, error: 'expected text "Limit" was not visible' }]),
      root,
      newHealState(),
    );
    assert.equal(withAppFailure.violation?.code, 'APP_LOGIC_FAILURE');
    assert.doesNotMatch(withAppFailure.violation?.originalError ?? '', /CAPTURE_INTERRUPTED/u);
    // A trace written as a bare array (runner without provenance) is read the same way.
    const bare = await executeWithHealBounds(
      run([captureFailure, { ok: false, error: 'expected text "Limit" was not visible' }], true),
      root,
      newHealState(),
    );
    assert.equal(bare.violation?.code, 'APP_LOGIC_FAILURE');
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

  test('a capture interruption is emitted retryable, in --json and --json-stream, with its report', async () => {
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
        { code: 'CAPTURE_INTERRUPTED', exitCode: 4, message: 'm', retryable: true },
        newHealState(),
        undefined,
        [],
        '/tmp/report.md',
      );
      return emitHealViolation(
        true,
        'run',
        result,
        { code: 'APP_LOGIC_FAILURE', exitCode: 1, message: 'm' },
        newHealState(),
      );
    });
    assert.deepEqual(
      json.stdout.map((line) => {
        const { error } = JSON.parse(line) as { error: { code: string; retryable: boolean } };
        return [error.code, error.retryable];
      }),
      [
        ['CAPTURE_INTERRUPTED', true],
        ['APP_LOGIC_FAILURE', false],
      ],
    );
    assert.equal(
      (JSON.parse(json.stdout[0]!) as { reportPath?: string }).reportPath,
      '/tmp/report.md',
    );
    assert.equal((JSON.parse(json.stdout[1]!) as { reportPath?: string }).reportPath, undefined);
    // --json-stream reports the same error object.
    assert.deepEqual(
      healViolationError(
        { code: 'CAPTURE_INTERRUPTED', exitCode: 4, message: 'm', retryable: true },
        'rerun',
      ),
      {
        code: 'CAPTURE_INTERRUPTED',
        message: 'm',
        retryable: true,
        userAction: 'rerun',
        originalError: null,
      },
    );
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
    // A missing parameter is not a resolution error here: the node keeps the
    // reference, and the parameter check reports the missing value.
    assert.deepEqual(validateActionInputs(recipe, 'web', {}), []);
    assert.deepEqual(validateActionInputs(recipe, 'unregistered', { count: 5 }), []);
    assert.deepEqual(validateActionInputs({ workflow: {} }, 'web'), []);
  });

  test('warns on command nodes whose exit code cannot prove the claim', async () => {
    const codes = (nodes: Record<string, unknown>) =>
      validateCommandNodes({ workflow: { nodes } }).map((finding) => [finding.code, finding.path]);
    assert.deepEqual(
      codes({
        piped: { action: 'command', cmd: 'yarn build 2>&1 | tail -20' },
        headed: { action: 'command', command: 'cat log|head -5' },
        orElse: { action: 'command', cmd: 'false || tail -1 log' },
        tests: { action: 'command', cmd: 'yarn workspace @metamask/a run test:verbose -t "x"' },
        asserted: { action: 'command', cmd: 'npx jest src/a.test.ts' },
        count: { action: 'assert_output', source: 'asserted', match: '1 passed' },
        notTests: { action: 'command', cmd: 'yarn workspace @metamask/test-utils build' },
        config: { action: 'command', cmd: 'cat jest.config.ts vitest.config.ts' },
        testing: { action: 'command', cmd: 'yarn run testing' },
        binPath: { action: 'command', cmd: 'cd pkg && node_modules/.bin/jest' },
      }),
      [
        ['recipe.command_pipe_masks_exit', 'workflow.nodes.piped.cmd'],
        ['recipe.command_pipe_masks_exit', 'workflow.nodes.headed.command'],
        ['recipe.test_command_exit_code_only', 'workflow.nodes.tests'],
        ['recipe.test_command_exit_code_only', 'workflow.nodes.binPath'],
      ],
    );
    const target = checkout();
    const recipe = recipeFile(target, {
      unit: { action: 'command', cmd: 'yarn test | tail -5', intent: 'Run tests.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    });
    const validated = await validateRunRecipeStatic(engine, recipe, 'web', { target });
    assert.equal(validated.errorCount, 0);
    assert.deepEqual(
      validated.findings.map((finding) => [finding.severity, finding.code]),
      [
        ['warning', 'recipe.command_pipe_masks_exit'],
        ['warning', 'recipe.test_command_exit_code_only'],
      ],
    );
    const plan = await capture(() =>
      handleRun([recipe, '--plan', '--adapter', 'web', '--target', target], runOptions),
    );
    assert.equal(plan.value, 0);
    const output = plan.stdout.join('\n');
    assert.match(output, /⚠ recipe\.command_pipe_masks_exit workflow\.nodes\.unit\.cmd — /u);
    assert.match(output, /⚠ recipe\.test_command_exit_code_only workflow\.nodes\.unit — /u);

    // The command a parameter supplies is checked after static resolution.
    const parameterized = recipeFile(target, {
      unit: { action: 'command', cmd: '{{params.cmd}}', intent: 'Run tests.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    });
    const resolved = await validateRunRecipeStatic(
      engine,
      parameterized,
      'web',
      { target },
      {
        cmd: 'yarn test | tail -5',
      },
    );
    assert.deepEqual(
      resolved.findings
        .filter((finding) => finding.severity === 'warning')
        .map((finding) => [finding.severity, finding.code]),
      [
        ['warning', 'recipe.command_pipe_masks_exit'],
        ['warning', 'recipe.test_command_exit_code_only'],
      ],
    );
  });

  test('a bare action name is not a recipe: the hint is the call that runs it', async () => {
    const target = checkout();
    const validated = await validateRunRecipeStatic(engine, 'ping', 'web', { target });
    assert.equal(validated.usageError?.code, 'RECIPE_NOT_FOUND');
    assert.match(
      validated.usageError?.message ?? '',
      /no packaged library recipe matched\. Library recipes for web: hello \(shop-harness run <name>\)\. This is an action, not a recipe\. Use: shop-harness call shop\.ping --adapter web --target /u,
    );
    const team = tempRoot('recipe-cli-hint-team-');
    fs.mkdirSync(path.join(team, 'recipes'));
    const teamAction = await validateRunRecipeStatic(engine, 'wave', 'api', {
      target,
      library: [`team=${team}`],
    });
    assert.match(
      teamAction.usageError?.message ?? '',
      /This is an action, not a recipe\. Use: shop-harness call team\.wave --adapter api /u,
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

describe('actions', () => {
  // Each view prints in one write: pick it out of anything the test runner wrote meanwhile.
  const view = (lines: string[], head: string) => lines.find((line) => line.startsWith(head));
  const actions = async (...argv: string[]) => {
    const parsed = parseArgs(argv);
    return capture(() => handleActions(parsed, { catalog: engine }));
  };

  test('the matrix has one column per registered adapter, in registration order', async () => {
    const json = await actions('--matrix', '--json');
    assert.equal(json.value, 0);
    const matrix = lastJson(json.stdout);
    assert.deepEqual(matrix.adapters, ['web', 'api']);
    assert.deepEqual(
      (matrix.actions as Array<{ name: string; support: unknown }>).find(
        (row) => row.name === 'shop.ping',
      )?.support,
      { web: 'available', api: 'unavailable' },
    );
    const human = await actions('--matrix', '--action', 'ping');
    assert.deepEqual(view(human.stdout, 'action capability matrix')?.split('\n'), [
      'action capability matrix',
      'Inspect one: shop-harness actions --matrix --action <name> --json',
      'action capability  web  api',
      'shop.ping          yes  —  ',
    ]);
    const unknown = await actions('--matrix', '--action', 'zzz', '--json');
    assert.equal(unknown.value, 2);
    assert.deepEqual(lastJson(unknown.stdout).error, {
      code: 'ACTION_UNKNOWN',
      message: 'no action capability matches "zzz" across Web or Api.',
      userAction: 'shop-harness actions --matrix --json',
    });
    const conflict = await actions('--matrix', '--adapter', 'web', '--json');
    assert.equal(
      (lastJson(conflict.stdout).error as { message: string }).message,
      '--matrix cannot be combined with --adapter.',
    );
  });

  test('--action prints the same detail as call <action> --help', async () => {
    const target = checkout();
    const detail = await actions('--action', 'ping', '--adapter', 'web', '--target', target);
    assert.equal(detail.value, 0);
    const help = await capture(() =>
      handleCallHelp(['ping', '--help', '--adapter', 'web', '--target', target], 'GENERIC', {
        catalog: engine,
      }),
    );
    const text = view(detail.stdout, 'shop-harness call shop.ping') ?? '';
    assert.ok(help.stdout.includes(`${text}\n\n`));
    assert.ok(help.stdout.includes('GENERIC\n'));
    for (const line of [
      'shop-harness call shop.ping [key=value ...] [flags]',
      '  Ping the shop.',
      `  Source: shop (${path.join(library, 'manifests', 'web.action-manifest.json')}) · adapter web`,
      '  Risk: host-read-export',
      '    mode      string (required) [one of: fast, slow]',
      '    shop-harness call ping count=2 mode=fast',
      'Example call:',
      `  shop-harness call shop.ping count=2 mode=fast --adapter web --target ${target}`,
      'Recipe node:',
    ])
      assert.ok(text.split('\n').includes(line), line);
    const json = await actions('--action', 'ping', '--adapter', 'web', '--json');
    assert.equal(lastJson(json.stdout).detail, 'full');
  });

  test('lists, searches and filters the catalog with teaching errors', async () => {
    const list = await actions('--adapter', 'web', '--json');
    const summary = lastJson(list.stdout);
    assert.equal(summary.detail, 'summary');
    assert.ok(
      (summary.actions as Array<Record<string, unknown>>).every(
        (entry) => !('schema' in entry) && !('examples' in entry),
      ),
    );
    const human = await actions('--adapter', 'web');
    assert.match(
      view(human.stdout, 'actions (web)') ?? '',
      /^actions \(web\)\nInspect: shop-harness actions --action <name> {2}· {2}Run: shop-harness call <name>\n\nofficial \(\d+\)[\s\S]*\ncustom \(1\)\n {2}shop\.ping \[shop\] fields=count,mode=fast\|slow,password risk=host-read-export — Ping the shop\.$/u,
    );
    const categories = await actions('--adapter', 'web', '--categories', '--json');
    assert.ok(
      (lastJson(categories.stdout).categories as Array<{ name: string }>).some(
        (entry) => entry.name === 'shop',
      ),
    );
    const search = await actions('ping', '--adapter', 'web', '--json');
    assert.deepEqual(
      (lastJson(search.stdout).actions as Array<{ name: string }>).map((entry) => entry.name),
      ['shop.ping'],
    );
    for (const [argv, code, userAction] of [
      [
        ['--categories', '--category', 'x'],
        'ACTION_FILTER_CONFLICT',
        'shop-harness actions --adapter web --categories',
      ],
      [
        ['--category', 'nope'],
        'ACTION_CATEGORY_UNKNOWN',
        'shop-harness actions --adapter web --categories',
      ],
      [['--action', 'zzz'], 'ACTION_UNKNOWN', 'shop-harness actions --adapter web'],
      [['zzz-nothing'], 'ACTION_SEARCH_EMPTY', 'shop-harness actions --adapter web --categories'],
    ] as const) {
      const refused = await actions(...argv, '--adapter', 'web', '--json');
      assert.equal(refused.value, 2, code);
      assert.deepEqual(
        (({ code: c, userAction: u }) => ({ code: c, userAction: u }))(
          lastJson(refused.stdout).error as { code: string; userAction: string },
        ),
        { code, userAction },
      );
    }
    const unavailable = await actions('--action', 'ping', '--adapter', 'api', '--json');
    assert.deepEqual(lastJson(unavailable.stdout).error, {
      code: 'ACTION_CAPABILITY_UNAVAILABLE',
      message: 'missing action capability "shop.ping" for the api adapter.',
      capability: 'shop.ping',
      satisfyingAdapters: ['web'],
      userAction:
        'Satisfying adapters for "shop.ping": web. Inspect: shop-harness actions --matrix --action shop.ping --json',
    });
    // The envelopes keep their key order: context first, then error with its
    // details between message and userAction.
    const keyOrder = (lines: string[]) => {
      const envelope = lastJson(lines);
      return [Object.keys(envelope), Object.keys(envelope.error as object)];
    };
    assert.deepEqual(keyOrder(unavailable.stdout), [
      ['schemaVersion', 'command', 'adapter', 'action', 'error'],
      ['code', 'message', 'capability', 'satisfyingAdapters', 'userAction'],
    ]);
    const matrixCategory = await actions('--matrix', '--category', 'nope', '--json');
    assert.equal(matrixCategory.value, 2);
    assert.deepEqual(keyOrder(matrixCategory.stdout), [
      ['schemaVersion', 'command', 'view', 'category', 'availableCategories', 'error'],
      ['code', 'message', 'userAction'],
    ]);
    const raw = await actions('--raw', '--adapter', 'api');
    assert.deepEqual(Object.keys(lastJson(raw.stdout)), ['$schema', 'actions']);
  });

  test("groups the bundled namespace's actions by domain", () => {
    const described = describeManifestActions(engine, {
      $schema: CORE_ACTIONS.$schema,
      actions: { 'shop.cart.add': PING_ACTION, 'team.wave': WAVE_ACTION },
    });
    const text = renderHumanActionCatalog(engine, described, { title: 't', guidance: 'g' });
    assert.match(text, /\nshop · cart \(1\)\n {2}shop\.cart\.add/u);
    assert.match(text, /\ncustom \(1\)\n {2}team\.wave/u);
  });
});

describe('action examples', () => {
  test('hides recipe-owned fields and renders a runnable call from an authored example', () => {
    const [selected] = describeManifestActions(engine, {
      $schema: CORE_ACTIONS.$schema,
      actions: {
        'shop.wallet.select_account': {
          description: 'Select a wallet account.',
          schema: { properties: { action: {}, next: {}, name: {}, address: {} } },
          examples: [
            {
              action: 'shop.wallet.select_account',
              intent: 'Select Account 2.',
              name: 'Account 2',
              next: 'done',
            },
          ],
        },
      },
    });
    assert.ok(selected);
    assert.deepEqual(selected.fields, ['address', 'name']);
    const output = renderHumanActionExample(selected, 'web', '/tmp/slot one', 'shop-harness') ?? '';
    assert.match(output, /shop-harness call shop\.wallet\.select_account 'name=Account 2'/u);
    assert.match(output, /--target '\/tmp\/slot one'/u);
    assert.doesNotMatch(output, /next=done/u);
  });

  const positions = {
    name: 'shop.orders.ensure_positions',
    fields: ['market', 'side', 'state', 'notional'],
    examples: [
      { action: 'shop.orders.ensure_positions', market: 'BTC', state: 'none' },
      {
        action: 'shop.orders.ensure_positions',
        market: 'ETH',
        side: 'long',
        state: 'open',
        notional: 10,
      },
    ],
  } as DescribedAction;
  const example = (entry: Partial<DescribedAction>, values: Record<string, unknown>) =>
    actionExampleCommand(entry as DescribedAction, 'web', '/tmp/slot', 'shop-harness', values) ??
    '';

  test('picks the authored example closest to the supplied values', () => {
    for (const part of ['market=ETH', 'side=long', 'state=open', 'notional=10'])
      assert.ok(example(positions, { market: 'ETH', state: 'open' }).includes(part), part);
    // The complete state-compatible example beats a market-only match.
    for (const part of ['market=BTC', 'state=open', 'side=long', 'notional=10'])
      assert.ok(example(positions, { market: 'BTC', state: 'open' }).includes(part), part);
    // An alias-compatible example fills the missing inputs; the caller's spelling stays.
    for (const part of ['market=ETH', 'side=long', 'state=present', 'notional=10'])
      assert.ok(
        example(
          {
            ...positions,
            examples: [
              {
                action: 'shop.orders.ensure_positions',
                market: 'BTC',
                side: 'long',
                state: 'open',
                notional: 10,
              },
            ],
          },
          {
            market: 'ETH',
            state: 'present',
          },
        ).includes(part),
        part,
      );
  });

  test('keeps caller values, repairs enum values, and falls back on a wrongly typed value', () => {
    const account = {
      name: 'shop.wallet.select_account',
      fields: ['name'],
      examples: [{ action: 'shop.wallet.select_account', name: 'Account 2' }],
    };
    assert.match(example(account, { name: 'Missing account' }), /'name=Missing account'/u);
    const orders = {
      name: 'shop.orders.assert_orders',
      fields: ['state'],
      schema: { properties: { state: { enum: ['none', 'open'] } } },
      examples: [{ action: 'shop.orders.assert_orders', state: 'none' }],
    };
    assert.match(example(orders, { state: 'opne' }), /state=open/u);
    assert.match(example(orders, { state: 'present' }), /state=open/u);
    const command = {
      name: 'command',
      fields: ['cmd'],
      schema: { properties: { cmd: { type: 'string' } } },
      examples: [{ action: 'command', cmd: 'pwd' }],
    };
    assert.match(example(command, { cmd: 12345 }), /cmd=pwd/u);
  });

  test('never renders caller secrets', () => {
    const output = example(
      {
        name: 'team.auth.call',
        fields: ['token', 'password', 'payload'],
        examples: [
          {
            action: 'team.auth.call',
            token: 'example-token',
            password: 'example-password',
            payload: { secret: 'nested-example' },
          },
        ],
      },
      {
        token: 'SECRET_VALUE',
        password: 'PASSWORD_VALUE',
        payload: { secret: 'NESTED_VALUE' },
      },
    );
    for (const secret of ['SECRET_VALUE', 'PASSWORD_VALUE', 'NESTED_VALUE'])
      assert.ok(!output.includes(secret), secret);
    for (const part of ['token=<token>', 'password=<password>', '<redacted>'])
      assert.ok(output.includes(part), part);
  });

  test('short example calls carry only the fields, shell-quoted, under an unambiguous name', () => {
    const [branch, palette] = describeManifestActions(engine, {
      $schema: CORE_ACTIONS.$schema,
      actions: {
        'shop.flow.switch': {
          description: 'Branch on a value.',
          schema: { properties: { value: {}, equals: {} } },
          examples: [
            {
              action: 'shop.flow.switch',
              value: '{{params.mode}}',
              equals: 'warm start',
              cases: { match: 'warm' },
              default: 'cold',
              intent: 'Branch.',
            },
          ],
        },
        'shop.ui.set_flags': {
          description: 'Set flags.',
          schema: { properties: { flags: {} } },
          examples: [{ action: 'shop.ui.set_flags', flags: { theme: "dark's" } }],
        },
      },
    });
    assert.ok(branch && palette);
    const detail = (entry: DescribedAction, names: string[]) =>
      renderActionDetail(entry, 'web', '/tmp/x', 'shop-harness', names).split('\n');
    const examples = (lines: string[]) => {
      const start = lines.indexOf('  Examples:') + 1;
      return lines.slice(start, lines.indexOf('', start));
    };
    // Graph keys (cases, default) are not the action's fields.
    assert.deepEqual(examples(detail(branch, [branch.name])), [
      "    shop-harness call switch 'equals=warm start' 'value={{params.mode}}'",
    ]);
    // A short name another action shares falls back to the full name.
    assert.deepEqual(examples(detail(branch, [branch.name, 'command', 'other.switch'])), [
      "    shop-harness call shop.flow.switch 'equals=warm start' 'value={{params.mode}}'",
    ]);
    // An object value survives shell word splitting as one key=value argument.
    const [line] = examples(detail(palette, [palette.name]));
    const argv = execFileSync('bash', ['-c', `printf '%s\\n' ${line!.trim()}`], {
      encoding: 'utf8',
    }).split('\n');
    assert.deepEqual(argv.slice(0, 4), [
      'shop-harness',
      'call',
      'set_flags',
      'flags={"theme":"dark\'s"}',
    ]);
    assert.ok(detail(palette, [palette.name]).includes('  Source: shop · adapter web'));
  });
});

describe('network observation', () => {
  test('captures the whole run, summarizes node events, and indexes the summary', async () => {
    const artifacts = tempRoot('recipe-cli-network-');
    const manifestPath = path.join(artifacts, 'artifact-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ artifacts: [] }));
    const observer = await startRunNetworkObservation('web', artifacts, artifacts, {
      CDP_PORT: '9222',
    });
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
  test('lists evidence produced through a fallback provider in json, stream and human output', async () => {
    const target = checkout();
    const recipe = recipeFile(target, {
      shot: { action: 'shop.ping', mode: 'fast', count: 0, intent: 'Take a shot.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    });
    const run = (dir: string, ...flags: string[]) =>
      capture(() =>
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
            path.join(target, dir),
            ...flags,
          ],
          runOptions,
        ),
      );
    const json = await run('art-json', '--json');
    assert.equal(json.value, 0);
    assert.deepEqual(lastJson(json.stdout).fallbacks, [
      {
        path: path.join(target, 'art-json', 'shot.png'),
        label: 'Ping shot',
        fallbackFrom: 'native',
        fallbackReason: 'native timed out',
      },
    ]);
    const stream = await run('art-stream', '--json-stream');
    assert.deepEqual(streamComplete(stream.stdout).fallbacks, [
      {
        path: path.join(target, 'art-stream', 'shot.png'),
        label: 'Ping shot',
        fallbackFrom: 'native',
        fallbackReason: 'native timed out',
      },
    ]);
    const human = await run('art-human');
    assert.match(
      human.stdout.join('\n'),
      /Ping shot: .*shot\.png \(fallback from native: native timed out\)/u,
    );
    assert.match(human.stdout.join('\n'), /Human run report: .*report\.md/u);
    const plain = await capture(() =>
      handleRun(
        [
          recipeFile(target, { done: { action: 'end', status: 'pass' } }),
          '--adapter',
          'web',
          '--target',
          target,
          '--heal',
          'off',
          '--json',
        ],
        runOptions,
      ),
    );
    assert.equal('fallbacks' in lastJson(plain.stdout), false);
    const plainHuman = await capture(() =>
      handleRun(
        [
          recipeFile(target, { done: { action: 'end', status: 'pass' } }),
          '--adapter',
          'web',
          '--target',
          target,
          '--heal',
          'off',
        ],
        runOptions,
      ),
    );
    assert.equal(plainHuman.value, 0);
    assert.doesNotMatch(
      [...plainHuman.stdout, ...plainHuman.stderr].join('\n'),
      /\(fallback from/u,
    );
  });

  test('lists fallback evidence when a later assertion fails the run', async () => {
    const target = checkout();
    const recipe = recipeFile(target, {
      shot: { action: 'shop.ping', mode: 'fast', count: 0, intent: 'Take a shot.', next: 'check' },
      check: {
        action: 'assert_output',
        source: 'shot',
        assert: { path: '$.pong', operator: 'eq', value: 1 },
        intent: 'Expect one pong.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    });
    const run = (dir: string, ...flags: string[]) =>
      capture(() =>
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
            path.join(target, dir),
            ...flags,
          ],
          runOptions,
        ),
      );
    const expected = (dir: string) => [
      {
        path: path.join(target, dir, 'shot.png'),
        label: 'Ping shot',
        fallbackFrom: 'native',
        fallbackReason: 'native timed out',
      },
    ];
    const json = await run('fail-json', '--json');
    assert.notEqual(json.value, 0);
    const document = lastJson(json.stdout);
    assert.equal(document.status, 'fail');
    // The heal-violation output, not the report path.
    assert.equal((document.error as { code?: unknown }).code, 'APP_LOGIC_FAILURE');
    assert.deepEqual(document.fallbacks, expected('fail-json'));
    const stream = await run('fail-stream', '--json-stream');
    assert.notEqual(stream.value, 0);
    const complete = streamComplete(stream.stdout);
    assert.equal(complete.status, 'fail');
    assert.equal(complete.exitCode, stream.value);
    assert.deepEqual(complete.fallbacks, expected('fail-stream'));
    const human = await run('fail-human');
    assert.notEqual(human.value, 0);
    assert.match(
      [...human.stdout, ...human.stderr].join('\n'),
      /Ping shot: .*shot\.png \(fallback from native: native timed out\)/u,
    );
  });

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
        'preflight.recipe',
        'seed.file',
        'overlay.ensure',
        'launch.app',
        'execute.nodes',
      ],
    );
    assert.equal(plan.find((item) => item.step === 'launch.app')?.detail, 'would open the shop');
    assert.equal(
      plan.find((item) => item.step === 'resolve.artifactsDir')?.detail,
      'resolved at run time',
    );
    assert.deepEqual(calls.mutationHooks, ['preflight:web']);
    assert.equal(calls.runners.length, 1);
    assert.equal(calls.events.length, 0);
    assert.equal(fs.existsSync(path.join(target, 'temp')), false);
    assert.match(
      String((lastJson(web.stdout).executionPlan as { digest: string }).digest),
      /^sha256:/u,
    );

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

  test('--plan refuses an untrusted action before any execution or artifact writes', async () => {
    const target = checkout();
    const recipe = recipeFile(target, {
      ping: {
        action: 'shop.ping',
        count: 1,
        mode: 'fast',
        next: 'done',
        intent: 'Read the shop response',
      },
      done: { action: 'end', status: 'pass' },
    });
    const result = await capture(() =>
      handleRun(
        [
          recipe,
          '--plan',
          '--adapter',
          'web',
          '--target',
          target,
          '--source-trust',
          'untrusted',
          '--source-kind',
          'task',
          '--json',
        ],
        runOptions,
      ),
    );
    assert.notEqual(result.value, 0);
    assert.equal((lastJson(result.stdout).error as { code: string }).code, 'RECIPE_TRUST_REQUIRED');
    assert.equal(calls.events.length, 0);
    assert.equal(fs.existsSync(path.join(target, 'temp')), false);
  });

  test('--plan rejects a declared action whose handler is missing', async () => {
    const target = checkout();
    const recipe = recipeFile(target, {
      ping: {
        action: 'shop.ping',
        count: 1,
        mode: 'fast',
        next: 'done',
        intent: 'Read the shop response',
      },
      done: { action: 'end', status: 'pass' },
    });
    const result = await capture(() =>
      handleRun([recipe, '--plan', '--adapter', 'web', '--target', target, '--json'], {
        ...runOptions,
        engine: {
          ...engine,
          createRunner: async (_adapter, manifest) =>
            createRecipeRunner({
              actionManifest: manifest,
              adapters: [],
            }),
        },
      }),
    );
    assert.equal(result.value, 5);
    const failure = lastJson(result.stdout).error as { code: string; message: string };
    assert.equal(failure.code, 'RECIPE_PREFLIGHT_FAILED');
    assert.match(failure.message, /adapter|handler/iu);
    assert.equal(calls.events.length, 0);
    assert.equal(fs.existsSync(path.join(target, 'temp')), false);
  });

  test('--plan names a provider upgrade when read-only policy support is missing', async () => {
    const target = checkout();
    const recipe = recipeFile(target, { done: { action: 'end', status: 'pass' } });
    const legacy = engine.trustedMutation!;
    const result = await capture(() =>
      handleRun([recipe, '--plan', '--adapter', 'web', '--target', target, '--json'], {
        ...runOptions,
        engine: { ...engine, trustedMutation: { load: legacy.load, authorize: legacy.authorize } },
      }),
    );
    assert.equal(result.value, 2);
    const error = lastJson(result.stdout).error as { code: string; userAction: string };
    assert.equal(error.code, 'MUTATION_PREFLIGHT_UNAVAILABLE');
    assert.match(error.userAction, /upgrade the provider/u);
    assert.deepEqual(calls.mutationHooks, []);
    assert.equal(fs.existsSync(path.join(target, 'temp')), false);
  });

  test('--plan reports an outside-checkout task artifact directory in JSON before preflight', async () => {
    const target = checkout();
    const recipe = recipeFile(target, { done: { action: 'end', status: 'pass' } });
    process.env.RECIPE_TASK_DIR = path.dirname(target);
    const result = await capture(() =>
      handleRun([recipe, '--plan', '--adapter', 'web', '--target', target, '--json'], runOptions),
    );
    assert.equal(result.value, 2);
    assert.equal((lastJson(result.stdout).error as { code: string }).code, 'ARTIFACT_DIR_INVALID');
    assert.deepEqual(calls.mutationHooks, []);
    assert.equal(fs.existsSync(path.join(target, 'temp')), false);
  });

  test('conformance binds actual source bytes and refuses stale or missing evidence', async () => {
    const target = checkout();
    const recipe = recipeFile(engine.bundledLibrary.root, {
      done: { action: 'end', status: 'pass' },
    });
    const options: RecipeConformanceOptions = {
      project: 'shop',
      context: {
        adapter: { value: 'api', source: 'flag', detail: '--adapter' },
        target: { value: target, source: 'flag', detail: '--target' },
      },
      providerRoot: engine.bundledLibrary.root,
      configurationPaths: [path.join(target, '.gitignore')],
      librarySources: [{ name: 'shop', root: engine.bundledLibrary.root }],
      artifactsDir: path.join(target, 'temp', 'checks'),
      recipes: [{ recipe }],
    };
    const report = await checkRecipeConformance(engine, options);
    assert.equal(report.status, 'pass', JSON.stringify(report.checks));
    assert.equal(calls.events.length, 0);
    const unsupported = await checkRecipeConformance(
      {
        ...engine,
        trustedMutation: { ...engine.trustedMutation!, preflight: undefined },
      },
      options,
    );
    assert.equal(unsupported.status, 'fail');
    assert.match(unsupported.checks[0]!.userAction ?? '', /upgrade the provider/u);
    assert.equal(fs.existsSync(path.join(target, 'temp')), false);
    assert.match(report.identity.checkout.head ?? '', /^[a-f0-9]{40}$/u);
    assert.equal(report.identity.checkout.dirtyDigest, null);
    assert.equal(report.identity.provider.head, null);
    assert.equal(report.identity.provider.dirtyDigest, null);
    assertConformanceReportCurrent(report, await recipeConformanceIdentity(engine, options));
    await writeRecipeConformanceReport(options.artifactsDir, report);
    assertConformanceReportCurrent(report, await recipeConformanceIdentity(engine, options));
    assert.throws(
      () =>
        assertConformanceReportCurrent(
          { ...report, checks: report.checks.map((check) => ({ ...check, evidence: undefined })) },
          report.identity,
        ),
      /passing evidence/u,
    );
    fs.writeFileSync(path.join(target, 'app.txt'), 'changed\n');
    const dirty = await recipeConformanceIdentity(engine, options);
    assert.notEqual(dirty.checkout.dirtyDigest, null);
    assert.throws(() => assertConformanceReportCurrent(report, dirty), /stale/u);
    const firstDirty = dirty.checkout.dirtyDigest;
    fs.writeFileSync(path.join(target, 'app.txt'), 'changed again\n');
    assert.notEqual(
      (await recipeConformanceIdentity(engine, options)).checkout.dirtyDigest,
      firstDirty,
    );
    fs.writeFileSync(path.join(target, '.gitignore'), 'temp/\nother/\n');
    assert.notDeepEqual(
      (await recipeConformanceIdentity(engine, options)).configuration,
      report.identity.configuration,
    );
    fs.writeFileSync(
      path.join(engine.bundledLibrary.root, 'provider.js'),
      'export const revision = 2;\n',
    );
    const changedProvider = await recipeConformanceIdentity(engine, options);
    assert.throws(() => assertConformanceReportCurrent(report, changedProvider), /stale/u);
    assert.notEqual(
      changedProvider.provider.sourceFingerprint,
      report.identity.provider.sourceFingerprint,
    );
    assert.notEqual(
      changedProvider.libraries[0]?.sourceFingerprint,
      report.identity.libraries[0]?.sourceFingerprint,
    );
  });

  test('conformance needs positive evidence for every required check', () => {
    assert.equal(conformanceChecksPass([]), false);
    for (const status of ['fail', 'missing', 'skipped', 'unsupported', 'pass'] as const) {
      assert.equal(
        conformanceChecksPass([{ id: 'recipe', status, required: true, message: 'No evidence' }]),
        false,
      );
    }
  });

  for (const placement of ['external', 'task-artifacts'])
    test(`conformance binds ${placement} recipe bytes and its adjacent task library`, async () => {
      const target = checkout();
      const task =
        placement === 'external'
          ? tempRoot('recipe-cli-external-task-')
          : path.join(target, '.task/dev/t1/artifacts');
      fs.mkdirSync(task, { recursive: true });
      const local = path.join(task, 'recipe-library');
      const recipes = path.join(local, 'recipes');
      fs.mkdirSync(recipes, { recursive: true });
      const child = recipeFile(recipes, { done: { action: 'end', status: 'pass' } });
      const recipe = recipeFile(task, {
        child: {
          action: 'call',
          ref: 'proof',
          intent: 'Check the adjacent task dependency.',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      });
      const options: RecipeConformanceOptions = {
        project: 'shop',
        context: {
          adapter: { value: 'api', source: 'flag', detail: '--adapter' },
          target: { value: target, source: 'flag', detail: '--target' },
        },
        providerRoot: engine.bundledLibrary.root,
        configurationPaths: [],
        librarySources: [{ name: 'shop', root: engine.bundledLibrary.root }],
        artifactsDir: path.join(target, '.task'),
        recipes: [{ recipe }],
      };
      const report = await checkRecipeConformance(engine, options);
      assert.equal(report.status, 'pass', JSON.stringify(report.checks));
      assert.ok(report.identity.libraries.some((source) => source.path === local));
      assert.ok(report.resolution?.recipes.some((source) => source.source === 'task-local'));
      assert.ok(report.identity.configuration.some((source) => source.path === recipe));
      const changedParams = await recipeConformanceIdentity(engine, {
        ...options,
        recipes: [{ recipe, params: { scope: 'different invocation' } }],
      });
      assert.throws(() => assertConformanceReportCurrent(report, changedParams), /stale/u);
      const changedTrust = await recipeConformanceIdentity(engine, {
        ...options,
        cli: { sourceTrust: 'untrusted', sourceKind: 'task' },
      });
      assert.throws(() => assertConformanceReportCurrent(report, changedTrust), /stale/u);
      const originalChild = fs.readFileSync(child, 'utf8');
      fs.writeFileSync(child, originalChild.replace('Shop proof', 'Changed child'));
      const changedChild = await recipeConformanceIdentity(engine, options);
      assert.throws(() => assertConformanceReportCurrent(report, changedChild), /stale/u);
      fs.writeFileSync(child, originalChild);
      fs.writeFileSync(
        recipe,
        fs.readFileSync(recipe, 'utf8').replace('Shop proof', 'Changed root'),
      );
      const changedRoot = await recipeConformanceIdentity(engine, options);
      assert.throws(() => assertConformanceReportCurrent(report, changedRoot), /stale/u);
      assert.equal(calls.events.length, 0);
    });

  test('conformance fingerprints native edits even when the runtime freshness hash omits them', async () => {
    const target = checkout();
    const registry = createAdapterRegistry();
    registry.register({ ...shopAdapter('api', calls), sourceFingerprint: () => 'bundle-only' });
    configureHarnessAdapters(registry);
    const native = path.join(target, 'android/app/build.gradle');
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, 'first native edit');
    const options: RecipeConformanceOptions = {
      project: 'shop',
      context: {
        adapter: { value: 'api', source: 'flag', detail: '--adapter' },
        target: { value: target, source: 'flag', detail: '--target' },
      },
      providerRoot: engine.bundledLibrary.root,
      configurationPaths: [],
      librarySources: [{ name: 'shop', root: engine.bundledLibrary.root }],
      artifactsDir: path.join(target, 'temp/checks'),
      recipes: [],
    };
    const before = await recipeConformanceIdentity(engine, options);
    fs.writeFileSync(native, 'second native edit');
    const after = await recipeConformanceIdentity(engine, options);
    assert.equal(before.checkout.head, after.checkout.head);
    assert.equal(before.checkout.status, after.checkout.status);
    assert.notEqual(before.checkout.sourceFingerprint, after.checkout.sourceFingerprint);
  });

  test('--list and --describe read the catalog; --describe refuses --plan', async () => {
    const list = await capture(() =>
      handleRun(['--list', '--adapter', 'api', '--json'], runOptions),
    );
    assert.equal(list.value, 0);
    assert.deepEqual(lastJson(list.stdout), {
      schemaVersion: 1,
      command: 'run',
      action: 'list',
      adapter: 'api',
      recipes: [
        {
          name: 'hello',
          source: 'shop',
          file: 'recipes/hello.recipe.json',
          shadows: [],
          adapter: 'api',
          variant: null,
          parameters: [
            { name: 'name', type: 'string', required: true, default: 'shop', description: 'Who.' },
          ],
          title: 'Hello',
          description: 'Say hello. Twice.',
        },
      ],
    });
    const human = await capture(() => handleRun(['--list', '--adapter', 'api'], runOptions));
    assert.match(
      human.stdout.join('\n'),
      /runnable recipes \(api\)\nLibraries loaded:\n {2}shop bundled · [^\n]+\nInspect: shop-harness run <recipe> --describe\n\ngeneral \(1\)\n {2}hello library=shop variant=all\n {4}Say hello\./u,
    );
    const filtered = await capture(() =>
      handleRun(['--list', '--adapter', 'api', '--domain', 'perps'], runOptions),
    );
    assert.match(
      filtered.stdout.join('\n'),
      /Filter: domain=perps\nInspect[\s\S]*No runnable recipes match\.\nAvailable domains: general/u,
    );
    const described = await capture(() =>
      handleRun(['hello', '--describe', '--adapter', 'api', '--json'], runOptions),
    );
    assert.equal(described.value, 0);
    const detail = lastJson(described.stdout);
    assert.deepEqual((detail.recipe as { actions: string[] }).actions, ['command', 'end']);
    assert.equal(detail.runCommand, 'shop-harness run hello --adapter api');
    assert.equal(detail.nextCommand, 'shop-harness run hello --adapter api --plan');
    const missing = await capture(() =>
      handleRun(['nope', '--describe', '--adapter', 'api', '--json'], runOptions),
    );
    assert.equal(missing.value, 2);
    assert.deepEqual(lastJson(missing.stdout).error as { code: string; userAction: string }, {
      code: 'RECIPE_NOT_FOUND',
      message:
        'recipe not found: nope — not a file, and no packaged library recipe matched. Library recipes for api: hello (shop-harness run <name>).',
      userAction: 'shop-harness run --list --adapter api',
    });
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

  test('binds the trusted mutation the engine loads from the command line to the plan', async () => {
    const target = checkout();
    const recipe = recipeFile(target, {
      ping: { action: 'shop.ping', mode: 'slow', intent: 'Ping the shop.', next: 'done' },
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
          '--funding-token',
          'grant',
          '--json',
        ],
        runOptions,
      ),
    );
    assert.equal(run.value, 0, run.stderr.join('\n'));
    // Each preflight plans with an unbound runner, then rebuilds with the authorized mutation.
    const bound = calls.runners.map((runner) => runner.trustedMutation ?? '');
    assert.equal(bound.length, 4);
    assert.deepEqual([bound[0], bound[2]], ['', '']);
    assert.match(bound[1] ?? '', /^grant@sha256:[0-9a-f]{8}$/u);
    assert.equal(bound[3], bound[1]);
  });

  test('keeps the first runner when authorize has nothing to bind for the plan', async () => {
    const target = checkout();
    const base = engine.trustedMutation!;
    const recipe = recipeFile(target, {
      ping: { action: 'shop.ping', mode: 'slow', intent: 'Ping the shop.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    });
    const unbound = {
      ...runOptions,
      engine: {
        ...engine,
        trustedMutation: {
          load: base.load,
          authorize: async (
            ...args: Parameters<typeof base.authorize>
          ): Promise<{ bound: string } | undefined> => {
            await base.authorize(...args);
            return undefined;
          },
        },
      },
    };
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
          '--funding-token',
          'grant',
          '--json',
        ],
        unbound,
      ),
    );
    assert.equal(run.value, 0, run.stderr.join('\n'));
    // Two preflights (before and after the checkout lock), one runner each, none bound.
    assert.deepEqual(calls.runners, [
      { adapter: 'web', trustTaskActions: true },
      { adapter: 'web', trustTaskActions: true },
    ]);
    assert.deepEqual(calls.mutationHooks, [
      'load:web',
      'authorize:web',
      'load:web',
      'authorize:web',
    ]);
  });

  test('an inherited untrusted source follows the HUD policy; a surface that opts out still wins', async () => {
    const target = checkout();
    const recipe = recipeFile(target, { done: { action: 'end', status: 'pass' } });
    process.env.FARMSLOT_RECIPE_SOURCE_TRUST = 'untrusted';
    process.env.FARMSLOT_RECIPE_SOURCE_KIND = 'task';
    const policy = async (adapter: string, hud: string[]): Promise<Array<boolean | undefined>> => {
      calls.autoHud = [];
      const run = await capture(() =>
        handleRun(
          [recipe, '--adapter', adapter, '--target', target, '--heal', 'off', '--json', ...hud],
          runOptions,
        ),
      );
      assert.equal(run.value, 0, run.stderr.join('\n'));
      return [...new Set(calls.autoHud)];
    };
    assert.deepEqual(await policy('api', []), [undefined]);
    assert.deepEqual(await policy('api', ['--hud', 'hide']), [false]);

    const registry = createAdapterRegistry();
    registry.register(shopAdapter('api', calls, { run: { autoHud: () => false } }));
    configureHarnessAdapters(registry);
    assert.deepEqual(await policy('api', ['--hud', 'show']), [false]);
  });

  test('--runtime-dir selects the runtime directory before the slot resolves, for run and call', async () => {
    const seen: Array<string | undefined> = [];
    const registry = createAdapterRegistry();
    registry.register({
      ...webAdapter(calls),
      resolveSlotPorts() {
        seen.push(process.env.RECIPE_RUNTIME_DIR);
      },
    });
    configureHarnessAdapters(registry);
    delete process.env.RECIPE_RUNTIME_DIR;
    const target = checkout();
    const recipe = recipeFile(target, {
      ping: { action: 'shop.ping', mode: 'fast', intent: 'Ping the shop.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    });
    const common = ['--adapter', 'web', '--target', target, '--heal', 'off', '--json'];
    const run = await capture(() =>
      handleRun([recipe, ...common, '--runtime-dir', 'temp/recipe/runtime-9301'], runOptions),
    );
    assert.equal(run.value, 0, run.stderr.join('\n'));
    assert.ok(fs.existsSync(path.join(target, 'temp/recipe/runtime-9301')));
    delete process.env.RECIPE_RUNTIME_DIR;
    const call = await capture(() =>
      handleCall(
        ['shop.ping', 'mode=fast', ...common, '--runtime-dir', 'temp/recipe/runtime-9302'],
        callOptions,
      ),
    );
    assert.equal(call.value, 0, call.stderr.join('\n'));
    assert.equal(seen[0], 'temp/recipe/runtime-9301');
    assert.ok(
      seen
        .slice(0, seen.indexOf('temp/recipe/runtime-9302'))
        .every((dir) => dir === 'temp/recipe/runtime-9301'),
    );
    assert.equal(seen.at(-1), 'temp/recipe/runtime-9302');
    // The inline form after the action is the same option, never an input.
    delete process.env.RECIPE_RUNTIME_DIR;
    const inline = await capture(() =>
      handleCall(
        ['shop.ping', 'mode=fast', ...common, '--runtime-dir=temp/recipe/runtime-9304'],
        callOptions,
      ),
    );
    assert.equal(inline.value, 0, inline.stderr.join('\n'));
    assert.deepEqual(lastJson(inline.stdout).args, { mode: 'fast' });
    assert.equal(seen.at(-1), 'temp/recipe/runtime-9304');

    // --plan sees the same runtime directory, whether the flag or the
    // environment selects it.
    delete process.env.RECIPE_RUNTIME_DIR;
    const planOptions = {
      ...runOptions,
      plan: {
        steps: () => [
          {
            step: 'fixture.file',
            confidence: 'static' as const,
            status: 'ok' as const,
            detail: `fixture in ${process.env.RECIPE_RUNTIME_DIR ?? 'the default runtime dir'}`,
          },
        ],
        launchDetail: 'would open the shop',
      },
    };
    const fixtureDetail = (lines: string[]) =>
      (lastJson(lines).plan as Array<{ step: string; detail: string }>).find(
        (step) => step.step === 'fixture.file',
      )?.detail;
    const byFlag = await capture(() =>
      handleRun(
        [recipe, '--plan', ...common, '--runtime-dir', 'temp/recipe/runtime-9303'],
        planOptions,
      ),
    );
    delete process.env.RECIPE_RUNTIME_DIR;
    process.env.RECIPE_RUNTIME_DIR = 'temp/recipe/runtime-9303';
    const byEnv = await capture(() => handleRun([recipe, '--plan', ...common], planOptions));
    assert.equal(fixtureDetail(byFlag.stdout), 'fixture in temp/recipe/runtime-9303');
    assert.equal(fixtureDetail(byEnv.stdout), fixtureDetail(byFlag.stdout));
  });

  test('a run with a task dir records its proof targets in the acceptance ledger', async () => {
    const target = checkout();
    const taskDir = path.join(target, 'temp', 'tasks', 'feat', 'shop-1');
    fs.mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, 'inputs', 'handoff.json'),
      JSON.stringify({
        task: { acceptanceCriteria: ['The shop answers a ping.', 'Not proven here.'] },
      }),
    );
    const recipe = path.join(target, 'proof.recipe.json');
    fs.writeFileSync(
      recipe,
      JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        title: 'Shop proof',
        description: 'Prove the ping.',
        proofTargets: [{ id: 'AC1', claim: 'The shop answers a ping.' }],
        workflow: {
          entry: 'ping',
          nodes: {
            ping: {
              action: 'shop.ping',
              mode: 'fast',
              intent: 'Ping the shop.',
              proves: ['AC1'],
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      }),
    );
    process.env.RECIPE_TASK_DIR = path.relative(target, taskDir);
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
          '--cdp-port',
          '9444',
          '--json',
        ],
        runOptions,
      ),
    );
    assert.equal(run.value, 0, run.stderr.join('\n'));
    assert.equal(lastJson(run.stdout).status, 'pass');
    const ledger = JSON.parse(
      fs.readFileSync(path.join(taskDir, 'artifacts', 'acceptance-status.json'), 'utf8'),
    );
    assert.deepEqual(
      ledger.criteria.map((entry: Record<string, unknown>) => [
        entry.id,
        entry.verdict,
        entry.recipeNodes,
        entry.evidence,
      ]),
      [['AC-1', 'proven', ['ping'], ['artifacts/trace.json']]],
    );
  });

  test('the runtime check, the observers and app.network_capture run on the same ports as the engine', async () => {
    const seen: string[] = [];
    const observerEnvs: NodeJS.ProcessEnv[] = [];
    const portView = (env: NodeJS.ProcessEnv) =>
      [
        env.CDP_PORT,
        env.RECIPE_CDP_PORT,
        env.WATCHER_PORT,
        env.SHOP_BUNDLER_PORT,
        env.SHOP_ACTIVE,
      ].join('/');
    const web = webAdapter(calls);
    const registry = createAdapterRegistry();
    registry.register({
      ...web,
      resolveSlotPorts() {
        process.env.CDP_PORT = '9555';
        process.env.RECIPE_CDP_PORT = '9555';
      },
      run: {
        ...web.run,
        runtimeCheck: () => async () => {
          seen.push(`runtimeCheck:${portView(process.env)}`);
          return null;
        },
      },
      observation: {
        network: {
          // Like the Extension observer: no CDP port, no session.
          backend: async (target, env, artifactsDir) => {
            seen.push(`network:${portView(env)}`);
            observerEnvs.push(env);
            if (!env.CDP_PORT) throw new Error('network observation requires CDP_PORT');
            return web.observation!.network!.backend(target, env, artifactsDir);
          },
          actions: true,
        },
        performance: {
          start: async (context) => {
            seen.push(`performance:${portView(context.env)}`);
            observerEnvs.push(context.env);
            return web.observation!.performance!.start(context);
          },
        },
      },
    });
    configureHarnessAdapters(registry);
    for (const key of ['CDP_PORT', 'RECIPE_CDP_PORT', 'WATCHER_PORT', 'SHOP_BUNDLER_PORT']) {
      delete process.env[key];
    }
    const target = checkout();
    const runArgs = (artifactsDir: string, ...flags: string[]) => [
      recipe,
      '--adapter',
      'web',
      '--target',
      target,
      '--heal',
      'off',
      '--artifacts-dir',
      artifactsDir,
      '--action-manifest',
      manifestPath,
      '--json',
      ...flags,
    ];
    const artifacts = tempRoot('recipe-cli-run-slot-ports-');
    const manifestPath = path.join(target, 'network.action-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        ...CORE_ACTIONS,
        actions: {
          ...CORE_ACTIONS.actions,
          'shop.ping': PING_ACTION,
          'app.network_capture': {
            description: 'Open or close a network capture window.',
            execution_capabilities: ['host-read-export'],
            examples: [
              {
                action: 'app.network_capture',
                phase: 'start',
                id: 'focus',
                intent: 'Capture.',
                next: 'done',
              },
            ],
            schema: {
              type: 'object',
              properties: { phase: { type: 'string' }, id: { type: 'string' } },
              required: ['phase', 'id'],
              additionalProperties: false,
            },
          },
        },
      }),
    );
    const recipe = recipeFile(target, {
      open: {
        action: 'app.network_capture',
        phase: 'start',
        id: 'focus',
        intent: 'Open the window.',
        next: 'close',
      },
      close: {
        action: 'app.network_capture',
        phase: 'end',
        id: 'focus',
        intent: 'Close the window.',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    });
    // The slot's port, when no flag is given.
    const slot = await capture(() => handleRun(runArgs(artifacts), runOptions));
    assert.equal(slot.value, 0, `${slot.stdout.join('\n')}\n${slot.stderr.join('\n')}`);
    assert.deepEqual(seen, [
      'runtimeCheck:9555/9555///1',
      'network:9555/9555///1',
      'performance:9555/9555///1',
    ]);
    const summary = JSON.parse(
      fs.readFileSync(path.join(artifacts, 'network/run-summary.json'), 'utf8'),
    );
    assert.equal(summary.status, 'complete');
    assert.equal(summary.nodeEvents.length, 4);
    assert.ok(fs.existsSync(path.join(artifacts, 'network/focus-summary.json')));
    // The observers keep the environment the run started them with, though
    // process.env has been restored since.
    assert.equal(process.env.SHOP_ACTIVE, undefined);
    assert.deepEqual(
      observerEnvs.map((env) => portView(env)),
      ['9555/9555///1', '9555/9555///1'],
    );

    // Explicit ports win over the slot's for every one of them, and the
    // platform's dev-server port name follows --watcher-port.
    seen.length = 0;
    const explicit = await capture(() =>
      handleRun(
        runArgs(
          tempRoot('recipe-cli-run-explicit-ports-'),
          '--cdp-port',
          '9444',
          '--watcher-port',
          '8088',
        ),
        runOptions,
      ),
    );
    assert.equal(explicit.value, 0, explicit.stderr.join('\n'));
    assert.deepEqual(seen, [
      'runtimeCheck:9444/9444/8088/8088/1',
      'network:9444/9444/8088/8088/1',
      'performance:9444/9444/8088/8088/1',
    ]);
    assert.equal(process.env.WATCHER_PORT, undefined);
    assert.equal(process.env.SHOP_ACTIVE, undefined);
    assert.equal(process.env.CDP_PORT, '9555');
    assert.equal(process.env.RECIPE_CDP_PORT, '9555');

    // call opens the same scope.
    seen.length = 0;
    const call = await capture(() =>
      handleCall(
        [
          'shop.ping',
          'mode=fast',
          '--adapter',
          'web',
          '--target',
          target,
          '--heal',
          'off',
          '--cdp-port',
          '9444',
          '--watcher-port',
          '8088',
          '--json',
        ],
        callOptions,
      ),
    );
    assert.equal(call.value, 0, call.stderr.join('\n'));
    assert.deepEqual(seen, [
      'runtimeCheck:9444/9444/8088/8088/1',
      'network:9444/9444/8088/8088/1',
      'performance:9444/9444/8088/8088/1',
    ]);
    assert.equal(process.env.WATCHER_PORT, undefined);
    assert.equal(process.env.CDP_PORT, '9555');
    assert.equal(process.env.RECIPE_CDP_PORT, '9555');

    // So does the inline `--flag=value` form after the action.
    seen.length = 0;
    const inline = await capture(() =>
      handleCall(
        [
          'shop.ping',
          'mode=fast',
          '--adapter',
          'web',
          '--target',
          target,
          '--heal',
          'off',
          '--cdp-port=9444',
          '--watcher-port=8088',
          '--json',
        ],
        callOptions,
      ),
    );
    assert.equal(inline.value, 0, inline.stderr.join('\n'));
    assert.deepEqual(lastJson(inline.stdout).args, { mode: 'fast' });
    assert.deepEqual(seen, [
      'runtimeCheck:9444/9444/8088/8088/1',
      'network:9444/9444/8088/8088/1',
      'performance:9444/9444/8088/8088/1',
    ]);
  });

  test('every exit of run and call restores the environment it found, but the slot ports it resolved', async () => {
    let mode: 'pass' | 'prepare' | 'throw' = 'pass';
    const web = webAdapter(calls);
    const registry = createAdapterRegistry();
    registry.register({
      ...web,
      resolveSlotPorts() {
        process.env.CDP_PORT = '9555';
        process.env.RECIPE_CDP_PORT = '9555';
      },
      run: {
        ...web.run,
        runtimeCheck: () => async () => (mode === 'prepare' ? 4 : null),
        async teardown() {
          if (mode === 'throw') throw new Error('teardown boom');
        },
      },
    });
    configureHarnessAdapters(registry);
    for (const key of ['CDP_PORT', 'RECIPE_CDP_PORT']) delete process.env[key];
    process.env.WATCHER_PORT = '7000';
    process.env.SHOP_BUNDLER_PORT = '7001';
    process.env.SHOP_ACTIVE = 'seed';
    const before = { ...process.env };
    const expected = { ...before, CDP_PORT: '9555', RECIPE_CDP_PORT: '9555' };
    const target = checkout();
    const passing = recipeFile(target, {
      ping: { action: 'shop.ping', mode: 'fast', intent: 'Ping the shop.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    });
    const failing = path.join(target, 'failing.recipe.json');
    fs.writeFileSync(
      failing,
      JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        title: 'Fails',
        description: 'A node that fails as app logic.',
        workflow: {
          entry: 'fail',
          nodes: {
            fail: { action: 'command', cmd: 'exit 3', intent: 'Fail.', next: 'done' },
            done: { action: 'end', status: 'pass' },
          },
        },
      }),
    );
    const flags = ['--adapter', 'web', '--target', target, '--heal', 'off', '--json'];
    const ports = ['--cdp-port', '9444', '--watcher-port', '8088'];
    const commands = {
      run: (recipe: string) => () => handleRun([recipe, ...flags, ...ports], runOptions),
      call: (input: string) => () =>
        handleCall([...input.split(' '), ...flags, ...ports], callOptions),
    };
    const exits: Array<[string, () => Promise<number>, number | 'throws']> = [
      ['run pass', commands.run(passing), 0],
      ['run violation', commands.run(failing), 1],
      ['call pass', commands.call('shop.ping mode=fast'), 0],
      ['call violation', commands.call('command cmd=false;'), 1],
    ];
    for (const [name, invoke, exit] of exits) {
      const result = await capture(invoke);
      assert.equal(result.value, exit, `${name}: ${result.stdout.join('\n')}`);
      assert.deepEqual({ ...process.env }, expected, name);
    }

    mode = 'prepare';
    for (const [name, invoke] of [
      ['run prepare', commands.run(passing)],
      ['call prepare', commands.call('shop.ping mode=fast')],
    ] as const) {
      assert.equal((await capture(invoke)).value, 4, name);
      assert.deepEqual({ ...process.env }, expected, name);
    }

    mode = 'throw';
    for (const [name, invoke] of [
      ['run throw', commands.run(passing)],
      ['call throw', commands.call('shop.ping mode=fast')],
    ] as const) {
      // The teardown error propagates: the command neither swallows it nor exits 0.
      const thrown = await capture(async () => {
        try {
          return await invoke();
        } catch (error) {
          assert.match(String(error), /teardown boom/u, name);
          return -1;
        }
      });
      assert.equal(thrown.value, -1, name);
      assert.deepEqual({ ...process.env }, expected, name);
    }

    // Another owner holds the checkout lock.
    mode = 'pass';
    const holder = acquireCheckoutLock(target, 'other');
    assert.ok(!('message' in holder));
    delete process.env.SHOP_HARNESS_CHECKOUT_LOCK_TOKEN;
    try {
      for (const [name, invoke] of [
        ['run busy', commands.run(passing)],
        ['call busy', commands.call('shop.ping mode=fast')],
      ] as const) {
        const busy = await capture(invoke);
        assert.notEqual(busy.value, 0, name);
        assert.equal((lastJson(busy.stdout).error as { code: string }).code, 'SANDBOX_BUSY', name);
        assert.deepEqual({ ...process.env }, expected, name);
      }
    } finally {
      holder.release();
    }
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

describe('--record-video', () => {
  const unsupported = {
    code: 'RECORDING_UNSUPPORTED',
    message: '--record-video is not implemented for the api adapter.',
    userAction:
      "rerun without --record-video; for visual evidence use the adapter's own screenshot action where its manifest has one, or an adapter that records: web",
  };
  let asked: string[];
  let recorded: string[];
  let recordingEngine: ShopEngine;

  // `web` records; `api` has no `recording`. The engine's runner resolves the
  // target through the harness provider and records with a fake recorder.
  beforeEach(() => {
    asked = [];
    recorded = [];
    const registry = createAdapterRegistry();
    registry.register(
      shopAdapter('web', calls, { recording: { target: async () => ({ kind: 'pid', pid: 1 }) } }),
    );
    registry.register(shopAdapter('api', calls));
    configureHarnessAdapters(registry);
    recordingEngine = shopEngine(library, calls, (adapter) => ({
      targetProvider: {
        resolveRecordingTarget(context) {
          asked.push(adapter);
          return createRecordingTargetProvider(adapter).resolveRecordingTarget(context);
        },
      },
      videoRecorder: {
        name: 'fake-recorder',
        async start({ outputPath }) {
          recorded.push(adapter);
          fs.writeFileSync(outputPath, 'video');
          return { stop: async () => ({}) };
        },
      },
    }));
  });

  test('run refuses it before execution on an adapter that cannot record', async () => {
    const target = checkout();
    const recipe = recipeFile(target, { done: { action: 'end', status: 'pass' } });
    const artifactsRoot = tempRoot('recipe-cli-record-');
    const run = (adapter: string, ...flags: string[]) => {
      const artifacts = path.join(artifactsRoot, `${adapter}${flags.join('')}`);
      return capture(() =>
        handleRun(
          [recipe, '--adapter', adapter, '--target', target, '--heal', 'off'].concat(
            ['--artifacts-dir', artifacts],
            flags,
          ),
          { engine: recordingEngine },
        ),
      );
    };

    const json = await run('api', '--record-video=full-run', '--json');
    assert.equal(json.value, 2);
    const envelope = lastJson(json.stdout);
    assert.equal(envelope.exitCode, 2);
    assert.deepEqual(envelope.error, unsupported);
    const human = await run('api', '--record');
    assert.equal(human.value, 2);
    assert.deepEqual(human.stderr, [
      `✗ run: ${unsupported.message}`,
      `  Next: ${unsupported.userAction}`,
    ]);
    // No runner, so no node ran and no recording target was asked for.
    assert.deepEqual(calls.runners, []);
    assert.deepEqual(asked, []);
    assert.deepEqual(fs.readdirSync(artifactsRoot), []);

    const off = await run('api', '--record-video=off', '--json');
    assert.equal(off.value, 0, off.stderr.join('\n'));
    assert.deepEqual(asked, []);
    const supported = await run('web', '--record-video=full-run', '--json');
    assert.equal(supported.value, 0, supported.stderr.join('\n'));
    assert.deepEqual(asked, ['web']);
    assert.deepEqual(recorded, ['web']);
  });

  test('run --json-stream reports the refusal as an error event and a failed completion', async () => {
    const target = checkout();
    const recipe = recipeFile(target, { done: { action: 'end', status: 'pass' } });
    const streamed = await capture(() =>
      handleRun(
        [recipe, '--adapter', 'api', '--target', target, '--record-video', '--json-stream'],
        {
          engine: recordingEngine,
        },
      ),
    );
    assert.equal(streamed.value, 2);
    const events = streamed.stdout
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      events.map((event) => [event.event, event.phase ?? event.status]),
      [
        ['phase', 'resolve'],
        ['error', undefined],
        ['complete', 'fail'],
      ],
    );
    assert.deepEqual(events[1]?.error, unsupported);
    assert.equal(events[2]?.exitCode, 2);
    assert.deepEqual(calls.runners, []);
  });

  test('run --plan refuses it like the run, and plans it on an adapter that records', async () => {
    const target = checkout();
    const recipe = recipeFile(target, { done: { action: 'end', status: 'pass' } });
    const plan = (adapter: string) =>
      capture(() =>
        handleRun(
          [recipe, '--plan', '--adapter', adapter, '--target', target, '--record-video', '--json'],
          { engine: recordingEngine },
        ),
      );
    const refused = await plan('api');
    assert.equal(refused.value, 2);
    const envelope = lastJson(refused.stdout);
    assert.equal(envelope.mode, 'plan');
    assert.deepEqual(envelope.error, unsupported);
    assert.equal(envelope.plan, undefined);
    const planned = await plan('web');
    assert.equal(planned.value, 0, planned.stderr.join('\n'));
    assert.equal(lastJson(planned.stdout).status, 'pass');
  });

  test('a run that reaches the missing target fails as a bounded capability refusal, not app logic', async () => {
    // Programmatic callers skip the run/call preflight: the runner asks the
    // harness provider, which throws, and the heal bounds classify the failure.
    const target = checkout();
    const recipe = recipeFile(target, { done: { action: 'end', status: 'pass' } });
    const artifacts = path.join(tempRoot('recipe-cli-record-'), 'artifacts');
    const { result, violation } = await executeWithHealBounds(
      () =>
        runRecipe(recordingEngine, 'api', recipe, artifacts, target, undefined, {
          recordVideo: 'full-run',
        }),
      target,
      newHealState(),
    );
    assert.equal(result.status, 'fail');
    assert.deepEqual(asked, ['api']);
    assert.deepEqual(recorded, []);
    assert.deepEqual(violation, {
      ...unsupported,
      exitCode: 4,
      originalError: unsupported.message,
    });
  });

  test('call refuses it before execution on an adapter that cannot record', async () => {
    const target = checkout();
    const json = await capture(() =>
      handleCall(
        ['command', 'cmd=true', '--adapter', 'api', '--target', target, '--record-video', '--json'],
        {
          engine: recordingEngine,
        },
      ),
    );
    assert.equal(json.value, 2);
    const envelope = lastJson(json.stdout);
    assert.equal(envelope.exitCode, 2);
    assert.deepEqual(envelope.error, unsupported);
    const human = await capture(() =>
      handleCall(['command', 'cmd=true', '--adapter', 'api', '--target', target, '--record'], {
        engine: recordingEngine,
      }),
    );
    assert.equal(human.value, 2);
    assert.deepEqual(human.stderr, [
      `✗ call: ${unsupported.message}`,
      `  Next: ${unsupported.userAction}`,
    ]);
    assert.deepEqual(calls.runners, []);
    assert.deepEqual(asked, []);

    const call = (adapter: string, flag: string) =>
      capture(() =>
        handleCall(
          ['command', 'cmd=pwd', '--adapter', adapter, '--target', target, '--heal', 'off'].concat(
            ['--artifacts-dir', path.join(tempRoot('recipe-cli-call-record-'), 'artifacts')],
            [flag, '--json'],
          ),
          { engine: recordingEngine },
        ),
      );
    // After the action, an inline `--record-video=<mode>` is an option like the
    // bare flag: `off` records nothing, and a mode the adapter can't record is
    // refused before execution.
    const off = await call('api', '--record-video=off');
    assert.equal(off.value, 0, off.stdout.join('\n') + off.stderr.join('\n'));
    assert.deepEqual(lastJson(off.stdout).args, { cmd: 'pwd' });
    assert.deepEqual(asked, []);
    assert.deepEqual(recorded, []);
    const runnersBefore = calls.runners.length;
    const inline = await call('api', '--record-video=full-run');
    assert.equal(inline.value, 2);
    assert.deepEqual(lastJson(inline.stdout).error, unsupported);
    assert.equal(calls.runners.length, runnersBefore);
    assert.deepEqual(asked, []);
    assert.deepEqual(recorded, []);
    const supported = await call('web', '--record-video');
    assert.equal(supported.value, 0, supported.stdout.join('\n') + supported.stderr.join('\n'));
    assert.deepEqual(asked, ['web']);
    assert.deepEqual(recorded, ['web']);
  });
});

describe('refusal and failure envelopes', () => {
  function lockCheckout(prefix: string): string {
    const target = tempRoot(prefix);
    fs.mkdirSync(path.dirname(recipeRuntimePath(target, 'recipe.lock')), { recursive: true });
    fs.writeFileSync(recipeRuntimePath(target, 'recipe.lock'), '');
    return target;
  }
  const running = (targetArg: string) =>
    `inspect the checkout state with: shop-harness status --target ${targetArg} --json; retry after the active recipe finishes`;

  test('a running recipe refuses run and call with the shell-quoted target, prepareHeal with the plain one', async () => {
    const spaced = lockCheckout('recipe cli refusal-');
    const run = await capture(() =>
      handleRun(['hello', '--adapter', 'api', '--target', spaced, '--json'], runOptions),
    );
    assert.equal(run.value, 4);
    assert.deepEqual(lastJson(run.stdout).error, {
      code: 'RECIPE_RUNNING',
      message: 'a recipe is currently running — refusing to start while another recipe executes.',
      userAction: running(`'${spaced}'`),
    });
    const call = await capture(() =>
      handleCall(['ping', '--adapter', 'web', '--target', spaced, '--json'], callOptions),
    );
    assert.equal(call.value, 4);
    assert.equal(
      (lastJson(call.stdout).error as { userAction: string }).userAction,
      running(`'${spaced}'`),
    );

    const plain = lockCheckout('recipe-cli-refusal-');
    const runPlain = await capture(() =>
      handleRun(['hello', '--adapter', 'api', '--target', plain, '--json'], runOptions),
    );
    assert.equal(
      (lastJson(runPlain.stdout).error as { userAction: string }).userAction,
      running(`'${plain}'`),
    );
    const heal = await capture(() => prepareHeal('api', plain, {}, true));
    assert.equal(heal.value, 4);
    assert.equal(
      (lastJson(heal.stdout).error as { userAction: string }).userAction,
      running(plain),
    );
  });

  test('a trust failure prints at most ten restricted nodes and the next step', async () => {
    const blocked = Array.from({ length: 11 }, (_, index) => ({
      nodeId: `n${index}`,
      action: 'shop.ping',
      capabilities: ['host-read-export'],
      source: 'team',
      ...(index === 0 ? { implementation: { kind: 'live-adapter', digest: 'sha256:abc' } } : {}),
    }));
    const failure = {
      code: 'RECIPE_APPROVAL_REQUIRED',
      message: 'Approval required.',
      userAction: 'review the plan',
      details: { blocked },
    };
    const human = await capture(async () => reportTrustFailure('call', failure, false));
    assert.deepEqual(human.stderr, [
      '✗ shop-harness call: Approval required.',
      '  Restricted plan nodes:',
      '  - n0: shop.ping [host-read-export] source=team implementation=live-adapter@sha256:abc',
      ...blocked
        .slice(1, 10)
        .map((node) => `  - ${node.nodeId}: shop.ping [host-read-export] source=team`),
      '  - … 1 more (use --json)',
      '  Next: review the plan',
    ]);
    const json = await capture(async () => reportTrustFailure('run', failure, true));
    assert.deepEqual(Object.keys(lastJson(json.stdout)), [
      'schemaVersion',
      'command',
      'status',
      'error',
      'exitCode',
    ]);
    assert.equal(lastJson(json.stdout).command, 'run');
  });

  test('a provenance failure reports the drift record in a fixed key order', () => {
    const drift = [
      { phase: 'end' as const, field: 'product.sourceFingerprint', start: 'a', current: 'b' },
    ];
    const failure = provenanceFailure(new ProvenanceDriftError('/tmp/provenance.json', drift));
    assert.deepEqual(Object.keys(failure), [
      'code',
      'message',
      'userAction',
      'provenancePath',
      'drift',
    ]);
    assert.equal(failure.provenancePath, '/tmp/provenance.json');
    assert.deepEqual(failure.drift, drift);
  });
});

describe('call', () => {
  test('runs one action and reports its output with redacted inputs', async () => {
    const target = checkout();
    const artifacts = tempRoot('recipe-cli-call-artifacts-');
    const call = await capture(() =>
      handleCall(
        // --slot takes a value, so `lane=7` is not an action input.
        [
          'ping',
          'mode=fast',
          'password=hunter2',
          '--slot',
          'lane=7',
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

  // The HUD follows the policy like run: unset (the engine default, on), show, hide.
  for (const [label, hud, expected] of [
    ['leaves the HUD to the engine default (on) without --hud', [], undefined],
    ['honours --hud show', ['--hud', 'show'], true],
    ['honours --hud hide', ['--hud', 'hide'], false],
  ] as const) {
    test(`follows the HUD policy like run: ${label}`, async () => {
      const target = checkout();
      calls.autoHud = [];
      const call = await capture(() =>
        handleCall(
          [
            'shop.ping',
            'mode=fast',
            '--adapter',
            'web',
            '--target',
            target,
            '--heal',
            'off',
            '--json',
            ...hud,
          ],
          callOptions,
        ),
      );
      assert.equal(call.value, 0, call.stderr.join('\n'));
      assert.deepEqual([...new Set(calls.autoHud)], [expected]);
    });
  }

  test('a call to app.hud drives the HUD itself: no automatic updates redraw what it clears', async () => {
    const target = checkout();
    const manifestPath = path.join(target, 'hud.action-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        ...CORE_ACTIONS,
        actions: {
          ...CORE_ACTIONS.actions,
          'shop.ping': PING_ACTION,
          'app.hud': {
            description: 'Show or clear the recipe HUD.',
            execution_capabilities: ['host-read-export'],
            examples: [{ action: 'app.hud', clear: true, intent: 'Clear the HUD.', next: 'done' }],
            schema: {
              type: 'object',
              properties: { clear: { type: 'boolean' } },
              additionalProperties: false,
            },
          },
        },
      }),
    );
    calls.autoHud = [];
    const call = await capture(() =>
      handleCall(
        [
          'app.hud',
          'clear=true',
          '--adapter',
          'web',
          '--target',
          target,
          '--heal',
          'off',
          '--action-manifest',
          manifestPath,
          '--json',
        ],
        callOptions,
      ),
    );
    assert.equal(call.value, 0, call.stderr.join('\n'));
    assert.deepEqual([...new Set(calls.autoHud)], [false]);
  });

  test('never loads a trusted mutation from its command line: funded mutations run through run', async () => {
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
    assert.equal(calls.runners.length, 2);
    assert.ok(calls.runners.every((runner) => runner.trustedMutation === undefined));
    assert.deepEqual(calls.mutationHooks, ['load:web', 'load:web']);
  });

  test("writes under the task's artifacts like run, each call in its own directory", async () => {
    const target = checkout();
    const args = [
      'shop.ping',
      'mode=fast',
      '--adapter',
      'web',
      '--target',
      target,
      '--heal',
      'off',
      '--json',
    ];
    process.env.RECIPE_TASK_DIR = 'temp/tasks/t1';
    const first = await capture(() => handleCall(args, callOptions));
    assert.equal(first.value, 0, first.stderr.join('\n'));
    const second = await capture(() => handleCall(args, callOptions));
    const calls = path.join(target, 'temp/tasks/t1/artifacts/calls');
    const dirs = [first, second].map((call) =>
      path.dirname(String(lastJson(call.stdout).summaryPath)),
    );
    for (const dir of dirs) assert.equal(path.dirname(dir), calls);
    assert.notEqual(dirs[0], dirs[1]);
    // A later run in the same task writes its own artifacts beside the calls'.
    const recipe = recipeFile(target, {
      ping: { action: 'shop.ping', mode: 'fast', intent: 'Ping the shop.', next: 'done' },
      done: { action: 'end', status: 'pass' },
    });
    const run = await capture(() =>
      handleRun(
        [recipe, '--adapter', 'web', '--target', target, '--heal', 'off', '--json'],
        runOptions,
      ),
    );
    assert.equal(run.value, 0, run.stderr.join('\n'));
    assert.equal(
      path.dirname(String((lastJson(run.stdout).result as { summaryPath: string }).summaryPath)),
      path.join(target, 'temp/tasks/t1/artifacts'),
    );
    for (const dir of dirs) assert.ok(fs.existsSync(path.join(dir, 'summary.json')), dir);

    delete process.env.RECIPE_TASK_DIR;
    process.env.FARMSLOT_TASK_DIR = '../outside';
    const outside = await capture(() => handleCall(args, callOptions));
    assert.equal(outside.value, 2);
    assert.deepEqual(lastJson(outside.stdout).error, {
      code: 'USAGE',
      message: 'task directory must be inside the target checkout: ../outside',
      userAction:
        'set RECIPE_TASK_DIR/FARMSLOT_TASK_DIR inside the checkout or pass --artifacts-dir <path>',
    });
    const explicit = tempRoot('recipe-cli-call-explicit-');
    const pinned = await capture(() =>
      handleCall([...args, '--artifacts-dir', explicit], callOptions),
    );
    assert.equal(path.dirname(String(lastJson(pinned.stdout).summaryPath)), explicit);
  });

  test('an inline --flag=value is an option, never an input', async () => {
    const target = checkout();
    const artifacts = tempRoot('recipe-cli-call-inline-');
    const call = await capture(() =>
      handleCall(
        [
          'shop.ping',
          'mode=fast',
          `--artifacts-dir=${artifacts}`,
          '--adapter=web',
          `--target=${target}`,
          '--heal=off',
          '--json',
        ],
        callOptions,
      ),
    );
    assert.equal(call.value, 0, `${call.stdout.join('\n')}\n${call.stderr.join('\n')}`);
    const envelope = lastJson(call.stdout);
    assert.deepEqual(envelope.args, { mode: 'fast' });
    assert.equal(path.dirname(String(envelope.summaryPath)), artifacts);
  });

  test('refuses the removed --arg instead of reading the next token as its value', async () => {
    const target = checkout();
    const refused = {
      name: 'CliError',
      exitCode: 2,
      message: '--arg was removed; pass the input as key=value',
    };
    // `--arg` used to swallow the token after it: here `--adapter`, silently
    // dropping the adapter the operator chose.
    for (const argv of [
      ['shop.ping', '--arg', 'mode=fast', '--adapter', 'web', '--target', target, '--json'],
      ['shop.ping', '--arg=mode=fast', '--adapter', 'web', '--target', target, '--json'],
      ['shop.ping', 'mode=fast', '--adapter', 'web', '--target', target, '--arg'],
    ]) {
      await assert.rejects(
        capture(() => handleCall(argv, callOptions)),
        refused,
        argv.join(' '),
      );
    }
    // `call <action> --help` parses the same inputs, so `--arg` is refused there too.
    await assert.rejects(
      capture(() =>
        handleCallHelp(
          ['ping', '--arg', 'mode=fast', '--help', '--adapter', 'web', '--target', target],
          'GENERIC',
          { catalog: engine },
        ),
      ),
      refused,
    );
    assert.deepEqual(calls.runners, []);
  });

  test('takes every input as key=value, values that look like flags included', async () => {
    const target = checkout();
    const call = await capture(() =>
      handleCall(
        [
          'command',
          'cmd=echo --not-a-flag -1',
          '--adapter',
          'api',
          '--target',
          target,
          '--heal',
          'off',
          '--json',
        ],
        callOptions,
      ),
    );
    assert.equal(call.value, 0, call.stderr.join('\n'));
    assert.deepEqual(lastJson(call.stdout).args, { cmd: 'echo --not-a-flag -1' });
    const dashed = await capture(() =>
      handleCall(
        [
          'command',
          'cmd=--version',
          '--adapter',
          'api',
          '--target',
          target,
          '--heal',
          'off',
          '--json',
        ],
        callOptions,
      ),
    );
    // The value reaches the action verbatim (the shell then rejects it as an option).
    const failure = lastJson(dashed.stdout).error as { originalError: string };
    assert.match(failure.originalError, /^Command exited with \d+: --version\n/u);
  });

  test('binds a mutation that load returns for the adapter alone, as a fixture policy does', async () => {
    const target = checkout();
    const base = engine.trustedMutation!;
    const byAdapter = {
      ...callOptions,
      engine: {
        ...engine,
        trustedMutation: {
          load: async (input: Parameters<typeof base.load>[0]) => {
            calls.mutationHooks.push(`load:${input.adapter}`);
            return input.adapter === 'web' ? { bound: 'policy' } : undefined;
          },
          authorize: base.authorize,
        },
      },
    };
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
          '--json',
        ],
        byAdapter,
      ),
    );
    assert.equal(call.value, 0, call.stderr.join('\n'));
    assert.deepEqual([...new Set(calls.mutationHooks)], ['load:web', 'authorize:web']);
    assert.ok(
      calls.runners.some((runner) =>
        /^policy@sha256:[0-9a-f]{8}$/u.test(String(runner.trustedMutation)),
      ),
    );
  });

  describe('passes the adapter the command resolved to the trusted mutation hooks', () => {
    // Each command shape is its own test, so each stays inside the test-speed budget.
    function fixture() {
      const registry = createAdapterRegistry();
      registry.register({ ...webAdapter(calls), targets: ['storefront'] });
      registry.register(shopAdapter('api', calls));
      configureHarnessAdapters(registry);
      const target = checkout();
      fs.writeFileSync(path.join(target, 'shop.json'), '{}');
      const funded = ['--target', target, '--heal', 'off', '--funding-token', 'grant', '--json'];
      const ping = recipeFile(target, {
        ping: { action: 'shop.ping', mode: 'fast', intent: 'Ping the shop.', next: 'done' },
        done: { action: 'end', status: 'pass' },
      });
      const echo = recipeFile(tempRoot('recipe-cli-api-recipe-'), {
        echo: { action: 'command', cmd: 'pwd', intent: 'Print the checkout.', next: 'done' },
        done: { action: 'end', status: 'pass' },
      });
      return { funded, ping, echo };
    }
    type Fixture = ReturnType<typeof fixture>;
    const cases: Record<string, [string, (f: Fixture) => Promise<number>]> = {
      'call --adapter web': [
        'web',
        ({ funded }) =>
          handleCall(['shop.ping', 'mode=slow', '--adapter', 'web', ...funded], callOptions),
      ],
      'call, detected': [
        'web',
        ({ funded }) =>
          withResolvedContext(funded, () =>
            handleCall(['shop.ping', 'mode=slow', ...funded], callOptions),
          ),
      ],
      'call --platform storefront': [
        'web',
        ({ funded }) =>
          handleCall(
            ['shop.ping', 'mode=slow', '--platform', 'storefront', ...funded],
            callOptions,
          ),
      ],
      'call --adapter api': [
        'api',
        ({ funded }) =>
          handleCall(['command', 'cmd=pwd', '--adapter', 'api', ...funded], callOptions),
      ],
      'run, detected': [
        'web',
        ({ funded, ping }) =>
          withResolvedContext(funded, () => handleRun([ping, ...funded], runOptions)),
      ],
      'run --platform storefront': [
        'web',
        ({ funded, ping }) => handleRun([ping, '--platform', 'storefront', ...funded], runOptions),
      ],
      'run --adapter api': [
        'api',
        ({ funded, echo }) => handleRun([echo, '--adapter', 'api', ...funded], runOptions),
      ],
    };
    for (const [name, [adapter, invoke]] of Object.entries(cases)) {
      test(name, async () => {
        const setup = fixture();
        calls.mutationHooks.length = 0;
        const result = await capture(() => invoke(setup));
        assert.equal(result.value, 0, `${result.stderr.join('\n')}${result.stdout.join('\n')}`);
        // A call's load gets no command line, so it loads nothing to authorize.
        assert.deepEqual(
          [...new Set(calls.mutationHooks)],
          name.startsWith('call')
            ? [`load:${adapter}`]
            : [`load:${adapter}`, `authorize:${adapter}`],
        );
      });
    }
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

  test('resolves names against --action-manifest and the --library sources', async () => {
    const target = checkout();
    const override = path.join(tempRoot('recipe-cli-override-'), 'api.action-manifest.json');
    fs.writeFileSync(override, JSON.stringify(manifestFor('api')));
    const overridden = await capture(() =>
      handleCall(
        ['ping', '--adapter', 'web', '--target', target, '--action-manifest', override, '--json'],
        callOptions,
      ),
    );
    assert.equal(overridden.value, 2);
    assert.equal((lastJson(overridden.stdout).error as { code: string }).code, 'ACTION_UNKNOWN');

    const team = tempRoot('recipe-cli-team-');
    fs.mkdirSync(path.join(team, 'recipes'));
    const library = await capture(() =>
      handleCall(
        [
          'wave',
          'bogus=1',
          '--adapter',
          'api',
          '--target',
          target,
          '--library',
          `team=${team}`,
          '--json',
        ],
        callOptions,
      ),
    );
    assert.equal(library.value, 5);
    assert.equal(lastJson(library.stdout).resolvedAction, 'team.wave');
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
      const fallback = await capture(() =>
        withResolvedContext([], () => handleCall([], callOptions)),
      );
      assert.equal(fallback.value, 2);
      assert.match(
        fallback.stderr.join('\n'),
        /Example: shop-harness call command --adapter web\n {2}See the vocabulary: shop-harness actions --adapter web/u,
      );
      const preferred = await capture(() =>
        withResolvedContext([], () =>
          handleCall([], {
            ...callOptions,
            exampleAction: (names) => names.find((name) => name.startsWith('shop.')),
          }),
        ),
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
    const list = await capture(() =>
      handleCall(['--list', '--adapter', 'web', '--json'], callOptions),
    );
    assert.equal(list.value, 0);
    assert.deepEqual(
      (lastJson(list.stdout).actions as Array<{ name: string; short: string | null }>).map(
        (entry) => [entry.name, entry.short],
      ),
      [
        ['assert_output', 'assert_output'],
        ['command', 'command'],
        ['end', 'end'],
        ['shop.ping', 'ping'],
        ['switch', 'switch'],
      ],
    );
    const human = await capture(() => handleCall(['--list', '--adapter', 'web'], callOptions));
    assert.match(
      human.stdout.join('\n'),
      /invocable actions \(web\)[\s\S]*Use: shop-harness call <name>[\s\S]*ping \(shop\.ping\) \[shop\]/u,
    );
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

describe('the resolved context in discovery envelopes', () => {
  test('actions, run --list, call --list and run --describe carry it', async () => {
    const context = {
      adapter: {
        value: 'api',
        source: 'detect' as const,
        detail: 'files',
        matched: ['files' as const],
      },
      target: { value: process.cwd(), source: 'default' as const, detail: 'cwd' as const },
    };
    setHarnessContext(context);
    const branches = {
      'actions --categories': () =>
        handleActions(parseArgs(['--categories', '--adapter', 'web', '--json']), {
          catalog: engine,
        }),
      actions: () => handleActions(parseArgs(['--adapter', 'web', '--json']), { catalog: engine }),
      'actions --matrix': () =>
        handleActions(parseArgs(['--matrix', '--json']), { catalog: engine }),
      'actions --matrix refusal': () =>
        handleActions(parseArgs(['--matrix', '--categories', '--json']), { catalog: engine }),
      'run --list': () => handleRun(['--list', '--adapter', 'api', '--json'], runOptions),
      'run --describe': () =>
        handleRun(['hello', '--describe', '--adapter', 'api', '--json'], runOptions),
      'run --describe, missing': () =>
        handleRun(['nope', '--describe', '--adapter', 'api', '--json'], runOptions),
      'call --list': () => handleCall(['--list', '--adapter', 'web', '--json'], callOptions),
    };
    for (const [name, invoke] of Object.entries(branches)) {
      const result = await capture(invoke);
      assert.deepEqual(lastJson(result.stdout).context, context, name);
    }
  });
});
