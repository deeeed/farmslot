// The invocation context: flag > binding > slot > unique detect > default, the
// sources it reports, plugins matched by their declaration without loading,
// ambiguity, and approvals that are never inferred.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  ADAPTER_SDK_VERSION,
  type AdapterDetect,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';

import {
  AdapterAmbiguousError,
  configureHarnessAdapters,
  contextAdapter,
  detectAdapter,
  formatHarnessContext,
  type HarnessContext,
  pickDetected,
  resolveHarnessContext,
  setHarnessContext,
} from '../src/harness/index.js';

const roots: string[] = [];
const savedEnv = { ...process.env };
const imports = (): string[] =>
  ((globalThis as Record<string, unknown>).__pluginImports as string[] | undefined) ?? [];

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-context-')));
  roots.push(root);
  return root;
}

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function gitOrigin(root: string, url: string): void {
  execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', url], { stdio: 'ignore' });
}

function adapter(id: string, extra: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id,
    sdkVersion: ADAPTER_SDK_VERSION,
    headless: true,
    resolveSlotPorts() {},
    runtimeStatus: async () => ({ decision: 'ready', reasons: [] }),
    devServer: {
      label: 'none',
      describe: () => 'none',
      stop: () => ({ kind: 'stopped', status: 0, summary: 'none' }),
    },
    logSources: () => [],
    appLogSource: () => null,
    hints: { launch: 'l', relaunch: 'l', runtimeProbeRecovery: () => 'd' },
    actions: {
      manifestPath: () => `/manifests/${id}.json`,
      semantic: [],
      cdpTarget: { transport: 'none', probePath: '/' },
    },
    harness: {
      install: { entry: 'i', fallback: 'i' },
      cleanup: { entry: 'c', fallback: 'c' },
      verify: () => ({ error: 'none' }),
    },
    runtimeContext: { forbiddenFields: [] },
    launch: async () => 0,
    ...extra,
  } as PlatformAdapter;
}

const hasFile =
  (file: string): AdapterDetect['files'] =>
  (target) =>
    fs.existsSync(path.join(target, file));

function useAdapters(...adapters: PlatformAdapter[]): void {
  const registry = createAdapterRegistry();
  for (const entry of adapters) registry.register(entry);
  configureHarnessAdapters(registry);
}

// A library declaring plugins with their `detect`; each module records its import.
function pluginLibrary(
  plugins: Record<string, { detect?: Record<string, string[]>; extends?: string }>,
): string {
  const root = tempRoot();
  const declared: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(plugins)) {
    write(
      root,
      `plugins/${id}.mjs`,
      `globalThis.__pluginImports = [...(globalThis.__pluginImports ?? []), '${id}'];\nexport const adapter = { id: '${id}' };\n`,
    );
    declared[id] = {
      module: `./plugins/${id}.mjs`,
      export: 'adapter',
      ...(entry.extends ? { extends: entry.extends } : {}),
      ...(entry.detect ? { detect: entry.detect } : {}),
    };
  }
  write(root, 'recipe-library.json', JSON.stringify({ adapters: declared }));
  return root;
}

function runtimeContext(target: string, value: Record<string, unknown>): void {
  write(target, 'temp/recipe/runtime/agentic-runtime.json', JSON.stringify(value));
}

function poolDir(slots: Record<string, unknown>[]): string {
  const dir = tempRoot();
  write(dir, 'macwork.json', JSON.stringify({ machine: 'macwork', host: 'localhost', slots }));
  return dir;
}

beforeEach(() => {
  for (const key of [
    'RECIPE_LIBRARY_PATH',
    'RECIPE_RUNTIME_DIR',
    'RECIPE_RUNTIME_CONTEXT',
    'FARMSLOT_POOL_DIR',
    'FARMSLOT_ROOT',
  ])
    delete process.env[key];
  // No personal library from ~/.farmslot reaches the tests.
  process.env.FARMSLOT_HOME = tempRoot();
  (globalThis as Record<string, unknown>).__pluginImports = [];
  setHarnessContext(undefined);
});

