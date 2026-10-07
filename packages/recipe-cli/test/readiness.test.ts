import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  ADAPTER_SDK_VERSION,
  type AdapterDevices,
  type AdapterReadiness,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';

import {
  configureHarnessAdapters,
  configureHarnessHost,
  createDoctorReport,
  type DoctorCommandOptions,
  handleChecklist,
  handleDoctor,
  handlePrepare,
  handleRecipeQuality,
  handleStatus,
  handleTaskInit,
  harnessHost,
  parseArgs,
  requiredDoctorCheckSummary,
  runnerInstallKind,
  shellQuote,
} from '../src/harness/index.js';
import { RECIPE_CLI_VERSION } from '../src/index.js';

const DEFAULT_HOST = harnessHost();

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-readiness-'));
  roots.push(root);
  return root;
}

// A host package on disk: runner provenance reads its package.json.
function shopHost(): { packageRoot: string } {
  const packageRoot = tempRoot();
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@acme/shop-harness', version: '1.2.3' }),
  );
  configureHarnessHost({
    name: 'shop-harness',
    product: 'Shop',
    envPrefix: 'SHOP_HARNESS',
    recipeEnvPrefix: 'SHOP_RECIPE',
    packageName: '@acme/shop-harness',
    packageRoot,
    bin: 'bin/shop-harness',
  });
  return { packageRoot };
}

function fakeAdapter(id: string, extra: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id,
    sdkVersion: ADAPTER_SDK_VERSION,
    headless: false,
    resolveSlotPorts() {},
    runtimeStatus: async () => ({ decision: 'ready', reasons: ['all good'] }),
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
      runtimeProbeRecovery: () => `recover ${id}`,
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

// Stage lines go straight to stderr, not through console.error.
async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const chunks: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) =>
    chunks.push(String(chunk)) > 0) as typeof process.stderr.write;
  try {
    const result = await run();
    return { result, lines: chunks.join('').split('\n').filter(Boolean) };
  } finally {
    process.stderr.write = write;
  }
}

// --json-stream writes NDJSON straight to stdout; each line parsed.
async function captureStdout<T>(
  run: () => Promise<T>,
): Promise<{ result: T; events: Array<Record<string, unknown>> }> {
  const chunks: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) =>
    chunks.push(String(chunk)) > 0) as typeof process.stdout.write;
  try {
    const result = await run();
    const lines = chunks.join('').split('\n').filter(Boolean);
    return { result, events: lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
  } finally {
    process.stdout.write = write;
  }
}

// Devices with a counted live probe: doctor and status are held to one each.
function fakeDevices(probes: { count: number }): AdapterDevices {
  return {
    view: () => ({
      allConnectedDevices: [{ id: 'd1' }],
      devices: [{ id: 'd1', platform: 'phone', selected: true }],
      deviceDiscoveryErrors: [],
    }),
    live: async () => {
      probes.count += 1;
      return {
        devicesWithLive: [
          { id: 'd1', platform: 'phone', selected: true, liveState: 'unlocked' } as never,
        ],
        additionalReachableDevices: [],
        featureFlags: { beta: true },
        statusFields: { portHints: ['8081'] },
        liveMap: { d1: 'unlocked' },
      };
    },
    renderList: () => console.log('devices: 1 connected'),
    renderAdditional: () => {},
    renderLive: () => console.log('live: d1 unlocked'),
    renderHints: () => console.log('hint: port 8081'),
    nextForLive: (fallback) => `${fallback} (live)`,
  };
}

const manifestOk: DoctorCommandOptions['manifest'] = async () => ({ summary: { errors: 0 } });
const flagHost = {
  report: (overrides: unknown, detail?: { error?: string }) => ({
    summary: overrides
      ? `feature flags: ${Object.keys(overrides as object).length} override(s)`
      : 'feature flags: (no runtime)',
    overrideCount: overrides ? Object.keys(overrides as object).length : null,
    ...(detail?.error ? { error: detail.error } : {}),
  }),
};

const savedEnv = { ...process.env };
beforeEach(() => {
  delete process.env.SHOP_HARNESS_EXECUTABLE;
  process.env.CAPTURE_HELPER_PATH = '/nonexistent/capture-helper';
});
afterEach(() => {
  configureHarnessHost(DEFAULT_HOST);
  configureHarnessAdapters(createAdapterRegistry());
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the doctor report', () => {
  test('lists the manifest check, then the host checks, then the platform checks, and tallies the required ones', () => {
    shopHost();
    const readiness: AdapterReadiness = {
      checks: () => [{ id: 'shop-tool', status: 'fail', required: true, message: 'tool missing' }],
      environment: () => ({ tier: 'test' }),
    };
    useAdapters(fakeAdapter('shop', { readiness }));
    const report = createDoctorReport(
      'shop',
      '/checkout',
      { summary: { errors: 0 } },
      '/m.json',
      undefined,
      {
        checks: () => [
          { id: 'bridge', status: 'pass', required: false, message: 'bridge present' },
        ],
        fields: (_target, _adapter, environment) => ({ mode: 'bridged', environment, extra: 1 }),
        provenance: { name: '@acme/runner' },
      },
    );
    assert.deepEqual(
      report.checks.map((check) => check.id),
      ['manifest', 'bridge', 'shop-tool'],
    );
    assert.deepEqual(report.requiredChecks, {
      status: 'fail',
      total: 2,
      passed: 1,
      failed: ['shop-tool'],
    });
    assert.equal(report.status, 'fail');
    assert.deepEqual(Object.keys(report), [
      'schemaVersion',
      'protocolVersion',
      'runner_protocol_version',
      'status',
      'checks',
      'requiredChecks',
      'adapter',
      'target',
      'runner',
      'mode',
      'environment',
      'extra',
      'manifestValidation',
    ]);
    assert.deepEqual(report.environment, { tier: 'test' });
    assert.equal(report.runner.name, '@acme/runner');
    assert.equal(report.runner.packageName, '@acme/shop-harness');
    assert.equal(report.runner.version, '1.2.3');
    assert.equal(report.runner.harnessPackage, '@farmslot/recipe-runner');
    assert.equal(report.runner.recipeCliVersion, RECIPE_CLI_VERSION);
    assert.deepEqual(Object.keys(report.runner).slice(-2), ['harnessPackage', 'recipeCliVersion']);
  });

  test('refuses a host field that would replace a report or envelope key', () => {
    shopHost();
    useAdapters(fakeAdapter('shop'));
    const report = (fields: Record<string, unknown>) =>
      createDoctorReport('shop', '/checkout', { summary: { errors: 0 } }, '/m.json', undefined, {
        fields: () => fields,
      });
    for (const key of ['status', 'checks', 'runner', 'manifestValidation', 'ready', 'devices']) {
      assert.throws(
        () => report({ mode: 'bridged', [key]: 'host' }),
        new RegExp(`doctor report field '${key}' is reserved`, 'u'),
        key,
      );
    }
    assert.deepEqual(Object.keys(report({ mode: 'bridged' })).slice(-3), [
      'runner',
      'mode',
      'manifestValidation',
    ]);
  });

  test('refuses a host package that is not the configured one', () => {
    const { packageRoot } = shopHost();
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@acme/other', version: '1.0.0' }),
    );
    useAdapters(fakeAdapter('shop'));
    assert.throws(
      () => createDoctorReport('shop', '/checkout', { summary: { errors: 0 } }, '/m.json'),
      /Expected @acme\/shop-harness package name/u,
    );
  });

  test('reads an install as pinned, global, project or linked', () => {
    const sep = path.sep;
    assert.equal(
      runnerInstallKind('/pins/x', '/a', '/a', () => true),
      'pinned-install',
    );
    assert.equal(
      runnerInstallKind(`${sep}usr${sep}lib${sep}node_modules${sep}h`, '/a', '/a'),
      'global-install',
    );
    assert.equal(
      runnerInstallKind(
        `${sep}p${sep}node_modules${sep}h`,
        `${sep}p${sep}node_modules${sep}.bin${sep}h`,
        '/x',
      ),
      'project-install',
    );
    assert.equal(runnerInstallKind('/src/h', '/link/h', '/src/h/bin/h'), 'local-link');
    assert.equal(runnerInstallKind('/src/h', '/src/h/bin/h', '/src/h/bin/h'), 'source-checkout');
    assert.deepEqual(requiredDoctorCheckSummary([]), {
      status: 'pass',
      total: 0,
      passed: 0,
      failed: [],
    });
  });
});

