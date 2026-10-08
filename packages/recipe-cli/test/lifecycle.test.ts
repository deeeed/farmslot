import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  ADAPTER_SDK_VERSION,
  type AdapterLaunchContext,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';

import {
  adapterDetectNext,
  adapterForPlatform,
  assertAdapter,
  checkHealBounds,
  classifyFailure,
  configureHarnessAdapters,
  configureHarnessHost,
  detectAdapter,
  handleHarness,
  handleLast,
  handleLaunch,
  handleReload,
  handleStop,
  harnessHost,
  newHealState,
  parseArgs,
  parseFlags,
  parseHeal,
  recipeRunning,
  resolveAdapter,
  resolveFlagsAdapter,
  undetectedAdapterMessage,
  writeInteractiveProgress,
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

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-lifecycle-'));
  roots.push(root);
  return root;
}

// A minimal platform adapter; tests override what they exercise.
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
      stop: () => ({ kind: 'stopped', status: 0, summary: `stopped ${id} dev server` }),
    },
    logSources: () => [],
    appLogSource: () => null,
    hints: {
      launch: `launch ${id}`,
      relaunch: `relaunch ${id}`,
      runtimeProbeRecovery: () => 'recover',
    },
    actions: {
      manifestPath: () => `/manifests/${id}.json`,
      semantic: [],
      cdpTarget: { transport: 'none', probePath: '/json/version' },
    },
    harness: {
      install: { entry: 'install.mjs', fallback: 'install.mjs', node: true },
      cleanup: { entry: 'cleanup.mjs', fallback: 'cleanup.mjs', node: true },
      verify: () => ({ error: 'no verify\nNext: install first' }),
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

// Captures console.log/console.error for one call.
async function capture<T>(
  run: () => Promise<T> | T,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => out.push(args.join(' '));
  console.error = (...args: unknown[]) => err.push(args.join(' '));
  try {
    const result = await run();
    return { result, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const savedEnv = { ...process.env };
beforeEach(() => {
  configureHarnessHost(SHOP_HOST);
});
afterEach(() => {
  configureHarnessHost(DEFAULT_HOST);
  configureHarnessAdapters(createAdapterRegistry());
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

describe('adapter resolution', () => {
  test('a remote match beats a file match', () => {
    const checkout = tempRoot();
    fs.mkdirSync(path.join(checkout, 'web'));
    git(checkout, 'init', '-q');
    git(checkout, 'remote', 'add', 'origin', 'git@example.test:acme/shop-app.git');
    useAdapters(
      fakeAdapter('web', {
        detect: { files: (target) => fs.existsSync(path.join(target, 'web')) },
      }),
      fakeAdapter('app', { detect: { remote: (url) => url.includes('shop-app') } }),
    );
    assert.equal(detectAdapter(checkout), 'app');

    const plain = tempRoot();
    fs.mkdirSync(path.join(plain, 'web'));
    assert.equal(detectAdapter(plain), 'web');
    assert.equal(detectAdapter(tempRoot()), undefined);
  });

  test('within a pass, more than one match is ambiguous; an adapter beats one it extends', () => {
    const checkout = tempRoot();
    git(checkout, 'init', '-q');
    git(checkout, 'remote', 'add', 'origin', 'git@example.test:acme/shop.git');
    const any = { remote: () => true, files: () => true };
    useAdapters(fakeAdapter('first', { detect: any }), fakeAdapter('second', { detect: any }));
    assert.throws(
      () => detectAdapter(checkout),
      (error: Error & { code?: string; candidates?: unknown }) =>
        error.code === 'ADAPTER_AMBIGUOUS' &&
        JSON.stringify(error.candidates) ===
          JSON.stringify([
            { adapter: 'first', matched: ['remote', 'files'] },
            { adapter: 'second', matched: ['remote', 'files'] },
          ]),
    );

    const files = { files: () => true };
    useAdapters(
      fakeAdapter('first', { detect: files }),
      fakeAdapter('second', { extends: 'first', detect: files }),
    );
    assert.equal(detectAdapter(tempRoot()), 'second');
  });

  test('a platform target selects its adapter; the messages use the host and registry', () => {
    useAdapters(fakeAdapter('app', { targets: ['ios', 'android'] }), fakeAdapter('web'));
    assert.equal(adapterForPlatform('ios'), 'app');
    assert.equal(adapterForPlatform('web'), 'web');
    assert.equal(adapterForPlatform('desktop'), 'desktop');
    assert.equal(adapterForPlatform(undefined), undefined);
    assert.equal(resolveFlagsAdapter({ platform: 'android' }, tempRoot()), 'app');
    assert.equal(resolveFlagsAdapter({}, tempRoot(), 'web'), 'web');
    assert.equal(
      adapterDetectNext(),
      'cd into a Shop checkout or pass --target <path>, or force it with --adapter <app|web>',
    );
    assert.equal(undetectedAdapterMessage('/x'), 'could not detect the Shop repo type for /x');
    assert.throws(() => assertAdapter('desktop'), /Adapter must be app, or web\./u);
    const target = tempRoot();
    assert.throws(
      () => resolveAdapter(parseArgs(['--target', target]).options),
      (error: Error & { exitCode?: number }) =>
        error.exitCode === 2 && error.message.includes('could not detect the Shop repo type'),
    );
  });

  test('an empty registry is an internal error, not an unknown checkout', () => {
    assert.throws(() => assertAdapter('web'), /^Error: internal: no adapters are registered yet/u);
    assert.throws(
      () => detectAdapter(tempRoot()),
      /^Error: internal: no adapters are registered yet/u,
    );
    assert.throws(
      () => classifyFailure('ECONNREFUSED'),
      /^Error: internal: no adapters are registered yet/u,
    );
  });
});

describe('argument parsing', () => {
  test('adapters add boolean flags; --record is a flag only where the caller says so', () => {
    useAdapters(fakeAdapter('web', { flags: { commands: ['warmCache'], launch: ['headless'] } }));
    const parsed = parseArgs(['--warm-cache', 'recipe.json', '--record']);
    assert.deepEqual(parsed.positional, ['recipe.json']);
    assert.equal(parsed.options.warmCache, true);
    assert.equal(parsed.options.recordVideo, 'full-run');
    assert.equal(parseArgs(['--record'], { recordIsFlag: true }).options.record, true);
    // A launch-only flag still takes a value elsewhere.
    assert.equal(parseArgs(['--headless', 'no']).options.headless, 'no');
    assert.deepEqual(parseFlags(['--x', '--y=1'], new Set(['x'])).options, { x: true, y: '1' });
  });
});

describe('interactive progress', () => {
  test('writes only to an interactive terminal, never in JSON or piped mode', () => {
    let output = '';
    const stream = {
      write: (chunk: string) => {
        output += chunk;
        return true;
      },
    };
    assert.equal(writeInteractiveProgress(false, 'working', { stdoutIsTTY: true, stream }), true);
    assert.equal(output, 'working\n');
    output = '';
    assert.equal(writeInteractiveProgress(true, 'noise', { stdoutIsTTY: true, stream }), false);
    assert.equal(writeInteractiveProgress(false, 'noise', { stdoutIsTTY: false, stream }), false);
    assert.equal(output, '');
  });
});

describe('bounded healing', () => {
  test('classifies with every registered adapter’s patterns, in class order', () => {
    useAdapters(
      fakeAdapter('app', {
        failurePatterns: {
          captureProtected: {
            pattern: /SECURE_WINDOW/u,
            message: 'the window blocks capture.',
            userAction: 'open another screen',
          },
          environment: {
            pattern: /MISSING_BUILD/gu,
            message: 'a workspace package has no build output.',
            userAction: 'build the workspace',
          },
          transportFirst: /bridge timed out/u,
          walletState: /seed phrase/u,
        },
      }),
      fakeAdapter('web', { failurePatterns: { transport: /ECONNREFUSED|seed phrase server/u } }),
    );
    assert.equal(classifyFailure('SECURE_WINDOW'), 'capture-protected');
    assert.equal(classifyFailure('MISSING_BUILD while reading the seed phrase'), 'environment');
    assert.equal(classifyFailure('SECURE_WINDOW and MISSING_BUILD'), 'capture-protected');
    assert.equal(classifyFailure('bridge timed out: MISSING_BUILD'), 'environment');
    assert.equal(classifyFailure('bridge timed out while reading the seed phrase'), 'infra');
    assert.equal(classifyFailure('seed phrase server missing'), 'wallet');
    assert.equal(classifyFailure('ECONNREFUSED'), 'infra');
    assert.equal(classifyFailure('expected 10, got 7'), 'app');

    const target = tempRoot();
    assert.deepEqual(checkHealBounds(target, 'SECURE_WINDOW', newHealState()), {
      code: 'SCREENSHOT_PROTECTED',
      exitCode: 1,
      message: 'the window blocks capture.',
      userAction: 'open another screen',
      originalError: 'SECURE_WINDOW',
    });
    // A global pattern is tested again for the violation; it must still match.
    for (let i = 0; i < 2; i += 1)
      assert.equal(
        checkHealBounds(target, 'MISSING_BUILD', newHealState())?.code,
        'ENVIRONMENT_NOT_READY',
      );
    assert.deepEqual(checkHealBounds(target, 'MISSING_BUILD', newHealState()), {
      code: 'ENVIRONMENT_NOT_READY',
      exitCode: 4,
      message: 'a workspace package has no build output.',
      userAction: 'build the workspace',
      originalError: 'MISSING_BUILD',
    });
    assert.equal(
      checkHealBounds(target, 'seed phrase missing', newHealState())?.userAction,
      'run shop-harness doctor --json',
    );
    const state = newHealState();
    assert.equal(checkHealBounds(target, 'ECONNREFUSED', state), null);
    state.attemptedRecoveries.push('launch');
    assert.equal(checkHealBounds(target, 'ECONNREFUSED', state)?.code, 'SAME_RECOVERY_TWICE');
  });

  test('refuses recovery while a recipe runs, by the host env or the lock', () => {
    const target = tempRoot();
    assert.equal(recipeRunning(target), false);
    process.env.SHOP_HARNESS_RECIPE_RUNNING = '1';
    assert.equal(recipeRunning(target), true);
    delete process.env.SHOP_HARNESS_RECIPE_RUNNING;
    fs.mkdirSync(path.join(target, 'temp/recipe/runtime'), { recursive: true });
    fs.writeFileSync(path.join(target, 'temp/recipe/runtime/recipe.lock'), 'locked');
    assert.equal(recipeRunning(target), true);
    assert.deepEqual(parseHeal({ heal: 'forever' }, 'off'), {
      error: '--heal must be off, infra-only, or auto (got "forever").',
    });
  });
});

describe('launch', () => {
  test('a positional platform target selects the adapter and reaches its launch', async () => {
    const calls: AdapterLaunchContext[] = [];
    useAdapters(
      fakeAdapter('web'),
      fakeAdapter('app', {
        targets: ['ios', 'android'],
        flags: { launch: ['build'] },
        launch: (context) => {
          calls.push(context);
          context.stream.phase('app-started');
          return Promise.resolve(0);
        },
      }),
    );
    const target = tempRoot();
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) =>
      lines.push(chunk) > 0) as typeof process.stdout.write;
    let code: number;
    try {
      code = await handleLaunch(['ios', '--build', '--target', target, '--json-stream']);
    } finally {
      process.stdout.write = write;
    }
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.adapter, 'app');
    assert.equal(calls[0]?.platformTarget, 'ios');
    assert.equal(calls[0]?.options.build, true);
    assert.equal(calls[0]?.heal, 'auto');
    const events = lines
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      events.map((event) => event.phase ?? event.event),
      // The launch stage opens after resolve and ends with the command.
      ['resolve', 'stage', 'app-started', 'stage', 'complete'],
    );
    assert.equal(events[0]?.platform, 'ios');
    // The checkout lock is released afterwards.
    assert.equal(fs.existsSync(path.join(target, 'temp/recipe/runtime/sandbox.lock')), false);
  });

  test('platform stages print on stderr while the --json document stays as it was', async () => {
    const document = { schemaVersion: 1, command: 'launch', status: 'pass' };
    useAdapters(
      fakeAdapter('app', {
        launch: (context) => {
          const metro = context.stream.stage('metro', { index: 1, total: 2 });
          metro.progress({
            message: 'bundling',
            percent: 61,
            current: 4210,
            total: 6900,
            unit: 'modules',
          });
          metro.done();
          // Left running: it ends with the command.
          context.stream.stage('wallet', { index: 2, total: 2 });
          console.log(JSON.stringify(document));
          return Promise.resolve(0);
        },
      }),
    );
    const target = tempRoot();
    const chunks: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) =>
      chunks.push(String(chunk)) > 0) as typeof process.stderr.write;
    let captured: { result: number; stdout: string; stderr: string };
    try {
      captured = await capture(() =>
        handleLaunch(['--adapter', 'app', '--target', target, '--json']),
      );
    } finally {
      process.stderr.write = write;
    }
    assert.equal(captured.result, 0);
    assert.equal(captured.stdout, JSON.stringify(document));
    assert.deepEqual(chunks.join('').split('\n').filter(Boolean), [
      '[1/1] launch: started, 0s',
      '[1/2] metro: started, 0s',
      '[1/2] metro: bundling 61% (4,210/6,900 modules), 0s',
      '[1/2] metro: done, 0s',
      '[2/2] wallet: started, 0s',
      '[2/2] wallet: done, 0s',
      '[1/1] launch: done, 0s',
    ]);
  });

  test('teaches when no adapter matches the checkout', async () => {
    useAdapters(fakeAdapter('web'));
    const target = tempRoot();
    const { result, stdout } = await capture(() => handleLaunch(['--target', target, '--json']));
    assert.equal(result, 2);
    const envelope = JSON.parse(stdout) as { error: { message: string; userAction: string } };
    assert.equal(envelope.error.message, `could not detect the Shop repo type for ${target}`);
    assert.match(envelope.error.userAction, /--adapter <web>/u);
  });
});