afterEach(() => {
  setHarnessContext(undefined);
  configureHarnessAdapters(createAdapterRegistry());
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveHarnessContext', () => {
  test('a flag wins over binding, slot and detection; target defaults to the cwd', async () => {
    const checkout = tempRoot();
    write(checkout, 'web.json', '{}');
    runtimeContext(checkout, { platform: 'app', slotId: 'bound-1' });
    useAdapters(adapter('web', { detect: { files: hasFile('web.json') } }), adapter('app'));

    for (const [tokens, detail] of [
      [['--adapter', 'web'], '--adapter'],
      [['--platform=web'], '--platform'],
    ] as const) {
      const context = await resolveHarnessContext({ tokens, cwd: checkout });
      assert.deepEqual(context.adapter, { value: 'web', source: 'flag', detail });
      assert.deepEqual(context.target, { value: checkout, source: 'default', detail: 'cwd' });
    }
    const flagged = await resolveHarnessContext({
      tokens: ['--target', checkout, '--adapter', 'app'],
      cwd: tempRoot(),
    });
    assert.deepEqual(flagged.target, { value: checkout, source: 'flag', detail: '--target' });
    assert.equal(flagged.adapter?.source, 'flag');
  });

  test('a leading platform target is a flag', async () => {
    useAdapters(adapter('app', { targets: ['ios', 'android'] }), adapter('web'));
    const context = await resolveHarnessContext({ tokens: ['ios', '--json'], cwd: tempRoot() });
    assert.deepEqual(context.adapter, { value: 'app', source: 'flag', detail: 'positional' });
  });

  test("binding: the runtime context's platform, through the host's slot mapping", async () => {
    const checkout = tempRoot();
    write(checkout, 'web.json', '{}');
    runtimeContext(checkout, { platform: 'web-extension', slotId: 'mmedev-1', watcherPort: 9001 });
    useAdapters(adapter('web'), adapter('app', { detect: { files: hasFile('web.json') } }));
    const context = await resolveHarnessContext({
      tokens: [],
      cwd: checkout,
      slotAdapter: (platform) => (platform === 'web-extension' ? 'web' : undefined),
    });
    assert.deepEqual(context.adapter, {
      value: 'web',
      source: 'binding',
      detail: 'runtime-context',
    });
    assert.deepEqual(context.slot, {
      value: 'mmedev-1',
      source: 'binding',
      detail: 'runtime-context',
      ports: { watcherPort: 9001 },
    });

    // A platform no adapter answers to binds nothing: detection decides.
    runtimeContext(checkout, { platform: 'desktop' });
    const unbound = await resolveHarnessContext({ tokens: [], cwd: checkout });
    assert.equal(unbound.adapter?.value, 'app');
    assert.equal(unbound.adapter?.source, 'detect');
    assert.deepEqual(unbound.slot, { value: null, source: 'none', detail: 'no-pool-dir' });
  });

  test("slot: slot-config's match for the checkout, its own platform only", async () => {
    const checkout = tempRoot();
    write(checkout, 'web.json', '{}');
    useAdapters(adapter('core'), adapter('web', { detect: { files: hasFile('web.json') } }));
    const slot = {
      id: 'macwork-coredev-6',
      repo: checkout,
      session: 'coredev-6',
      platform: 'core',
      resources: { 'dev-server': { port: 8096, metro_port: 8196 }, sim: { headless: true } },
    };
    const pools = poolDir([slot]);
    process.env.FARMSLOT_POOL_DIR = pools;
    const context = await resolveHarnessContext({ tokens: [], cwd: checkout });
    assert.deepEqual(context.adapter, { value: 'core', source: 'slot', detail: 'slot-config' });
    assert.deepEqual(context.slot, {
      value: 'macwork-coredev-6',
      source: 'slot',
      detail: 'slot-config',
      session: 'coredev-6',
      poolFile: path.join(pools, 'macwork.json'),
      ports: { port: 8096, metro_port: 8196 },
    });

    // A pool platform that names no adapter ('web' is a browser slot, not an
    // adapter here) leaves the adapter to detection; the slot still reports.
    const cliPools = poolDir([{ ...slot, platform: 'cli' }]);
    const detected = await resolveHarnessContext({
      tokens: [],
      cwd: checkout,
      slotPoolDir: cliPools,
    });
    assert.equal(detected.adapter?.value, 'web');
    assert.equal(detected.adapter?.source, 'detect');
    assert.equal(detected.slot?.value, 'macwork-coredev-6');

    // FARMSLOT_ROOT/pool is the fallback; an unreadable pool directory is no slot.
    delete process.env.FARMSLOT_POOL_DIR;
    const farmslotRoot = tempRoot();
    fs.renameSync(pools, path.join(farmslotRoot, 'pool'));
    process.env.FARMSLOT_ROOT = farmslotRoot;
    assert.equal(
      (await resolveHarnessContext({ tokens: [], cwd: checkout })).slot?.value,
      'macwork-coredev-6',
    );
    process.env.FARMSLOT_ROOT = path.join(checkout, 'missing');
    assert.deepEqual((await resolveHarnessContext({ tokens: [], cwd: checkout })).slot, {
      value: null,
      source: 'none',
      detail: 'no-pool-dir',
    });
    // A pool that maps no slot here: the checkout is not a slot.
    assert.equal(
      (await resolveHarnessContext({ tokens: [], cwd: tempRoot(), slotPoolDir: cliPools })).slot,
      undefined,
    );
  });

  test('detect: a remote match beats file matches, and a child beats the parent it extends', async () => {
    const checkout = tempRoot();
    write(checkout, 'web.json', '{}');
    gitOrigin(checkout, 'git@example.test:acme/shop-app.git');
    useAdapters(
      adapter('web', { detect: { files: hasFile('web.json') } }),
      adapter('app', { detect: { remote: (url) => url.includes('shop-app') } }),
    );
    assert.deepEqual((await resolveHarnessContext({ tokens: [], cwd: checkout })).adapter, {
      value: 'app',
      source: 'detect',
      detail: 'remote',
      matched: ['remote'],
    });

    const plain = tempRoot();
    write(plain, 'web.json', '{}');
    useAdapters(
      adapter('web', { detect: { files: hasFile('web.json') } }),
      adapter('shop', { extends: 'web', detect: { files: hasFile('web.json') } }),
    );
    assert.equal((await resolveHarnessContext({ tokens: [], cwd: plain })).adapter?.value, 'shop');
  });

  test('without --target, a subdirectory detects, binds and finds its slot at the Git top level', async () => {
    const checkout = tempRoot();
    write(checkout, 'web.json', '{}');
    fs.mkdirSync(path.join(checkout, 'packages/deep'), { recursive: true });
    gitOrigin(checkout, 'git@example.test:acme/plain.git');
    useAdapters(adapter('web', { detect: { files: hasFile('web.json') } }), adapter('app'));
    const pools = poolDir([{ id: 'w-1', repo: checkout, session: 'w' }]);
    const deep = path.join(checkout, 'packages/deep');
    const context = await resolveHarnessContext({ tokens: [], cwd: deep, slotPoolDir: pools });
    assert.equal(context.adapter?.value, 'web');
    assert.deepEqual(context.target, { value: deep, source: 'default', detail: 'cwd' });
    assert.equal(context.slot?.value, 'w-1');
    // An explicit --target is taken as given.
    const flagged = await resolveHarnessContext({ tokens: ['--target', deep], cwd: checkout });
    assert.equal(flagged.adapter, undefined);
  });

  test('ambiguous: more than one match stops with the candidates and what matched', async () => {
    const checkout = tempRoot();
    write(checkout, 'web.json', '{}');
    useAdapters(
      adapter('web', { detect: { files: hasFile('web.json') } }),
      adapter('app', { detect: { files: () => true } }),
    );
    await assert.rejects(resolveHarnessContext({ tokens: [], cwd: checkout }), (error) => {
      assert.ok(error instanceof AdapterAmbiguousError);
      assert.equal(error.code, 'ADAPTER_AMBIGUOUS');
      assert.equal(error.exitCode, 2);
      assert.deepEqual(error.candidates, [
        { adapter: 'web', matched: ['files'] },
        { adapter: 'app', matched: ['files'] },
      ]);
      assert.equal(
        error.message,
        `${checkout} matches more than one adapter: web (files), app (files)`,
      );
      assert.equal(error.userAction, 'pass --adapter <web|app>');
      return true;
    });
    // A flag settles it.
    const flagged = await resolveHarnessContext({ tokens: ['--adapter', 'app'], cwd: checkout });
    assert.equal(flagged.adapter?.value, 'app');
  });

  test('none: no adapter, unless the host names a default', async () => {
    useAdapters(adapter('web', { detect: { files: hasFile('web.json') } }));
    const empty = tempRoot();
    const none = await resolveHarnessContext({ tokens: [], cwd: empty });
    assert.equal(none.adapter, undefined);
    // No pool directory and no runtime context: the slot could not be looked up.
    assert.deepEqual(none.slot, { value: null, source: 'none', detail: 'no-pool-dir' });
    const fallback = await resolveHarnessContext({ tokens: [], cwd: empty, defaultAdapter: 'web' });
    assert.deepEqual(fallback.adapter, { value: 'web', source: 'default', detail: 'default' });
  });

  test("plugins: matched by the declaration's detect without importing any of them", async () => {
    const checkout = tempRoot();
    write(checkout, 'package.json', JSON.stringify({ dependencies: { next: '15' } }));
    fs.mkdirSync(path.join(checkout, 'src/features/perpetuals'), { recursive: true });
    gitOrigin(checkout, 'git@github.com:acme/va-mmcx-terminal.git');
    useAdapters(adapter('web-dapp'), adapter('core', { detect: { files: hasFile('yarn.lock') } }));
    const library = pluginLibrary({
      terminal: {
        extends: 'web-dapp',
        detect: {
          remote: ['va-mmcx-terminal'],
          files: ['src/features/perpetuals/'],
          packageDependencies: ['next'],
        },
      },
      // Matches by files, so the remote match beats it.
      shop: { detect: { packageDependencies: ['next'] } },
      // No detect: never a candidate.
      quiet: {},
      // Claims a built-in id: skipped as a candidate.
      core: { detect: { files: ['package.json'] } },
    });
    process.env.RECIPE_LIBRARY_PATH = `terminal-lib=${library}`;
    const context = await resolveHarnessContext({ tokens: [], cwd: checkout });
    assert.deepEqual(context.adapter, {
      value: 'terminal',
      source: 'detect',
      detail: 'remote+files',
      matched: ['remote', 'files'],
      library: 'terminal-lib',
    });
    assert.deepEqual(imports(), []);

    // Only libraries the loader trusts declare candidates: --library counts.
    delete process.env.RECIPE_LIBRARY_PATH;
    assert.equal((await resolveHarnessContext({ tokens: [], cwd: checkout })).adapter, undefined);
    const viaFlag = await resolveHarnessContext({
      tokens: [],
      cwd: checkout,
      load: { libraries: [`terminal-lib=${library}`] },
    });
    assert.equal(viaFlag.adapter?.value, 'terminal');
  });

  test('approvals are never inferred from a binding or a slot', async () => {
    const checkout = tempRoot();
    runtimeContext(checkout, {
      platform: 'web',
      slotId: 's-1',
      approvePlan: 'sha256:abc',
      allowMainnet: true,
      funding: { amount: '1' },
    });
    useAdapters(adapter('web'));
    process.env.FARMSLOT_POOL_DIR = poolDir([
      { id: 's-1', repo: checkout, session: 's', approvePlan: 'sha256:def', mainnet: true },
    ]);
    const context = await resolveHarnessContext({ tokens: [], cwd: checkout });
    assert.deepEqual(Object.keys(context).sort(), ['adapter', 'slot', 'target']);
    assert.deepEqual(Object.keys(context.slot ?? {}).sort(), [
      'detail',
      'poolFile',
      'ports',
      'session',
      'source',
      'value',
    ]);
    assert.doesNotMatch(JSON.stringify(context), /approve|mainnet|fund/iu);
  });
});