describe('doctor', () => {
  function doctorTarget(): string {
    const target = tempRoot();
    process.env.RECIPE_RUNTIME_DIR = 'temp/recipe/runtime';
    return target;
  }

  test('prints one JSON envelope in the documented key order, with one device probe', async () => {
    shopHost();
    const probes = { count: 0 };
    useAdapters(
      fakeAdapter('shop', {
        readiness: {
          devices: async () => fakeDevices(probes),
          orphanDevServers: () => ['4242'],
          checks: () => [{ id: 'shop-static', status: 'pass', required: false, message: 'static' }],
          liveChecks: async () => [
            { id: 'shop-live', status: 'pass', required: false, message: 'live' },
          ],
        },
        doctor: async () => [
          { id: 'shop-doctor', status: 'pass', required: false, message: 'platform' },
        ],
      }),
    );
    const target = doctorTarget();
    const { result, stdout } = await capture(() =>
      handleDoctor(parseArgs(['--adapter', 'shop', '--target', target, '--json']), {
        manifest: manifestOk,
        checkoutView: () => ({ json: { bound: true }, text: 'checkout: bound' }),
        featureFlags: flagHost,
        advisory: () => [{ key: 'skills', value: { installed: [] }, render: () => {} }],
        orphanDevServers: { field: 'orphanServers', label: 'orphan server' },
      }),
    );
    assert.equal(result, 0);
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(envelope), [
      'schemaVersion',
      'protocolVersion',
      'runner_protocol_version',
      'status',
      'checks',
      'requiredChecks',
      'adapter',
      'target',
      'runner',
      'environment',
      'manifestValidation',
      'ready',
      'runtime',
      'view',
      'orphanServers',
      'capture',
      'skills',
      'featureFlags',
      'devices',
      'additionalReachableDevices',
    ]);
    assert.deepEqual(envelope.orphanServers, ['4242']);
    assert.equal(envelope.capture, null);
    assert.deepEqual((envelope.featureFlags as { overrideCount: number }).overrideCount, 1);
    assert.deepEqual(
      (envelope.checks as Array<{ id: string }>).map((check) => check.id),
      ['manifest', 'shop-static', 'runtime', 'shop-live', 'shop-doctor'],
    );
    assert.equal(probes.count, 1);
  });

  test('--print-ready prints only the platform indicator when live, and nothing when not', async () => {
    shopHost();
    useAdapters(
      fakeAdapter('shop', { readiness: { readyIndicator: () => 'ready' } }),
      fakeAdapter('plain'),
      fakeAdapter('down', {
        runtimeStatus: async () => ({
          decision: 'relaunch',
          reasons: ['dev server down'],
          nextAction: 'shop-harness launch',
        }),
      }),
    );
    const target = doctorTarget();
    const live = await capture(() =>
      handleDoctor(parseArgs(['--adapter', 'shop', '--target', target, '--print-ready']), {
        manifest: manifestOk,
      }),
    );
    assert.equal(live.result, 0);
    assert.equal(live.stdout, 'ready');

    const noIndicator = await capture(() =>
      handleDoctor(parseArgs(['--adapter', 'plain', '--target', target, '--print-ready']), {
        manifest: manifestOk,
      }),
    );
    assert.equal(noIndicator.result, 1);
    assert.equal(noIndicator.stdout, '');
    assert.match(noIndicator.stderr, /not-ready/u);

    const down = await capture(() =>
      handleDoctor(parseArgs(['--adapter', 'down', '--target', target, '--print-ready']), {
        manifest: manifestOk,
      }),
    );
    assert.equal(down.result, 1);
    assert.equal(down.stdout, '');
    assert.match(down.stderr, /not-live/u);
    assert.match(down.stderr, /Next: shop-harness launch/u);

    const both = await capture(() =>
      handleDoctor(
        parseArgs(['--adapter', 'shop', '--target', target, '--print-ready', '--json']),
        { manifest: manifestOk },
      ),
    );
    assert.equal(both.result, 2);
    assert.match(both.stdout, /--print-ready owns stdout/u);
  });

  test('--expect-live --json keeps the doctor envelope and carries the live answer in the exit code', async () => {
    shopHost();
    useAdapters(
      fakeAdapter('down', {
        runtimeStatus: async () => ({
          decision: 'relaunch',
          reasons: [],
          nextAction: 'relaunch it',
        }),
      }),
    );
    const target = doctorTarget();
    const { result, stdout } = await capture(() =>
      handleDoctor(
        parseArgs(['--adapter', 'down', '--target', target, '--expect-live', '--json']),
        {
          manifest: manifestOk,
          orphanDevServers: { field: 'orphanServers', label: 'orphan server' },
        },
      ),
    );
    assert.equal(result, 1);
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(envelope).slice(-8), [
      'manifestValidation',
      'ready',
      'runtime',
      'orphanServers',
      'capture',
      'devices',
      'additionalReachableDevices',
      'error',
    ]);
    assert.deepEqual(envelope.error, {
      code: 'RUNTIME_NOT_LIVE',
      message: 'down runtime is not live',
      userAction: 'relaunch it',
    });
  });

  test('names the host, its product and its executable in recovery text', async () => {
    shopHost();
    useAdapters(
      fakeAdapter('shop', {
        readiness: {
          checks: () => [
            { id: 'shop-tool', status: 'fail', required: true, message: 'tool missing' },
          ],
        },
      }),
    );
    const target = doctorTarget();
    const missing = await capture(() =>
      handleDoctor(
        parseArgs(['--adapter', 'shop', '--target', path.join(target, 'absent'), '--json']),
        { manifest: manifestOk },
      ),
    );
    assert.equal(missing.result, 2);
    assert.match(missing.stdout, /pass --target <shop-checkout> pointing to an existing checkout/u);

    const failing = await capture(() =>
      handleDoctor(parseArgs(['--adapter', 'shop', '--target', target, '--json']), {
        manifest: manifestOk,
      }),
    );
    assert.equal(failing.result, 1);
    const envelope = JSON.parse(failing.stdout) as { next: string; error: { userAction: string } };
    assert.equal(
      envelope.error.userAction,
      `shop-harness doctor --fix --adapter shop --target ${shellQuote(target)} --json`,
    );
    assert.equal(envelope.next, envelope.error.userAction);
  });

  test('--fix lists the host next steps first, then the shared ones, and lets the host word the error', async () => {
    shopHost();
    process.env.SHOP_HARNESS_EXECUTABLE = '/opt/bin/shop-harness';
    useAdapters(
      fakeAdapter('shop', {
        readiness: { runtimeBlock: () => ({ id: 'deps', userAction: 'install deps' }) },
      }),
    );
    const target = doctorTarget();
    const { stdout } = await capture(() =>
      handleDoctor(parseArgs(['--adapter', 'shop', '--target', target, '--fix', '--json']), {
        manifest: manifestOk,
        fix: {
          ensureRuntimeContext: () => {
            throw new Error('unwritable');
          },
          repair: () => ({ fixed: [], failed: ['wallet'] }),
          nextActions: (failed, { executable, scope }) =>
            failed.includes('wallet') ? [`${executable} wallet init ${scope}`] : [],
          userAction: (failed, retry) =>
            failed.includes('wallet') ? `set up a wallet, then ${retry}` : undefined,
        },
      }),
    );
    const envelope = JSON.parse(stdout) as {
      failed: string[];
      nextActions: string[];
      error: { userAction: string };
    };
    assert.ok(envelope.failed.includes('runtime-context'));
    assert.ok(envelope.failed.includes('wallet'));
    assert.ok(envelope.failed.includes('deps'));
    assert.equal(
      envelope.nextActions[0],
      `'/opt/bin/shop-harness' wallet init --adapter shop --target ${shellQuote(target)}`,
    );
    assert.match(
      envelope.nextActions[1] ?? '',
      /^inspect .*agentic-runtime\.json', then retry '\/opt\/bin\/shop-harness' doctor --fix /u,
    );
    assert.equal(envelope.nextActions.at(-1), 'install deps');
    assert.equal(
      envelope.error.userAction,
      `set up a wallet, then shop-harness doctor --fix --adapter shop --target ${shellQuote(target)} --json`,
    );
  });

  test('--fix shows one stage per fix on stderr and leaves the --json envelope as it was', async () => {
    shopHost();
    useAdapters(
      fakeAdapter('shop', {
        readiness: {
          fixes: [
            // A long fix can be async, so the heartbeat keeps ticking.
            { id: 'deps', apply: async () => true },
            {
              id: 'ports',
              apply: () => {
                throw new Error('port 8081 is taken');
              },
            },
          ],
        },
      }),
    );
    const target = doctorTarget();
    // An overlay installer that fails, so the overlay stage has one known outcome.
    process.env.SHOP_HARNESS_INSTALL_BIN = '/usr/bin/false';
    const { result, lines } = await captureStderr(() =>
      capture(() =>
        handleDoctor(parseArgs(['--adapter', 'shop', '--target', target, '--fix', '--json']), {
          manifest: manifestOk,
          fix: { repair: () => ({ fixed: ['wallet'], failed: [] }) },
        }),
      ),
    );
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal('stages' in envelope, false);
    assert.deepEqual(envelope.fixed, ['deps', 'wallet']);
    assert.deepEqual(
      lines.map((line) => line.replace(/, \d+s$/u, '')),
      [
        '[1/5] runtime-context: started',
        '[1/5] runtime-context: done',
        '[2/5] deps: started',
        '[2/5] deps: done, fixed',
        '[3/5] ports: started',
        '[3/5] ports: failed, port 8081 is taken',
        '[4/5] overlay: started',
        '[4/5] overlay: failed, runtime overlay install failed (exit 1)',
        '[5/5] host repair: started',
        '[5/5] host repair: done, fixed wallet',
      ],
    );
  });

  test('--fix --json-stream streams a stage event per fix, then what was fixed', async () => {
    shopHost();
    useAdapters(fakeAdapter('shop', { readiness: { fixes: [{ id: 'deps', apply: () => true }] } }));
    const target = doctorTarget();
    process.env.SHOP_HARNESS_INSTALL_BIN = '/usr/bin/true';
    const { result, events } = await captureStdout(() =>
      captureStderr(() =>
        capture(() =>
          handleDoctor(
            parseArgs(['--adapter', 'shop', '--target', target, '--fix', '--json-stream']),
            { manifest: manifestOk, fix: { repair: () => ({ fixed: ['wallet'], failed: [] }) } },
          ),
        ),
      ),
    );
    // The fake overlay installer leaves the overlay missing: one known failure.
    assert.equal(result.result.result, 1);
    assert.equal(result.result.stdout, '', 'stdout carries only the stream');
    assert.deepEqual(
      events.filter((event) => event.event === 'stage').map((event) => [event.stage, event.status]),
      [
        ['runtime-context', 'start'],
        ['runtime-context', 'done'],
        ['deps', 'start'],
        ['deps', 'done'],
        ['overlay', 'start'],
        ['overlay', 'failed'],
        ['host repair', 'start'],
        ['host repair', 'done'],
      ],
    );
    const complete = events.at(-1)!;
    assert.equal(complete.event, 'complete');
    assert.equal(complete.status, 'fail');
    assert.equal(complete.exitCode, 1);
    assert.deepEqual(complete.fixed, ['deps', 'wallet']);
    assert.deepEqual(complete.failed, ['overlay']);
    assert.equal((complete.error as { code: string }).code, 'DOCTOR_FIX_INCOMPLETE');
    assert.equal(events.filter((event) => event.event === 'complete').length, 1);
  });

  test('--fix --json-stream refusing a missing target sends the error, then complete', async () => {
    shopHost();
    useAdapters(fakeAdapter('shop'));
    const { result, events } = await captureStdout(() =>
      captureStderr(() =>
        handleDoctor(
          parseArgs([
            '--adapter',
            'shop',
            '--target',
            path.join(tempRoot(), 'missing'),
            '--fix',
            '--json-stream',
          ]),
          { manifest: manifestOk },
        ),
      ),
    );
    assert.equal(result.result, 2);
    assert.deepEqual(
      events.map((event) => event.event),
      ['error', 'complete'],
    );
    assert.match((events[0]!.error as { message: string }).message, /target does not exist/u);
  });

  test('--json-stream without --fix is a usage error that names --json', async () => {
    shopHost();
    useAdapters(fakeAdapter('shop'));
    const { result, events } = await captureStdout(() =>
      handleDoctor(parseArgs(['--adapter', 'shop', '--target', doctorTarget(), '--json-stream']), {
        manifest: manifestOk,
      }),
    );
    assert.equal(result, 2);
    assert.equal((events[0]!.error as { code: string }).code, 'CLI_USAGE_ERROR');
    assert.match((events[0]!.error as { message: string }).message, /doctor --json/u);
    assert.deepEqual(events.at(-1), {
      ...events.at(-1),
      event: 'complete',
      status: 'fail',
      exitCode: 2,
    });
  });

  test('--fix ends a stage left open when a fix throws', async () => {
    shopHost();
    useAdapters(fakeAdapter('shop', { readiness: { fixes: [] } }));
    const target = doctorTarget();
    process.env.SHOP_HARNESS_INSTALL_BIN = '/usr/bin/true';
    const { lines } = await captureStderr(() =>
      capture(() =>
        handleDoctor(parseArgs(['--adapter', 'shop', '--target', target, '--fix', '--json']), {
          manifest: manifestOk,
          fix: {
            repair: () => {
              throw new Error('wallet sync crashed');
            },
          },
        }),
      ).catch(() => undefined),
    );
    assert.equal(
      lines.at(-1)?.replace(/, \d+s$/u, ''),
      '[3/3] host repair: failed, doctor --fix stopped',
    );
  });
});

