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
  collectTaskView,
  configureHarnessAdapters,
  contextAdapter,
  contextPorts,
  contractPositionals,
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
    'RECIPE_CDP_PORT',
    'CDP_PORT',
    'TERMINAL_APP_PORT',
    'RECIPE_WATCHER_PORT',
    'WATCHER_PORT',
    'METRO_PORT',
  ])
    delete process.env[key];
  // No personal library from ~/.farmslot, and no ~/farmslot-node/pool, reaches the tests.
  process.env.FARMSLOT_HOME = tempRoot();
  process.env.HOME = tempRoot();
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
    // With neither variable, the node deploy pool under the home directory.
    delete process.env.FARMSLOT_ROOT;
    const home = process.env.HOME ?? '';
    write(
      home,
      'farmslot-node/pool/macwork.json',
      JSON.stringify({ machine: 'macwork', host: 'localhost', slots: [slot] }),
    );
    const deployed = await resolveHarnessContext({ tokens: [], cwd: checkout });
    assert.equal(deployed.slot?.value, 'macwork-coredev-6');
    assert.equal(deployed.slot?.source, 'slot');
    assert.equal(deployed.slot?.detail, 'slot-config (~/farmslot-node/pool)');
    assert.match(
      formatHarnessContext(deployed),
      /slot macwork-coredev-6 \(slot-config \(~\/farmslot-node\/pool\)\)$/u,
    );
    fs.rmSync(path.join(home, 'farmslot-node'), { recursive: true });

    process.env.FARMSLOT_ROOT = path.join(checkout, 'missing');
    assert.deepEqual((await resolveHarnessContext({ tokens: [], cwd: checkout })).slot, {
      value: null,
      source: 'none',
      detail: 'no-pool-dir',
    });
    // A pool that maps no slot here says so, with the pool it read.
    assert.deepEqual(
      (await resolveHarnessContext({ tokens: [], cwd: tempRoot(), slotPoolDir: cliPools })).slot,
      { value: null, source: 'none', detail: 'not-in-pool', poolDir: cliPools },
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

  test('a pool directory that exists but does not read is a failure, not a missing pool', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root reads any directory');
    const checkout = tempRoot();
    useAdapters(adapter('web'));
    const pools = poolDir([]);
    fs.chmodSync(pools, 0o000);
    try {
      await assert.rejects(
        resolveHarnessContext({ tokens: [], cwd: checkout, slotPoolDir: pools }),
        { code: 'EACCES' },
      );
    } finally {
      // Before afterEach removes it.
      fs.chmodSync(pools, 0o755);
    }
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

  test('refuses ambiguous slot bindings until the operator selects one', async () => {
    const checkout = tempRoot();
    useAdapters(adapter('web'));
    const pools = poolDir([
      { id: 'one', repo: checkout, platform: 'web' },
      { id: 'two', repo: checkout, platform: 'web' },
    ]);
    await assert.rejects(resolveHarnessContext({ tokens: [], cwd: checkout, slotPoolDir: pools }), {
      code: 'SLOT_AMBIGUOUS',
    });
    const selected = await resolveHarnessContext({
      tokens: ['--slot', 'two'],
      cwd: checkout,
      slotPoolDir: pools,
    });
    assert.equal(selected.slot?.value, 'two');
    await assert.rejects(
      resolveHarnessContext({
        tokens: ['--slot', 'missing'],
        cwd: checkout,
        slotPoolDir: pools,
      }),
      { code: 'SLOT_NOT_FOUND' },
    );
  });

  test('a runtime context of another checkout binds nothing here and is reported', async () => {
    const extension = tempRoot();
    const mobile = tempRoot();
    write(mobile, 'app.json', '{}');
    useAdapters(adapter('web'), adapter('app', { detect: { files: hasFile('app.json') } }));
    const inherited = path.join(extension, 'temp/recipe/runtime/agentic-runtime.json');
    runtimeContext(extension, {
      platform: 'web',
      slotId: 'mmedev-1',
      repoRoot: extension,
      cdpPort: 9222,
    });
    process.env.RECIPE_RUNTIME_CONTEXT = inherited;

    const foreign = await resolveHarnessContext({ tokens: ['--target', mobile], cwd: extension });
    assert.equal(foreign.adapter?.value, 'app');
    assert.equal(foreign.adapter?.source, 'detect');
    assert.deepEqual(foreign.slot, { value: null, source: 'none', detail: 'no-pool-dir' });
    assert.deepEqual(foreign.ignoredBinding, { path: inherited, repoRoot: extension });
    assert.match(
      formatHarnessContext(foreign),
      new RegExp(`binding ignored \\(belongs to ${extension}\\)$`, 'u'),
    );

    // Probe: a core-like target detects; the inherited binding never wins.
    const core = tempRoot();
    write(core, 'yarn.lock', '');
    useAdapters(
      adapter('web'),
      adapter('app', { detect: { files: hasFile('app.json') } }),
      adapter('core', { detect: { files: hasFile('yarn.lock') } }),
    );
    const probed = await resolveHarnessContext({ tokens: ['--target', core], cwd: extension });
    assert.deepEqual(probed.adapter, {
      value: 'core',
      source: 'detect',
      detail: 'files',
      matched: ['files'],
    });
    assert.equal(probed.ignoredBinding?.repoRoot, extension);

    // Its own checkout, a subdirectory of it, and a symlink to it are bound.
    const own = await resolveHarnessContext({ tokens: ['--target', extension], cwd: mobile });
    assert.equal(own.adapter?.source, 'binding');
    assert.equal(own.slot?.value, 'mmedev-1');
    // A subdirectory binds: its Git top level is the bound checkout.
    gitOrigin(extension, 'git@example.test:acme/extension.git');
    fs.mkdirSync(path.join(extension, 'ui'));
    const inside = await resolveHarnessContext({
      tokens: ['--target', path.join(extension, 'ui')],
      cwd: mobile,
    });
    assert.equal(inside.adapter?.source, 'binding');
    const link = path.join(tempRoot(), 'linked-extension');
    fs.symlinkSync(extension, link);
    runtimeContext(extension, { platform: 'web', slotId: 'mmedev-1', repoRoot: link });
    const viaLink = await resolveHarnessContext({ tokens: ['--target', extension], cwd: mobile });
    assert.equal(viaLink.adapter?.source, 'binding');
    assert.equal(viaLink.ignoredBinding, undefined);

    // Without repoRoot, a context outside the target is foreign too.
    runtimeContext(extension, { platform: 'web' });
    const unnamed = await resolveHarnessContext({ tokens: ['--target', mobile], cwd: extension });
    assert.deepEqual(unnamed.ignoredBinding, { path: inherited, repoRoot: null });
    assert.match(
      formatHarnessContext(unnamed),
      /binding ignored \(belongs to an unnamed checkout\)$/u,
    );
  });

  test('a clone nested inside the bound checkout inherits nothing; a subdirectory does', async () => {
    const outer = tempRoot();
    gitOrigin(outer, 'git@example.test:acme/outer.git');
    const nested = path.join(outer, 'temp', 'clone');
    fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
    gitOrigin(nested, 'git@example.test:acme/nested.git');
    useAdapters(adapter('web'), adapter('app'));
    runtimeContext(outer, { platform: 'web', slotId: 'outer-1', repoRoot: outer });
    process.env.RECIPE_RUNTIME_CONTEXT = path.join(
      outer,
      'temp/recipe/runtime/agentic-runtime.json',
    );

    const clone = await resolveHarnessContext({ tokens: [], cwd: path.join(nested, 'src') });
    assert.equal(clone.adapter, undefined);
    assert.equal(clone.ignoredBinding?.repoRoot, outer);
    const flagged = await resolveHarnessContext({ tokens: ['--target', nested], cwd: outer });
    assert.equal(flagged.ignoredBinding?.repoRoot, outer);

    fs.mkdirSync(path.join(outer, 'packages'));
    const sub = await resolveHarnessContext({ tokens: [], cwd: path.join(outer, 'packages') });
    assert.equal(sub.adapter?.source, 'binding');
    assert.equal(sub.slot?.value, 'outer-1');
  });

  test('a checkout the node deploy pool lacks reports the miss and the pool', async () => {
    const checkout = tempRoot();
    useAdapters(adapter('web'));
    const home = process.env.HOME ?? '';
    write(
      home,
      'farmslot-node/pool/macwork.json',
      JSON.stringify({
        machine: 'macwork',
        host: 'localhost',
        slots: [{ id: 'other-1', repo: tempRoot(), session: 'o' }],
      }),
    );
    const context = await resolveHarnessContext({ tokens: [], cwd: checkout });
    const poolDir = path.join(home, 'farmslot-node', 'pool');
    assert.deepEqual(context.slot, { value: null, source: 'none', detail: 'not-in-pool', poolDir });
    assert.equal(
      formatHarnessContext({
        ...context,
        adapter: { value: 'web', source: 'flag', detail: '--adapter' },
      }),
      `context: adapter web (--adapter), target ${checkout} (cwd), slot unknown (not in ~/farmslot-node/pool)`,
    );
  });

  test('--runtime-dir is read before the binding, with or without a default context', async () => {
    const checkout = tempRoot();
    useAdapters(adapter('web'), adapter('app'));
    write(
      checkout,
      'alt/runtime/agentic-runtime.json',
      JSON.stringify({ platform: 'app', slotId: 'alt-1', repoRoot: checkout }),
    );
    const tokens = ['--target', checkout, '--runtime-dir', 'alt/runtime'];
    const alone = await resolveHarnessContext({ tokens });
    assert.deepEqual(alone.adapter, { value: 'app', source: 'binding', detail: 'runtime-context' });
    assert.equal(alone.slot?.value, 'alt-1');
    runtimeContext(checkout, { platform: 'web', slotId: 'default-1', repoRoot: checkout });
    const both = await resolveHarnessContext({
      tokens: [...tokens.slice(0, 2), '--runtime-dir=alt/runtime'],
    });
    assert.equal(both.adapter?.value, 'app');
    assert.equal(both.slot?.value, 'alt-1');
    const fallback = await resolveHarnessContext({ tokens: tokens.slice(0, 2) });
    assert.equal(fallback.adapter?.value, 'web');
    // A runtime dir the command will refuse binds nothing.
    const unsafe = await resolveHarnessContext({
      tokens: [...tokens.slice(0, 2), '--runtime-dir', '../x'],
    });
    assert.equal(unsafe.adapter, undefined);
  });

  test('a platform target is a flag wherever the grammar puts it; adapter: false skips the adapter', async () => {
    useAdapters(
      adapter('app', { targets: ['ios', 'android'], detect: { files: () => true } }),
      adapter('web', { detect: { files: () => true } }),
    );
    const cwd = tempRoot();
    const before = await resolveHarnessContext({
      tokens: ['android', '--json'],
      positionals: ['android'],
      cwd,
    });
    const after = await resolveHarnessContext({
      tokens: ['--json', 'android'],
      positionals: ['android'],
      cwd,
    });
    assert.deepEqual(before.adapter, { value: 'app', source: 'flag', detail: 'positional' });
    assert.deepEqual(after.adapter, before.adapter);
    // The grammar reads an option's value as no positional.
    const contract = {
      options: { '--surface': { kind: 'value' as const }, '--json': { kind: 'boolean' as const } },
    };
    assert.deepEqual(contractPositionals(['--surface', 'ios', '--json'], contract), []);
    assert.deepEqual(contractPositionals(['--json', 'android', '--', 'ios'], contract), [
      'android',
    ]);
    // adapter: false resolves the target and slot only, so a tie is never reached.
    const targetOnly = await resolveHarnessContext({ tokens: [], cwd, adapter: false });
    assert.equal(targetOnly.adapter, undefined);
    assert.deepEqual(targetOnly.slot, { value: null, source: 'none', detail: 'no-pool-dir' });
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
    assert.deepEqual(Object.keys(context).sort(), [
      'adapter',
      'runtimeConfigPath',
      'slot',
      'target',
    ]);
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

// The environment a slot port fills: the names the adapters read for it.
const watcherEnv = (port: number) => ({
  RECIPE_WATCHER_PORT: String(port),
  WATCHER_PORT: String(port),
  METRO_PORT: String(port),
});
const cdpEnv = (port: number) => ({ RECIPE_CDP_PORT: String(port), CDP_PORT: String(port) });
const viaCdp = (value: number) =>
  ({
    value,
    source: 'slot',
    filled: true,
    via: 'env',
    names: ['RECIPE_CDP_PORT', 'CDP_PORT'],
  }) as const;
const viaWatcher = (value: number) =>
  ({
    value,
    source: 'slot',
    filled: true,
    via: 'env',
    names: ['RECIPE_WATCHER_PORT', 'WATCHER_PORT', 'METRO_PORT'],
  }) as const;

describe('contextPorts', () => {
  const grammar = { '--cdp-port': {}, '--watcher-port': {}, '--json': {} };
  const slotted: HarnessContext = {
    adapter: { value: 'terminal', source: 'detect', detail: 'remote' },
    target: { value: '/w', source: 'default', detail: 'cwd' },
    slot: {
      value: 'macwork-mmt-1',
      source: 'slot',
      detail: 'slot-config',
      ports: { port: 9341, metro_port: 9441, cdp_port: 9541 },
    },
  };

  test('slot ports fill the environment the adapters read, never the argv', () => {
    assert.deepEqual(contextPorts(slotted, ['--json'], grammar, {}), {
      ports: { cdp: viaCdp(9541), watcher: viaWatcher(9341) },
      env: { ...cdpEnv(9541), ...watcherEnv(9341) },
    });
    assert.deepEqual(contextPorts(slotted, ['--cdp-port', '1234'], grammar, {}), {
      ports: { cdp: { value: 1234, source: 'flag' }, watcher: viaWatcher(9341) },
      env: watcherEnv(9341),
    });
    // A typed value the command will refuse is still the user's.
    assert.deepEqual(contextPorts(slotted, ['--cdp-port=x'], { '--cdp-port': {} }, {}), {
      ports: { cdp: { source: 'flag' } },
      env: {},
    });
  });

  test('no slot, an unknown slot, or a command without the option fills nothing', () => {
    const { slot: _slot, ...unslotted } = slotted;
    assert.deepEqual(contextPorts(unslotted, [], grammar, {}), { env: {} });
    assert.deepEqual(
      contextPorts(
        { ...slotted, slot: { value: null, source: 'none', detail: 'no-pool-dir' } },
        [],
        grammar,
        {},
      ),
      { env: {} },
    );
    assert.deepEqual(contextPorts(slotted, [], { '--json': {} }, {}), { env: {} });
  });

  test('a foreign binding fills no port', async () => {
    const extension = tempRoot();
    const mobile = tempRoot();
    useAdapters(adapter('web'));
    runtimeContext(extension, {
      platform: 'web',
      slotId: 'mmedev-1',
      repoRoot: extension,
      cdpPort: 9222,
    });
    process.env.RECIPE_RUNTIME_CONTEXT = path.join(
      extension,
      'temp/recipe/runtime/agentic-runtime.json',
    );
    const context = await resolveHarnessContext({ tokens: ['--target', mobile], cwd: extension });
    assert.deepEqual(contextPorts(context, ['--target', mobile], grammar, {}), { env: {} });
  });

  test('the human line names each port and its source', () => {
    assert.equal(
      formatHarnessContext({
        ...slotted,
        ports: {
          cdp: viaCdp(9541),
          watcher: { value: 1234, source: 'flag' },
        },
      }),
      'context: adapter terminal (detected: remote), target /w (cwd), slot macwork-mmt-1 (slot-config), ports cdp 9541 (slot), watcher 1234 (flag)',
    );
    assert.match(
      formatHarnessContext({ ...slotted, ports: { watcher: { source: 'flag' } } }),
      /ports watcher \(flag\)$/u,
    );
  });
});

describe('port fill order', () => {
  const grammar = { '--cdp-port': {}, '--watcher-port': {}, '--port': {} };
  function pooled(checkout: string): string {
    return poolDir([
      {
        id: 'macwork-mmdev-1',
        repo: checkout,
        session: 'mmdev-1',
        resources: { 'dev-server': { port: 8061, metro_port: 8062 }, browser: { cdp_port: 9541 } },
      },
    ]);
  }

  test('an explicit --runtime-dir runtime fills before the pool, in devServer, watcher, metro order', async () => {
    const checkout = tempRoot();
    useAdapters(adapter('mobile'));
    const slotPoolDir = pooled(checkout);
    write(
      checkout,
      'temp/recipe/runtime-8081/agentic-runtime.json',
      JSON.stringify({
        repoRoot: checkout,
        slotId: 'scratch-1',
        devServerPort: 8081,
        watcherPort: 8082,
        metroPort: 8083,
        cdpPort: 9222,
      }),
    );
    const tokens = ['--target', checkout, '--runtime-dir', 'temp/recipe/runtime-8081'];
    const scratch = await resolveHarnessContext({ tokens, slotPoolDir });
    // Identity and ports describe the same runtime: the scratch one.
    assert.equal(scratch.slot?.value, 'scratch-1');
    assert.equal(scratch.slot?.source, 'binding');
    assert.equal(scratch.slot?.value && scratch.slot.poolSlot, 'macwork-mmdev-1');
    assert.ok(scratch.slot?.value && scratch.slot.poolFile);
    assert.deepEqual(contextPorts(scratch, tokens, grammar, {}).env, {
      ...cdpEnv(9222),
      ...watcherEnv(8081),
    });
    // Without devServerPort the watcher port is next; the pool fills only the CDP port it lacks.
    write(
      checkout,
      'temp/recipe/runtime-8081/agentic-runtime.json',
      JSON.stringify({
        repoRoot: checkout,
        slotId: 'scratch-1',
        watcherPort: 8082,
        metroPort: 8083,
      }),
    );
    const watcherOnly = await resolveHarnessContext({ tokens, slotPoolDir });
    assert.deepEqual(contextPorts(watcherOnly, tokens, grammar, {}).env, {
      ...cdpEnv(9541),
      ...watcherEnv(8082),
    });
    // The pool alone fills its own ports, the dev-server port before metro's.
    const plain = await resolveHarnessContext({ tokens: ['--target', checkout], slotPoolDir });
    assert.equal(plain.slot?.value, 'macwork-mmdev-1');
    assert.deepEqual(contextPorts(plain, ['--target', checkout], grammar, {}).env, {
      ...cdpEnv(9541),
      ...watcherEnv(8061),
    });
  });

  test("the default runtime context keeps the pool slot's identity and lends its ports", async () => {
    const checkout = tempRoot();
    useAdapters(adapter('core'));
    runtimeContext(checkout, { repoRoot: checkout, slotId: 'local-core-x', devServerPort: 8096 });
    const tokens = ['--target', checkout];
    const context = await resolveHarnessContext({ tokens, slotPoolDir: pooled(checkout) });
    assert.equal(context.slot?.value, 'macwork-mmdev-1');
    assert.equal(context.slot?.source, 'slot');
    assert.equal(context.slot?.value && context.slot.session, 'mmdev-1');
    assert.deepEqual(contextPorts(context, tokens, grammar, {}).env, {
      ...cdpEnv(9541),
      ...watcherEnv(8096),
    });
    // Naming the default directory is not a scratch runtime either.
    const named = await resolveHarnessContext({
      tokens: [...tokens, '--runtime-dir', 'temp/recipe/runtime'],
      slotPoolDir: pooled(checkout),
    });
    assert.equal(named.slot?.value, 'macwork-mmdev-1');
  });

  test("a typed spelling is the adapter's: --port, --watcher-port and both", async () => {
    const checkout = tempRoot();
    useAdapters(adapter('mobile'));
    const context = await resolveHarnessContext({
      tokens: ['--target', checkout],
      slotPoolDir: pooled(checkout),
    });
    assert.deepEqual(contextPorts(context, ['--port', '9400'], grammar, {}), {
      ports: { cdp: viaCdp(9541), watcher: { value: 9400, source: 'flag' } },
      env: cdpEnv(9541),
    });
    // Two spellings that disagree: the handler picks, so no value is claimed.
    assert.deepEqual(
      contextPorts(context, ['--watcher-port=9405', '--port=9406'], grammar, {}).ports?.watcher,
      { source: 'flag' },
    );
    // An alias the grammar does not declare is not read.
    assert.deepEqual(
      contextPorts(context, ['--port', '9400'], { '--watcher-port': {} }, {}).env,
      watcherEnv(8061),
    );
  });

  test("a port spelled after `--` is the leaf's: that port is not filled", async () => {
    const checkout = tempRoot();
    useAdapters(adapter('mobile'));
    const context = await resolveHarnessContext({
      tokens: ['--target', checkout],
      slotPoolDir: pooled(checkout),
    });
    for (const passthrough of [
      ['--watcher-port', '9400'],
      ['--watcher-port=9400'],
      ['--port', '9400'],
      ['--metro-port=9400'],
    ]) {
      assert.deepEqual(contextPorts(context, ['--', ...passthrough], grammar, {}), {
        ports: { cdp: viaCdp(9541), watcher: { value: 9400, source: 'flag' } },
        env: cdpEnv(9541),
      });
    }
    assert.deepEqual(
      contextPorts(context, ['--', '--cdp-port', '9555'], grammar, {}).env,
      watcherEnv(8061),
    );
    // Before `--` an undeclared alias is the grammar's business, after it the leaf's.
    assert.deepEqual(
      contextPorts(context, ['--', '--port', '9400'], { '--watcher-port': {} }, {}).env,
      {},
    );
  });

  test("the user's port environment is left to the adapter, never filled", async () => {
    const checkout = tempRoot();
    useAdapters(adapter('mobile'));
    runtimeContext(checkout, {
      repoRoot: checkout,
      slotId: 'macwork-mm-1',
      watcherPort: 9300,
      cdpPort: 9222,
    });
    const tokens = ['--target', checkout];
    const context = await resolveHarnessContext({ tokens, slotPoolDir: pooled(checkout) });
    assert.deepEqual(contextPorts(context, tokens, grammar, { WATCHER_PORT: '9400' }), {
      ports: { cdp: viaCdp(9222), watcher: { value: 9400, source: 'env', filled: false } },
      env: cdpEnv(9222),
    });
    // Each name counts, in the fill's order; a flag still wins.
    assert.deepEqual(
      contextPorts(context, tokens, grammar, {
        TERMINAL_APP_PORT: '3000',
        RECIPE_WATCHER_PORT: '3001',
        WATCHER_PORT: '9400',
        RECIPE_CDP_PORT: '9554',
        CDP_PORT: '9555',
      }),
      {
        ports: {
          cdp: { value: 9554, source: 'env', filled: false },
          watcher: { value: 3000, source: 'env', filled: false },
        },
        env: {},
      },
    );
    assert.deepEqual(
      contextPorts(context, [...tokens, '--watcher-port', '7000'], grammar, { METRO_PORT: '9400' })
        .ports?.watcher,
      { value: 7000, source: 'flag' },
    );
    // An empty or non-port value holds nothing: the slot fills, and the report shows what was there.
    assert.deepEqual(
      contextPorts(context, tokens, grammar, { WATCHER_PORT: '' }).ports?.watcher,
      viaWatcher(9300),
    );
    assert.deepEqual(
      contextPorts(context, tokens, grammar, { RECIPE_WATCHER_PORT: 'abc' }).ports?.watcher,
      { ...viaWatcher(9300), invalidEnv: { name: 'RECIPE_WATCHER_PORT', value: 'abc' } },
    );
    assert.match(
      formatHarnessContext({
        ...context,
        ports: contextPorts(context, tokens, grammar, { WATCHER_PORT: '9400' }).ports ?? {},
      }),
      /ports cdp 9222 \(slot\), watcher 9400 \(env, not filled\)$/u,
    );
  });

  test('a foreign binding never fills a port, even beside a pool slot', async () => {
    const checkout = tempRoot();
    const other = tempRoot();
    useAdapters(adapter('mobile'));
    runtimeContext(other, { repoRoot: other, watcherPort: 9999, cdpPort: 9222 });
    process.env.RECIPE_RUNTIME_CONTEXT = path.join(
      other,
      'temp/recipe/runtime/agentic-runtime.json',
    );
    const tokens = ['--target', checkout];
    const context = await resolveHarnessContext({ tokens, slotPoolDir: pooled(checkout) });
    assert.equal(context.ignoredBinding?.repoRoot, other);
    assert.deepEqual(contextPorts(context, tokens, grammar, {}).env, {
      ...cdpEnv(9541),
      ...watcherEnv(8061),
    });
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

  test('ignores a conflicting context for the same target', () => {
    const checkout = tempRoot();
    useAdapters(
      adapter('web', { detect: { files: () => true } }),
      adapter('app', { detect: { files: () => true } }),
    );
    setHarnessContext({
      adapter: { value: 'app', source: 'binding', detail: 'runtime-context' },
      target: { value: checkout, source: 'default', detail: 'cwd' },
    });
    assert.throws(() => detectAdapter(checkout), AdapterAmbiguousError);
    useAdapters(adapter('web', { detect: { files: () => true } }), adapter('app'));
    assert.equal(detectAdapter(checkout), 'web');
    assert.equal(contextAdapter(checkout), 'app');
  });

  test('the task view shows only its own checkout runtime context', () => {
    const extension = tempRoot();
    const core = tempRoot();
    runtimeContext(extension, { slotId: 'mmedev-1', cdpPort: 9222, repoRoot: extension });
    process.env.RECIPE_RUNTIME_CONTEXT = path.join(
      extension,
      'temp/recipe/runtime/agentic-runtime.json',
    );
    assert.equal(collectTaskView(core, undefined, Date.now()).isolation, undefined);
    const own = collectTaskView(extension, undefined, Date.now()).isolation;
    assert.deepEqual([own?.slotId, own?.cdpPort], ['mmedev-1', 9222]);
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