describe('formatHarnessContext', () => {
  test('one line naming each value and its source', () => {
    const context: HarnessContext = {
      adapter: { value: 'terminal', source: 'detect', detail: 'remote+files' },
      target: { value: '/w/terminal-1', source: 'default', detail: 'cwd' },
      slot: { value: 'mmt-1', source: 'slot', detail: 'slot-config', ports: {} },
    };
    assert.equal(
      formatHarnessContext(context),
      'context: adapter terminal (detected: remote+files), target /w/terminal-1 (cwd), slot mmt-1 (slot-config)',
    );
    assert.equal(
      formatHarnessContext({
        adapter: { value: 'web', source: 'binding', detail: 'runtime-context' },
        target: { value: '/w', source: 'flag', detail: '--target' },
      }),
      'context: adapter web (runtime-context), target /w (--target)',
    );
    assert.equal(
      formatHarnessContext({ target: { value: '/w', source: 'default', detail: 'cwd' } }),
      'context: adapter none, target /w (cwd)',
    );
    assert.equal(
      formatHarnessContext({
        adapter: { value: 'web', source: 'detect', detail: 'files' },
        target: { value: '/w', source: 'default', detail: 'cwd' },
        slot: { value: null, source: 'none', detail: 'no-pool-dir' },
      }),
      'context: adapter web (detected: files), target /w (cwd), slot unknown (no pool dir)',
    );
  });
});