describe('status', () => {
  test('prints the live envelope with the view and the platform status fields, from one probe', async () => {
    shopHost();
    const probes = { count: 0 };
    useAdapters(
      fakeAdapter('shop', {
        detect: { files: () => true },
        readiness: { devices: async () => fakeDevices(probes) },
      }),
    );
    const target = tempRoot();
    const { stdout } = await capture(() =>
      handleStatus(parseArgs(['--target', target, '--json']), {
        checkoutView: () => ({ json: { bound: true }, text: '' }),
        featureFlags: flagHost,
      }),
    );
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(envelope), [
      'schemaVersion',
      'command',
      'adapter',
      'target',
      'view',
      'devices',
      'featureFlags',
      'portHints',
      'next',
    ]);
    assert.deepEqual(envelope.view, { bound: true });
    assert.equal(envelope.next, 'relaunch shop (live)');
    assert.equal(probes.count, 1);
  });

  test('--fast never probes, and the next step is the platform relaunch', async () => {
    shopHost();
    const probes = { count: 0 };
    const adapter = fakeAdapter('shop', {
      detect: { files: () => true },
      readiness: { devices: async () => fakeDevices(probes) },
    });
    useAdapters(adapter);
    const target = tempRoot();
    const { stdout } = await capture(() =>
      handleStatus(parseArgs(['--target', target, '--json', '--fast']), { featureFlags: flagHost }),
    );
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(envelope), [
      'schemaVersion',
      'command',
      'adapter',
      'target',
      'devices',
      'featureFlags',
      'next',
    ]);
    assert.equal(envelope.next, 'relaunch shop');
    assert.equal(probes.count, 0);

    const live = await capture(() =>
      handleStatus(parseArgs(['--target', target, '--json']), { featureFlags: flagHost }),
    );
    const liveEnvelope = JSON.parse(live.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(liveEnvelope), [
      'schemaVersion',
      'command',
      'adapter',
      'target',
      'devices',
      'featureFlags',
      'portHints',
      'next',
    ]);
    assert.equal(probes.count, 1);
  });

  test('a ready runtime points at the host logs; --task must be a directory', async () => {
    shopHost();
    useAdapters(
      fakeAdapter('shop', { detect: { files: () => true }, readiness: { statusRuntime: true } }),
    );
    const target = tempRoot();
    const { stdout } = await capture(() => handleStatus(parseArgs(['--target', target, '--json'])));
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(envelope), [
      'schemaVersion',
      'command',
      'adapter',
      'target',
      'devices',
      'runtime',
      'next',
    ]);
    assert.equal(envelope.next, 'shop-harness logs');

    const notDir = await capture(() =>
      handleStatus(parseArgs(['--target', target, '--task', path.join(target, 'nope'), '--json'])),
    );
    assert.equal(notDir.result, 2);
    assert.match(notDir.stdout, /--task is not a directory/u);
  });
});

