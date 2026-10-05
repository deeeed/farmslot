// recipe-library.json `adapters`: lazy loading on selection, `extends`
// composition, the host's adopt hook, `--adapter` choices, and the refusals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  ADAPTER_SDK_VERSION,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';

import {
  adapterChoices,
  AdapterPluginError,
  adapterSelectionFailureOut,
  composeAdapter,
  configureHarnessAdapters,
  ensureAdapterLoaded,
  harnessAdapter,
  harnessAdapters,
} from '../src/harness/index.js';

const roots: string[] = [];
const savedLibraryPath = process.env.RECIPE_LIBRARY_PATH;
const imports = (): string[] =>
  ((globalThis as Record<string, unknown>).__pluginImports as string[] | undefined) ?? [];

function tempRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

// A plugin module: a complete headless adapter with an extra doctor check and one
// in-code action, recording its import.
function pluginSource(id: string, extra = ''): string {
  return `globalThis.__pluginImports = [...(globalThis.__pluginImports ?? []), '${id}'];
export const adapter = {
  id: '${id}',
  sdkVersion: 1,
  headless: true,
  resolveSlotPorts() {},
  async runtimeStatus() { return { decision: 'ready', reasons: [] }; },
  devServer: { label: 'none', describe: () => 'none', stop: () => ({ kind: 'none' }) },
  logSources: () => [],
  appLogSource: () => null,
  hints: { launch: 'launch', relaunch: 'launch', runtimeProbeRecovery: () => 'doctor' },
  actions: {
    manifestPath: () => '/manifests/${id}.json',
    semantic: [],
    cdpTarget: { transport: 'none', probePath: '/' },
    async adapters() { return [{ action: '${id}.ping', async execute() { return { output: {} }; } }]; },
  },
  harness: { install: { entry: 'i', fallback: 'i' }, cleanup: { entry: 'c', fallback: 'c' }, verify: () => ({ error: 'none' }) },
  runtimeContext: { forbiddenFields: [] },
  async launch() { return 0; },
  async doctor() { return [{ id: '${id}-ready', status: 'pass', required: true, message: 'ok' }]; },
  ${extra}
};
`;
}

// A library declaring `adapters`, with one module file per entry.
function library(
  name: string,
  adapters: Record<string, { source: string; export?: string; extends?: string }>,
): string {
  const root = tempRoot(`recipe-cli-plugins-${name}-`);
  const declared: Record<string, Record<string, string>> = {};
  for (const [id, entry] of Object.entries(adapters)) {
    const file = `plugins/${id}.mjs`;
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, file), entry.source);
    declared[id] = {
      module: `./${file}`,
      export: entry.export ?? 'adapter',
      ...(entry.extends ? { extends: entry.extends } : {}),
    };
  }
  fs.writeFileSync(path.join(root, 'recipe-library.json'), JSON.stringify({ adapters: declared }));
  return root;
}

function builtin(id: string): PlatformAdapter {
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
  } as PlatformAdapter;
}

async function refusal(id: string): Promise<{ code: string; message: string }> {
  try {
    await ensureAdapterLoaded(id);
  } catch (error) {
    return error as { code: string; message: string };
  }
  assert.fail(`selecting ${id} should be refused`);
}

beforeEach(() => {
  const registry = createAdapterRegistry();
  registry.register(builtin('core'));
  configureHarnessAdapters(registry);
  (globalThis as Record<string, unknown>).__pluginImports = [];
});