describe('detectAdapter', () => {
  test('is the unique match over the registered adapters and the declared plugins', () => {
    const checkout = tempRoot();
    write(checkout, 'web.json', '{}');
    write(checkout, 'shop.json', '{}');
    useAdapters(adapter('web', { detect: { files: hasFile('web.json') } }), adapter('app'));
    assert.equal(detectAdapter(checkout), 'web');
    const shop = { id: 'shop', library: 'lib', extends: 'web', detect: { files: ['shop.json'] } };
    assert.equal(detectAdapter(checkout, [shop]), 'shop');
    // A loaded plugin is matched by its declaration, not its registered detect.
    assert.equal(detectAdapter(checkout, [{ ...shop, id: 'app', extends: 'web' }]), 'app');
    assert.throws(
      () => detectAdapter(checkout, [{ ...shop, extends: undefined }]),
      AdapterAmbiguousError,
    );
  });

  test('contextAdapter answers only for the resolved target', () => {
    setHarnessContext({
      adapter: { value: 'app', source: 'binding', detail: 'runtime-context' },
      target: { value: '/w/bound', source: 'default', detail: 'cwd' },
    });
    assert.equal(contextAdapter('/w/bound/'), 'app');
    assert.equal(contextAdapter('/w/other'), undefined);
    setHarnessContext(undefined);
    assert.equal(contextAdapter('/w/bound'), undefined);
  });

  test('pickDetected throws for a tie that extends does not settle', () => {
    const any = { files: () => true };
    assert.throws(
      () =>
        pickDetected(
          [
            { id: 'web', detect: any },
            { id: 'shop', extends: 'web', detect: any },
            { id: 'cafe', extends: 'web', detect: any },
          ],
          tempRoot(),
        ),
      (error) =>
        error instanceof AdapterAmbiguousError &&
        error.candidates.map((candidate) => candidate.adapter).join() === 'shop,cafe',
    );
  });
});