describe('prepare', () => {
  // A host bin that answers every step from STEP_RESULTS (id → exit code) and
  // writes a status report with one device.
  function fakeBin(root: string): string {
    const bin = path.join(root, 'shop-harness');
    fs.writeFileSync(
      bin,
      [
        '#!/usr/bin/env node',
        'const [step] = process.argv.slice(2);',
        "const results = JSON.parse(process.env.STEP_RESULTS || '{}');",
        "if (step === 'launch' && process.env.STAGE_LINES) process.stderr.write('[2/5] metro: bundling 61% (4,210/6,900 modules), 1m42s\\n');",
        "if (step === 'doctor' && process.env.CR_PROGRESS) process.stderr.write('x\\r'.repeat(10000));",
        "if (step === 'doctor' && process.env.LONG_TAIL) process.stderr.write('boom: cause\\n' + 'y'.repeat(9000));",
        "if (step === 'status' && !results.status) console.log(JSON.stringify({ devices: [{ platform: process.env.DEVICE_PLATFORM || 'phone', selected: true }] }));",
        "else console.log(JSON.stringify({ step, args: process.argv.slice(3), ...(results[step] ? { error: { message: step + ' broke' } } : {}) }));",
        // exitCode, not exit(): stderr to a pipe drains first.
        'process.exitCode = results[step] ?? 0;',
      ].join('\n'),
    );
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  const fixtureStep = {
    id: 'seed',
    command: 'seed set',
    hint: 'under a minute',
    argv: ({
      device,
      forwarded,
      targetArgs,
    }: {
      device: readonly string[];
      forwarded: readonly string[];
      targetArgs: readonly string[];
    }) => [
      'seed',
      'set',
      ...device.flatMap((name) => ['--platform', name]),
      ...forwarded,
      '--json',
      ...targetArgs,
    ],
  };

  test('runs doctor, status, launch, the host steps and verify, and writes the readiness record', async () => {
    shopHost();
    const root = tempRoot();
    process.env.SHOP_HARNESS_EXECUTABLE = fakeBin(root);
    useAdapters(
      fakeAdapter('shop', {
        targets: ['phone', 'tablet'],
        readiness: {
          prepare: {
            devicePlatform: (_target, devices) =>
              devices.find((device) => device.selected)?.platform,
          },
        },
      }),
    );
    const target = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    const { result, stdout } = await capture(() =>
      handlePrepare(
        [
          '--platform',
          'shop',
          '--target',
          target,
          '--artifacts-dir',
          artifacts,
          '--remote-flag',
          'x=1',
          '--json',
        ],
        {
          usage: 'shop-harness prepare [--json]',
          steps: [fixtureStep],
          forward: { option: 'remoteFlag', flag: '--remote-flag' },
        },
      ),
    );
    assert.equal(result, 0);
    const record = JSON.parse(fs.readFileSync(path.join(artifacts, 'sandbox.json'), 'utf8')) as {
      harness: Record<string, string>;
      steps: Array<{ id: string; status: string; command: string; reportPath?: string }>;
      ready: boolean;
    };
    assert.deepEqual(JSON.parse(stdout), record);
    assert.deepEqual(Object.keys(record), [
      'schemaVersion',
      'harness',
      'platform',
      'steps',
      'ready',
      'recordedAt',
    ]);
    assert.deepEqual(Object.keys(record.harness), ['name', 'version', 'source', 'executable']);
    assert.equal(record.harness.name, '@acme/shop-harness');
    assert.deepEqual(
      record.steps.map((step) => [step.id, step.status]),
      [
        ['doctor', 'pass'],
        ['status', 'pass'],
        ['launch', 'pass'],
        ['seed', 'pass'],
        ['verify', 'pass'],
      ],
    );
    const bin = process.env.SHOP_HARNESS_EXECUTABLE;
    assert.equal(
      record.steps[2]?.command,
      `${bin} launch phone --remote-flag x=1 --verify --json --target ${target}`,
    );
    assert.equal(
      record.steps[3]?.command,
      `${bin} seed set --platform phone --remote-flag x=1 --json --target ${target}`,
    );
    assert.equal(record.steps[0]?.reportPath, path.join('prepare', 'doctor.json'));
    assert.equal(record.ready, true);
    assert.ok(!fs.existsSync(path.join(artifacts, 'prepare', 'progress.json')));
  });

  test('shows each step as a stage on stderr, nests the launch stages, and keeps stdout one document', async () => {
    shopHost();
    const root = tempRoot();
    process.env.SHOP_HARNESS_EXECUTABLE = fakeBin(root);
    process.env.STAGE_LINES = '1';
    useAdapters(
      fakeAdapter('shop', {
        readiness: { prepare: { devicePlatform: () => 'phone' } },
      }),
    );
    const target = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    const { result, lines } = await captureStderr(() =>
      capture(() =>
        handlePrepare(
          ['--platform', 'shop', '--target', target, '--artifacts-dir', artifacts, '--json'],
          { usage: 'u', steps: [fixtureStep] },
        ),
      ),
    );
    assert.equal(result.result, 0);
    assert.deepEqual(
      JSON.parse(result.stdout),
      JSON.parse(fs.readFileSync(path.join(artifacts, 'sandbox.json'), 'utf8')),
    );
    assert.deepEqual(
      lines.map((line) => line.replace(/, \d+s$/u, '')),
      [
        '[1/5] doctor --fix: started',
        '[1/5] doctor --fix: done',
        '[2/5] status: started',
        '[2/5] status: done',
        '[3/5] launch --verify: started',
        '[3/5] launch --verify › [2/5] metro: bundling 61% (4,210/6,900 modules), 1m42s',
        '[3/5] launch --verify: done',
        '[4/5] seed: started',
        '[4/5] seed: done',
        '[5/5] verify: started',
        '[5/5] verify: done',
      ],
    );
    // The gateway's [n/m] parser reads every one of them.
    for (const line of lines) assert.match(line, /\[(\d+)\/(\d+)\]\s*(.+)$/u);
  });

  test('records the device platform the host targets, as the protocol names it', async () => {
    shopHost();
    const root = tempRoot();
    process.env.SHOP_HARNESS_EXECUTABLE = fakeBin(root);
    useAdapters(fakeAdapter('shop', { readiness: { prepare: {} } }));
    const target = tempRoot();
    const record = async (device: string): Promise<Record<string, unknown>> => {
      const artifacts = path.join(root, device);
      const argv = ['--platform', 'shop', '--target', target, '--artifacts-dir', artifacts];
      await capture(() =>
        handlePrepare([...argv, '--mobile-platform', device, '--json'], {
          usage: 'u',
          deviceTarget: {
            option: 'mobilePlatform',
            flag: '--mobile-platform',
            choices: ['ios', 'android', 'tablet'],
          },
        }),
      );
      return JSON.parse(fs.readFileSync(path.join(artifacts, 'sandbox.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    };
    assert.equal((await record('ios')).mobilePlatform, 'ios');
    // The protocol's field is ios or android only.
    assert.equal('mobilePlatform' in (await record('tablet')), false);
  });

  test('--json-stream streams each step and its nested stages, then the readiness result', async () => {
    shopHost();
    const root = tempRoot();
    process.env.SHOP_HARNESS_EXECUTABLE = fakeBin(root);
    process.env.STAGE_LINES = '1';
    useAdapters(fakeAdapter('shop', { readiness: { prepare: { devicePlatform: () => 'phone' } } }));
    const target = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    const { result, events } = await captureStdout(() =>
      captureStderr(() =>
        capture(() =>
          handlePrepare(
            [
              '--platform',
              'shop',
              '--target',
              target,
              '--artifacts-dir',
              artifacts,
              '--json-stream',
            ],
            { usage: 'u', steps: [fixtureStep] },
          ),
        ),
      ),
    );
    assert.equal(result.result.result, 0);
    assert.equal(result.result.stdout, '', 'stdout carries only the stream');
    const stages = events.filter((event) => event.event === 'stage');
    assert.deepEqual(
      stages
        .filter((event) => event.status !== 'progress')
        .map((event) => [event.stage, event.status]),
      [
        ['doctor --fix', 'start'],
        ['doctor --fix', 'done'],
        ['status', 'start'],
        ['status', 'done'],
        ['launch --verify', 'start'],
        ['launch --verify', 'done'],
        ['seed', 'start'],
        ['seed', 'done'],
        ['verify', 'start'],
        ['verify', 'done'],
      ],
    );
    assert.ok(
      stages.some(
        (event) =>
          event.stage === 'launch --verify' &&
          event.child === '[2/5] metro: bundling 61% (4,210/6,900 modules), 1m42s',
      ),
      'a nested launch stage arrives as an event too',
    );
    const complete = events.at(-1)!;
    assert.equal(complete.event, 'complete');
    assert.equal(complete.status, 'pass');
    assert.equal(complete.ready, true);
    assert.equal(complete.recordPath, path.join(artifacts, 'sandbox.json'));
    assert.equal((complete.steps as unknown[]).length, 5);
  });

  test('a failing step keeps its own stage lines in the diagnostics it replays', async () => {
    shopHost();
    const root = tempRoot();
    process.env.SHOP_HARNESS_EXECUTABLE = fakeBin(root);
    process.env.STAGE_LINES = '1';
    process.env.STEP_RESULTS = JSON.stringify({ launch: 1 });
    useAdapters(fakeAdapter('shop', { readiness: { prepare: { devicePlatform: () => 'phone' } } }));
    const target = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    const { lines } = await captureStderr(() =>
      capture(() =>
        handlePrepare(['--platform', 'shop', '--target', target, '--artifacts-dir', artifacts], {
          usage: 'u',
          steps: [fixtureStep],
        }),
      ),
    );
    const child = '[2/5] metro: bundling 61% (4,210/6,900 modules), 1m42s';
    assert.ok(lines.includes(`[3/5] launch --verify › ${child}`), 'forwarded as it happened');
    assert.ok(lines.includes(child), 'replayed with the failure');
  });

  test('a failing step replays carriage-return progress that never ends a line', async () => {
    shopHost();
    const root = tempRoot();
    process.env.SHOP_HARNESS_EXECUTABLE = fakeBin(root);
    process.env.CR_PROGRESS = '1';
    process.env.STEP_RESULTS = JSON.stringify({ doctor: 1 });
    useAdapters(fakeAdapter('shop', { readiness: { prepare: { devicePlatform: () => 'phone' } } }));
    const target = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    const { lines } = await captureStderr(() =>
      capture(() =>
        handlePrepare(['--platform', 'shop', '--target', target, '--artifacts-dir', artifacts], {
          usage: 'u',
          steps: [fixtureStep],
        }),
      ),
    );
    // 20 KB with no newline: held to the bounded tail, not to a line, and replayed whole.
    assert.equal(lines.join('').split('x\r').length - 1, 10_000);
  });

  test('a failing step replays its stderr in order when a long unfinished line follows', async () => {
    shopHost();
    const root = tempRoot();
    process.env.SHOP_HARNESS_EXECUTABLE = fakeBin(root);
    process.env.LONG_TAIL = '1';
    process.env.STEP_RESULTS = JSON.stringify({ doctor: 1 });
    useAdapters(fakeAdapter('shop', { readiness: { prepare: { devicePlatform: () => 'phone' } } }));
    const target = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    const { lines } = await captureStderr(() =>
      capture(() =>
        handlePrepare(['--platform', 'shop', '--target', target, '--artifacts-dir', artifacts], {
          usage: 'u',
          steps: [fixtureStep],
        }),
      ),
    );
    const replayed = lines.join('\n');
    assert.ok(replayed.indexOf('boom: cause') < replayed.indexOf('y'.repeat(9000)));
  });

  test('a headless platform skips launch and the host steps; the first failure skips the rest', async () => {
    shopHost();
    const root = tempRoot();
    process.env.SHOP_HARNESS_EXECUTABLE = fakeBin(root);
    useAdapters(fakeAdapter('core', { headless: true, readiness: { prepare: {} } }));
    const target = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    process.env.STEP_RESULTS = JSON.stringify({ status: 1 });
    const { result } = await capture(() =>
      handlePrepare(
        ['--platform', 'core', '--target', target, '--artifacts-dir', artifacts, '--json'],
        {
          usage: 'u',
          steps: [fixtureStep],
        },
      ),
    );
    assert.equal(result, 1);
    const record = JSON.parse(fs.readFileSync(path.join(artifacts, 'sandbox.json'), 'utf8')) as {
      steps: Array<{ id: string; status: string; reason?: string; command: string }>;
      ready: boolean;
    };
    assert.deepEqual(
      record.steps.map((step) => [step.id, step.status]),
      [
        ['doctor', 'pass'],
        ['status', 'fail'],
        ['launch', 'skipped'],
        ['seed', 'skipped'],
        ['verify', 'skipped'],
      ],
    );
    assert.equal(record.steps[1]?.reason, 'status broke');
    assert.equal(record.steps[2]?.reason, 'core is headless: no app surface to launch or seed');
    assert.equal(record.steps[3]?.command, `${process.env.SHOP_HARNESS_EXECUTABLE} seed set`);
    assert.equal(record.steps[4]?.reason, 'previous step failed');
  });

  test('refuses what the platform cannot take, and asks when the device target is ambiguous', async () => {
    shopHost();
    const root = tempRoot();
    process.env.SHOP_HARNESS_EXECUTABLE = fakeBin(root);
    process.env.DEVICE_PLATFORM = 'watch';
    useAdapters(
      fakeAdapter('shop', {
        readiness: {
          prepare: {
            devicePlatform: () => undefined,
            ambiguousTarget: () => ({
              code: 'SHOP_TARGET',
              message: 'which one?',
              userAction: '1. phone\n2. tablet',
            }),
          },
        },
      }),
      fakeAdapter('headless', {
        headless: true,
        flags: { commands: ['clearMetro'] },
        readiness: { prepare: {} },
      }),
      fakeAdapter('unprepared'),
    );
    const target = tempRoot();
    const options = {
      usage: 'shop-harness prepare [--json]',
      clearMetroOnly: 'phone only',
      deviceTarget: {
        option: 'devicePlatform',
        flag: '--device-platform',
        choices: ['phone', 'tablet'],
      },
      forward: { option: 'remoteFlag', flag: '--remote-flag' },
    };
    await assert.rejects(
      () => handlePrepare(['--platform', 'headless', '--target', target, '--clear-metro'], options),
      /--clear-metro is phone only; this checkout is headless\n {2}Next: shop-harness prepare \[--json\]/u,
    );
    await assert.rejects(
      () =>
        handlePrepare(
          ['--platform', 'headless', '--target', target, '--remote-flag', 'x'],
          options,
        ),
      /--remote-flag needs an app runtime; this checkout is headless/u,
    );
    await assert.rejects(
      () =>
        handlePrepare(
          ['--platform', 'shop', '--target', target, '--device-platform', 'watch'],
          options,
        ),
      /--device-platform must be phone or tablet; received 'watch'/u,
    );
    await assert.rejects(
      () => handlePrepare(['--platform', 'unprepared', '--target', target], options),
      /could not detect the platform of/u,
    );
    const ambiguous = await capture(() =>
      handlePrepare(
        [
          '--platform',
          'shop',
          '--target',
          target,
          '--artifacts-dir',
          path.join(root, 'a'),
          '--json',
        ],
        options,
      ),
    );
    assert.equal(ambiguous.result, 1);
    assert.deepEqual(JSON.parse(ambiguous.stdout), {
      schemaVersion: 1,
      command: 'prepare',
      status: 'fail',
      exitCode: 1,
      error: { code: 'SHOP_TARGET', message: 'which one?', userAction: '1. phone\n2. tablet' },
    });

    // --json-stream ends with the error and one complete on these paths too.
    const streamed = await captureStdout(() =>
      captureStderr(() =>
        handlePrepare(
          [
            '--platform',
            'shop',
            '--target',
            target,
            '--artifacts-dir',
            path.join(root, 'b'),
            '--json-stream',
          ],
          options,
        ),
      ),
    );
    assert.equal(streamed.result.result, 1);
    assert.deepEqual(
      streamed.events
        .filter((event) => event.event === 'error')
        .map((event) => (event.error as { code: string }).code),
      ['SHOP_TARGET'],
    );
    assert.deepEqual(
      streamed.events.filter((event) => event.event === 'complete').map((event) => event.status),
      ['fail'],
    );
    assert.equal(streamed.events.at(-1)!.event, 'complete');
    let thrown: unknown;
    const refused = await captureStdout(async () => {
      try {
        return await handlePrepare(
          ['--platform', 'headless', '--target', target, '--clear-metro', '--json-stream'],
          options,
        );
      } catch (error) {
        thrown = error;
        return -1;
      }
    });
    assert.ok(thrown, 'the usage error still reaches the caller');
    assert.deepEqual(
      refused.events.map((event) => event.event),
      ['error', 'complete'],
    );
    assert.equal((refused.events[0]!.error as { code: string }).code, 'USAGE');
    assert.equal(refused.events[1]!.exitCode, 2);
  });
});

describe('checklist', () => {
  function taskWith(checklist: string, signal?: string): string {
    const task = tempRoot();
    fs.writeFileSync(path.join(task, 'CHECKLIST.md'), checklist);
    if (signal)
      fs.writeFileSync(path.join(task, 'SIGNAL.json'), JSON.stringify({ status: signal }));
    return task;
  }

  test('a gated step stays blocked until its gate is ready, and only its own label gates it', async () => {
    shopHost();
    const task = taskWith(
      '# Task\n\n- [ ] 1. Prove it with shop-harness check diff.\n- [ ] 2. Write it up.\n',
    );
    const calls: string[] = [];
    const gates = [
      {
        label: /check diff/u,
        ready: (_dir: string, step: string) => {
          calls.push(step);
          return false;
        },
      },
    ];
    const blocked = await capture(() => handleChecklist(['mark', task, '1'], { stepGates: gates }));
    assert.equal(blocked.result, 1);
    assert.deepEqual(calls, ['1']);
    // Step 2's label carries no gate, so the gate is never asked.
    calls.length = 0;
    await capture(() => handleChecklist(['mark', task, '2'], { stepGates: gates }));
    assert.deepEqual(calls, []);
  });

  test("a sub-unit's completion waits for its parent step's gate, and complete runs the host hook first", async () => {
    shopHost();
    const task = taskWith('# Task\n\n- [ ] 1. Prove it with shop-harness check diff.\n');
    fs.mkdirSync(path.join(task, 'subtasks'));
    fs.writeFileSync(
      path.join(task, 'subtasks', 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        units: [{ id: 'u1', parent: { checklist: 'CHECKLIST.md', stepNumber: 1 } }],
      }),
    );
    const calls: string[] = [];
    const gates = [
      {
        label: /check diff/u,
        ready: (_dir: string, step: string) => {
          calls.push(step);
          return false;
        },
      },
    ];
    const sub = await capture(() =>
      handleChecklist(['mark', task, 'sub', 'u1', 'complete'], { stepGates: gates }),
    );
    assert.equal(sub.result, 1);
    assert.deepEqual(calls, ['1']);

    const completed: string[] = [];
    await capture(() =>
      handleChecklist(['mark', task, 'complete'], {
        stepGates: gates,
        beforeComplete: (dir) => completed.push(dir),
      }),
    );
    assert.deepEqual(completed, [path.resolve(task)]);
  });

  test('a terminal verdict stays terminal, and closeout exists only when the host stages it', async () => {
    shopHost();
    const task = taskWith('- [ ] 1. Step.\n', 'complete');
    const kept = await capture(() => handleChecklist(['mark', task, '1']));
    assert.equal(kept.result, 0);
    assert.equal(
      kept.stdout,
      'signal already terminal: status=complete; ignoring non-terminal mark 1',
    );

    const without = await capture(() => handleChecklist(['closeout', task]));
    assert.equal(without.result, 2);
    assert.equal(without.stderr, 'usage: shop-harness checklist mark <task-dir> <step> [options]');

    const staged: Array<readonly string[]> = [];
    const withHook = await capture(() =>
      handleChecklist(['closeout', task, '--share'], {
        closeout: (_dir, args) => {
          staged.push(args);
          return { status: 0 };
        },
      }),
    );
    assert.equal(withHook.result, 0);
    assert.deepEqual(staged, [['--share']]);
    const noTask = await capture(() =>
      handleChecklist(['mark'], { closeout: () => ({ status: 0 }) }),
    );
    assert.equal(
      noTask.stderr,
      'usage: shop-harness checklist <mark <task-dir> <step> | closeout <task-dir>> [options]',
    );
  });
});

describe('task init', () => {
  test('adds the host surface, a mark shim through the host checklist, and the detected platform', async () => {
    const { packageRoot } = shopHost();
    process.env.SHOP_HARNESS_EXECUTABLE = path.join(packageRoot, 'bin', 'shop-harness');
    useAdapters(fakeAdapter('shop', { detect: { files: () => true } }));
    const catalog = tempRoot();
    fs.mkdirSync(path.join(catalog, 'fix-bug'));
    fs.writeFileSync(path.join(catalog, 'fix-bug', 'shop.md'), '# Fix\n\n- [ ] 1. Prove it.\n');
    const task = path.join(tempRoot(), 'task');
    const { result } = await capture(() =>
      handleTaskInit(
        [
          'init',
          task,
          '--flow',
          'fix-bug',
          '--template',
          'fix-bug/shop',
          '--package-templates',
          catalog,
          '--package-id',
          't',
          '--title',
          'x',
          '--task-text',
          'y',
          '--json',
        ],
        { surface: 'skill' },
      ),
    );
    assert.equal(result, 0);
    const handoff = JSON.parse(
      fs.readFileSync(path.join(task, 'inputs', 'handoff.json'), 'utf8'),
    ) as { surface: string };
    assert.equal(handoff.surface, 'skill');
    assert.match(fs.readFileSync(path.join(task, 'mark'), 'utf8'), /shop-harness checklist mark/u);
    const usage = await capture(() => handleTaskInit(['make', task]));
    assert.equal(usage.result, 2);
    assert.equal(
      usage.stderr,
      'usage: shop-harness task init <task-dir> --flow f --template id --title t [options]',
    );
  });
});

describe('recipe-quality', () => {
  test('builds the artifact, rejects invalid input with exit 5, and runs the host subcommands', async () => {
    shopHost();
    const root = tempRoot();
    const input = path.join(root, 'in.json');
    const output = path.join(root, 'out', 'quality.json');
    fs.writeFileSync(input, JSON.stringify({ verdict: 'pass', reasons: ['proved by the run'] }));
    const built = await capture(() =>
      handleRecipeQuality(['build', '--input', input, '--output', output, '--json']),
    );
    assert.equal(built.result, 0);
    assert.equal(
      (JSON.parse(fs.readFileSync(output, 'utf8')) as { verdict: string }).verdict,
      'pass',
    );

    fs.writeFileSync(input, '{');
    const invalid = await capture(() =>
      handleRecipeQuality(['--input', input, '--output', output]),
    );
    assert.equal(invalid.result, 5);
    assert.match(invalid.stderr, /^✗ shop-harness recipe-quality: --input .* is not valid JSON/u);

    const seen: string[] = [];
    const options = {
      subcommands: {
        advise: async () => {
          seen.push('advise');
          return 0;
        },
      },
      subcommandOptions: {
        names: ['advisor'],
        message: 'advice options require the advise subcommand',
        userAction: 'shop-harness recipe-quality advise',
      },
      missingAction: 'missing action: use build or advise',
      usageNote: 'apply the quality bar first.',
    };
    assert.equal((await capture(() => handleRecipeQuality(['advise'], options))).result, 0);
    assert.deepEqual(seen, ['advise']);
    const misplaced = await capture(() =>
      handleRecipeQuality(['--advisor', 'x', '--json'], options),
    );
    assert.equal(misplaced.result, 2);
    assert.match(misplaced.stdout, /advice options require the advise subcommand/u);
    const missing = await capture(() => handleRecipeQuality([], options));
    assert.equal(
      missing.stderr,
      '✗ shop-harness recipe-quality: missing action: use build or advise\n  Next: shop-harness recipe-quality build --input <compact.json> --output <path> [--json]\n  Shorthand: shop-harness recipe-quality --input <compact.json> --output <path> [--json]\n  Note: apply the quality bar first.',
    );
  });
});

describe('the moved commands name no product', () => {
  test('no MetaMask or mm-harness literal in the readiness sources', () => {
    const dir = path.join(import.meta.dirname, '..', 'src', 'harness');
    const files = [
      'readiness.ts',
      'doctor-report.ts',
      'task-view.ts',
      'commands/doctor.ts',
      'commands/prepare.ts',
      'commands/status.ts',
      'commands/status-watch.ts',
      'commands/task-init.ts',
      'commands/checklist.ts',
      'commands/execution-template.ts',
      'commands/recipe-quality.ts',
    ];
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.doesNotMatch(text, /metamask|mm-harness|MM_HARNESS/iu, file);
    }
  });
});