afterEach(() => {
  configureHarnessAdapters(createAdapterRegistry());
  if (savedLibraryPath === undefined) delete process.env.RECIPE_LIBRARY_PATH;
  else process.env.RECIPE_LIBRARY_PATH = savedLibraryPath;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('adapter plugins', () => {
  test('load only when selected, compose on extends, and register with the built-ins', async () => {
    const root = library('plug', {
      echo: { source: pluginSource('echo') },
      'echo-child': { source: pluginSource('echo-child'), extends: 'echo' },
    });
    process.env.RECIPE_LIBRARY_PATH = `plug=${root}`;
    assert.deepEqual(adapterChoices(), ['core', 'echo', 'echo-child']);
    await ensureAdapterLoaded('core');
    await ensureAdapterLoaded(undefined);
    await ensureAdapterLoaded('nope');
    assert.deepEqual(imports(), []);

    await ensureAdapterLoaded('echo-child');
    assert.deepEqual(imports().sort(), ['echo', 'echo-child']);
    assert.deepEqual(harnessAdapters().list(), ['core', 'echo', 'echo-child']);
    const child = harnessAdapter('echo-child');
    assert.equal(child.extends, 'echo');
    assert.deepEqual(child.actions.manifestPaths?.(), [
      '/manifests/echo.json',
      '/manifests/echo-child.json',
    ]);
    assert.deepEqual(
      (await child.actions.adapters?.())?.map((adapter) => adapter.action),
      ['echo.ping', 'echo-child.ping'],
    );
    assert.deepEqual(
      (await child.doctor?.('/t'))?.map((check) => check.id),
      ['echo-ready', 'echo-child-ready'],
    );
    // A second selection is a no-op.
    await ensureAdapterLoaded('echo-child');
    assert.equal(imports().length, 2);
  });

  test('a child replaces the parent members it declares', () => {
    const parent = builtin('web');
    const child = {
      id: 'shop',
      sdkVersion: ADAPTER_SDK_VERSION,
      headless: false,
      hints: { launch: 'shop', relaunch: 'shop', runtimeProbeRecovery: () => 'shop' },
    } as unknown as PlatformAdapter;
    const composed = composeAdapter(parent, child);
    assert.equal(composed.id, 'shop');
    assert.equal(composed.headless, false);
    assert.equal(composed.hints.launch, 'shop');
    assert.equal(composed.devServer, parent.devServer);
    assert.deepEqual(composed.actions.manifestPaths?.(), ['/manifests/web.json']);
  });

  test('the host adopts a plugin before it registers', async () => {
    process.env.RECIPE_LIBRARY_PATH = `plug=${library('plug', { echo: { source: pluginSource('echo') } })}`;
    await ensureAdapterLoaded('echo', {
      adopt: (adapter) => ({ ...adapter, hostOnly: true }) as PlatformAdapter,
    });
    assert.equal((harnessAdapter('echo') as unknown as { hostOnly: boolean }).hostOnly, true);
  });

  test('a declaration in a --library entry is found too', async () => {
    const root = library('flagged', { echo: { source: pluginSource('echo') } });
    delete process.env.RECIPE_LIBRARY_PATH;
    assert.ok(adapterChoices([`flagged=${root}`]).includes('echo'));
    await ensureAdapterLoaded('echo', { libraries: [`flagged=${root}`] });
    assert.ok(harnessAdapters().has('echo'));
  });

  test('refuses bad plugins with a code, and keeps other adapters working', async () => {
    const cases: Array<[string, string, Record<string, Parameters<typeof library>[1][string]>]> = [
      [
        'ADAPTER_SDK_UNSUPPORTED',
        'echo',
        { echo: { source: pluginSource('echo').replace('sdkVersion: 1', 'sdkVersion: 2') } },
      ],
      [
        'ADAPTER_PLUGIN_INVALID',
        'echo',
        { echo: { source: pluginSource('echo'), export: 'nope' } },
      ],
      ['ADAPTER_PLUGIN_INVALID', 'other', { other: { source: pluginSource('echo') } }],
      [
        'ADAPTER_PLUGIN_INVALID',
        'echo',
        { echo: { source: pluginSource('echo').replace('async launch() { return 0; },', '') } },
      ],
      [
        'ADAPTER_PLUGIN_LOAD_FAILED',
        'boom',
        { boom: { source: "throw new Error('boom plugin failed to load');" } },
      ],
      ['ADAPTER_ID_CONFLICT', 'core', { core: { source: pluginSource('core') } }],
      [
        'ADAPTER_EXTENDS_UNKNOWN',
        'child',
        { child: { source: pluginSource('child'), extends: 'missing' } },
      ],
    ];
    for (const [code, id, adapters] of cases) {
      process.env.RECIPE_LIBRARY_PATH = `lib=${library(id, adapters)}`;
      const error = await refusal(id);
      assert.ok(error instanceof AdapterPluginError, `${code}: ${String(error)}`);
      assert.equal(error.code, code, error.message);
      assert.ok(harnessAdapters().has('core'));
    }
    process.env.RECIPE_LIBRARY_PATH = `lib=${library('boom', {
      boom: { source: "throw new Error('boom plugin failed to load');" },
    })}`;
    assert.match((await refusal('boom')).message, /boom plugin failed to load/u);
    await ensureAdapterLoaded('core');
  });

  test('refuses an id two libraries declare', async () => {
    const one = library('one', { echo: { source: pluginSource('echo') } });
    const two = library('two', { echo: { source: pluginSource('echo') } });
    process.env.RECIPE_LIBRARY_PATH = `one=${one}:two=${two}`;
    assert.equal((await refusal('echo')).code, 'ADAPTER_ID_CONFLICT');
    assert.deepEqual(imports(), []);
  });

  test('refuses a module outside its library before importing it', async () => {
    const outside = tempRoot('recipe-cli-plugins-outside-');
    fs.writeFileSync(path.join(outside, 'echo.mjs'), pluginSource('echo'));
    const root = tempRoot('recipe-cli-plugins-escape-');
    fs.symlinkSync(path.join(outside, 'echo.mjs'), path.join(root, 'echo.mjs'));
    fs.writeFileSync(
      path.join(root, 'recipe-library.json'),
      JSON.stringify({ adapters: { echo: { module: './echo.mjs', export: 'adapter' } } }),
    );
    process.env.RECIPE_LIBRARY_PATH = `escape=${root}`;
    assert.equal((await refusal('echo')).code, 'RECIPE_SOURCE_INVALID');
    assert.deepEqual(imports(), []);
    // A built-in never fails on another library's error.
    await ensureAdapterLoaded('core');
  });

  test('prints a refusal as the --json envelope or the human line', () => {
    const out: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (line: string) => out.push(line);
    console.error = (line: string) => out.push(line);
    try {
      const refused = new AdapterPluginError('ADAPTER_ID_CONFLICT', 'taken', 'rename it');
      assert.equal(adapterSelectionFailureOut(true, 'actions', refused), 2);
      assert.equal(adapterSelectionFailureOut(false, 'actions', refused), 2);
    } finally {
      console.log = log;
      console.error = error;
    }
    assert.deepEqual(JSON.parse(out[0]!), {
      schemaVersion: 1,
      command: 'actions',
      status: 'fail',
      exitCode: 2,
      error: { code: 'ADAPTER_ID_CONFLICT', message: 'taken', userAction: 'rename it' },
    });
    assert.match(out[1]!, /actions: taken\n {2}Next: rename it$/u);
  });
});