describe('stop, reload and last', () => {
  test('stop reports the dev server and the host’s companions', async () => {
    const server = fakeAdapter('app').devServer;
    useAdapters(
      fakeAdapter('web'),
      fakeAdapter('app', { devServer: { ...server, portEnv: ['APP_PORT'] } }),
    );
    const target = tempRoot();
    const { result, stdout } = await capture(() =>
      handleStop(['--adapter', 'web', '--target', target, '--port', '9100', '--json'], {
        companions: async () => [{ label: 'collector', pid: 42 }],
      }),
    );
    assert.equal(result, 0);
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(envelope.status, 'pass');
    assert.equal(envelope.signalled, 1);
    // An explicit port reaches every registered dev server's port names.
    assert.equal(process.env.WATCHER_PORT, '9100');
    assert.equal(process.env.APP_PORT, '9100');

    const failing = fakeAdapter('app', {
      devServer: {
        label: 'app-server',
        describe: () => 'app server',
        stop: () => ({ kind: 'stopped', status: 1, summary: 'app server still running' }),
      },
    });
    useAdapters(failing);
    const failed = await capture(() =>
      handleStop(['--adapter', 'app', '--target', target, '--json'], {
        companions: async () => [{ label: 'collector', pid: 42 }],
      }),
    );
    const error = (JSON.parse(failed.stdout) as { error: { message: string; userAction: string } })
      .error;
    assert.equal(error.message, 'app server still running; stopped collector 42');
    assert.equal(error.userAction, `shop-harness status --target '${target}' --json`);
  });

  test('reload refuses a headless platform and one without reload', async () => {
    useAdapters(
      fakeAdapter('core', { headless: true }),
      fakeAdapter('web'),
      fakeAdapter('app', { reload: async () => 0 }),
    );
    const target = tempRoot();
    const headless = await capture(() => handleReload(['--adapter', 'core', '--target', target]));
    assert.equal(headless.result, 2);
    assert.match(
      headless.stderr,
      /shop-harness reload: core is headless[^]*Next: shop-harness run <core-recipe>/u,
    );
    const unsupported = await capture(() => handleReload(['--adapter', 'web', '--target', target]));
    assert.match(unsupported.stderr, /Next: launch web/u);
    assert.equal(await handleReload(['--adapter', 'app', '--target', target]), 0);
  });

  test('last explains a missing journal with the host name', async () => {
    const target = tempRoot();
    const { result, stderr } = await capture(() => handleLast(parseArgs(['--target', target])));
    assert.equal(result, 1);
    assert.match(
      stderr,
      /✗ shop-harness last: no resumability journal[^]*re-run shop-harness last --json/u,
    );
  });
});

describe('install, verify and cleanup', () => {
  function hostWithLeaves(): string {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, 'install.mjs'),
      "import fs from 'node:fs'; const i = process.argv.indexOf('--target'); fs.mkdirSync(process.argv[i + 1] + '/temp/recipe/harness/web', { recursive: true });",
    );
    configureHarnessHost({ ...SHOP_HOST, packageRoot: root });
    return root;
  }

  test('install runs the platform leaf from the host package and reports the envelope', async () => {
    hostWithLeaves();
    useAdapters(fakeAdapter('web'));
    const target = tempRoot();
    const { result, stdout } = await capture(() =>
      handleHarness(['install', '--adapter', 'web', '--target', target, '--json']),
    );
    assert.equal(result, 0);
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(envelope.status, 'pass');
    assert.equal(envelope.next, `shop-harness verify --adapter web --target ${target}`);
    assert.ok(fs.existsSync(path.join(target, 'temp/recipe/harness/web')));
  });

  test('an install variant the host handles skips the leaf', async () => {
    hostWithLeaves();
    useAdapters(fakeAdapter('web'));
    const target = tempRoot();
    const seen: string[][] = [];
    const code = await handleHarness(
      ['install', '--adapter', 'web', '--target', target, '--cloud'],
      {
        install: ({ forward }) => {
          if (!forward.includes('--cloud')) return undefined;
          seen.push(forward);
          return Promise.resolve(7);
        },
      },
    );
    assert.equal(code, 7);
    assert.deepEqual(seen, [['--target', target, '--cloud']]);
    assert.equal(fs.existsSync(path.join(target, 'temp/recipe/harness/web')), false);
  });

  test('verify reports a platform dispatch error with its Next step', async () => {
    useAdapters(fakeAdapter('web'));
    const target = tempRoot();
    const { result, stdout } = await capture(() =>
      handleHarness(['verify', '--adapter', 'web', '--target', target, '--json']),
    );
    assert.equal(result, 1);
    const envelope = JSON.parse(stdout) as { error: { code: string; userAction: string } };
    assert.equal(envelope.error.code, 'DISPATCH_UNAVAILABLE');
    assert.equal(envelope.error.userAction, 'install first');
  });

  test('the default help names the host, product and registered platforms', async () => {
    useAdapters(fakeAdapter('web'), fakeAdapter('app'));
    const { result, stderr } = await capture(() => handleHarness(['--help']));
    assert.equal(result, 0);
    assert.match(stderr, /^shop-harness — install and validate the Shop recipe runtime/u);
    assert.match(stderr, /--platform <web\|app>/u);
    const custom = await capture(() => handleHarness(['--help'], { usage: 'custom help' }));
    assert.equal(custom.stderr, 'custom help');
  });
});
