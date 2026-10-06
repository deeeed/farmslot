// recipe-library.json `adapters`: lazy loading on selection, `extends`
// composition, the host's adopt hook, `--adapter` choices, and the refusals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  ADAPTER_SDK_VERSION,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';

import {
  adapterChoices,
  adapterPlugin,
  adapterPluginChecks,
  AdapterPluginError,
  adapterSelectionFailureOut,
  composeAdapter,
  configureHarnessAdapters,
  configureHarnessHost,
  declaredAdapterIds,
  ensureAdapterLoaded,
  harnessAdapter,
  harnessAdapters,
  harnessHost,
  resolveLiveAdapter,
  selectedAdapterId,
} from '../src/harness/index.js';
import { candidatePaths } from '../src/harness/live-adapter-contract.js';

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

// A library whose plugins each live in their own directory, plugins/<id>/index.mjs,
// with extra files written relative to the library root.
function dirLibrary(
  name: string,
  adapters: Record<string, { source: string; extends?: string }>,
  files: Record<string, string> = {},
): string {
  const root = tempRoot(`recipe-cli-plugins-${name}-`);
  const declared: Record<string, Record<string, string>> = {};
  for (const [id, entry] of Object.entries(adapters)) {
    fs.mkdirSync(path.join(root, 'plugins', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins', id, 'index.mjs'), entry.source);
    declared[id] = {
      module: `./plugins/${id}/index.mjs`,
      export: 'adapter',
      ...(entry.extends ? { extends: entry.extends } : {}),
    };
  }
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  fs.writeFileSync(path.join(root, 'recipe-library.json'), JSON.stringify({ adapters: declared }));
  return root;
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

  test('refuses an extends cycle', async () => {
    process.env.RECIPE_LIBRARY_PATH = `lib=${library('cycle', {
      a: { source: pluginSource('a'), extends: 'b' },
      b: { source: pluginSource('b'), extends: 'a' },
    })}`;
    const error = await refusal('a');
    assert.equal(error.code, 'ADAPTER_EXTENDS_UNKNOWN');
    assert.match(error.message, /extends itself through a → b → a/u);
    assert.deepEqual(imports(), []);
  });

  test('a --library entry replaces the RECIPE_LIBRARY_PATH entry of the same name', async () => {
    const declaring = library('env', { echo: { source: pluginSource('echo') } });
    const empty = tempRoot('recipe-cli-plugins-empty-');
    process.env.RECIPE_LIBRARY_PATH = `plug=${declaring}`;
    assert.ok(adapterChoices().includes('echo'));
    assert.deepEqual(adapterChoices([`plug=${empty}`]), ['core']);
    await ensureAdapterLoaded('echo', { libraries: [`plug=${empty}`] });
    assert.deepEqual(imports(), []);
  });

  test('host-configured libraries follow the others, and an earlier name wins', async () => {
    const configured = library('cfg', { echo: { source: pluginSource('echo') } });
    const shadow = tempRoot('recipe-cli-plugins-shadow-');
    delete process.env.RECIPE_LIBRARY_PATH;
    const sources = [{ name: 'cfg', root: configured }];
    assert.deepEqual(declaredAdapterIds(sources), ['echo']);
    assert.ok(adapterChoices([], { configured: sources }).includes('echo'));
    // A --library entry of the same name shadows the configured one.
    assert.deepEqual(adapterChoices([`cfg=${shadow}`], { configured: sources }), ['core']);
    await ensureAdapterLoaded('echo', { configured: sources });
    assert.ok(harnessAdapters().has('echo'));
  });

  test('a library that is not configured declares nothing, wherever it sits', async () => {
    // A task-local library beside a recipe is not an operator library.
    const task = tempRoot('recipe-cli-plugins-task-');
    const local = path.join(task, 'recipe-library');
    fs.mkdirSync(path.join(local, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(local, 'plugins', 'tasky.mjs'), pluginSource('tasky'));
    fs.writeFileSync(
      path.join(local, 'recipe-library.json'),
      JSON.stringify({ adapters: { tasky: { module: './plugins/tasky.mjs', export: 'adapter' } } }),
    );
    fs.writeFileSync(path.join(task, 'recipe.json'), '{}');
    process.env.RECIPE_LIBRARY_PATH = `other=${tempRoot('recipe-cli-plugins-other-')}`;
    assert.deepEqual(adapterChoices(), ['core']);
    await ensureAdapterLoaded('tasky');
    assert.equal(harnessAdapters().has('tasky'), false);
    assert.deepEqual(imports(), []);
  });

  test('selects the last --adapter, else the last --platform, before any --', () => {
    assert.equal(selectedAdapterId(['--adapter', 'core', '--adapter', 'echo']), 'echo');
    assert.equal(selectedAdapterId(['--adapter=echo', '--adapter', 'core']), 'core');
    assert.equal(selectedAdapterId(['--platform', 'echo', '--platform', 'core']), 'core');
    assert.equal(selectedAdapterId(['--platform', 'echo', '--adapter', 'core']), 'core');
    assert.equal(selectedAdapterId(['--adapter', 'core', '--', '--adapter', 'echo']), 'core');
    assert.equal(selectedAdapterId(['run', 'x']), undefined);
  });

  test("a plugin's digest covers its directory and its parent, and doctor names it", async () => {
    const root = library('plug', {
      echo: { source: pluginSource('echo') },
      'echo-child': { source: pluginSource('echo-child'), extends: 'echo' },
    });
    process.env.RECIPE_LIBRARY_PATH = `plug=${root}`;
    await ensureAdapterLoaded('echo-child');
    const parent = adapterPlugin('echo');
    const child = adapterPlugin('echo-child');
    assert.match(parent?.digest ?? '', /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(
      { library: child?.library, module: child?.module, extends: child?.extends },
      { library: 'plug', module: './plugins/echo-child.mjs', extends: 'echo' },
    );
    assert.deepEqual(
      adapterPluginChecks().map((check) => [check.id, check.status, check.required]),
      [
        ['adapter-plugin:echo', 'pass', false],
        ['adapter-plugin:echo-child', 'pass', false],
      ],
    );
    assert.match(adapterPluginChecks()[1]!.message, /library plug .*sha256:/u);

    // A helper beside the module moves the digest, and the child's with it.
    fs.writeFileSync(path.join(root, 'plugins', 'helper.mjs'), 'export const changed = 1;\n');
    configureHarnessAdapters(createAdapterRegistry());
    harnessAdapters().register(builtin('core'));
    await ensureAdapterLoaded('echo-child');
    assert.notEqual(adapterPlugin('echo')?.digest, parent?.digest);
    assert.notEqual(adapterPlugin('echo-child')?.digest, child?.digest);
  });

  test("a child's digest folds in its parent's, even in separate directories", async () => {
    const root = dirLibrary('split', {
      echo: { source: pluginSource('echo') },
      'echo-child': { source: pluginSource('echo-child'), extends: 'echo' },
    });
    process.env.RECIPE_LIBRARY_PATH = `split=${root}`;
    await ensureAdapterLoaded('echo-child');
    const child = adapterPlugin('echo-child')?.digest;
    // Only the parent's directory changes; the child's files don't.
    fs.writeFileSync(path.join(root, 'plugins', 'echo', 'helper.mjs'), 'export const h = 1;\n');
    configureHarnessAdapters(createAdapterRegistry());
    harnessAdapters().register(builtin('core'));
    await ensureAdapterLoaded('echo-child');
    assert.notEqual(adapterPlugin('echo-child')?.digest, child);
  });

  test('a plugin imports from disk only the files its digest covers', async () => {
    const importing = (specifier: string) =>
      pluginSource('echo').replace(
        'export const adapter = {',
        `import ${JSON.stringify(specifier)};\nexport const adapter = {`,
      );
    const cases: Array<[string, Record<string, string>]> = [
      ['../../lib/helper.mjs', { 'lib/helper.mjs': 'export const h = 1;\n' }],
      ['../../node_modules/dep/index.mjs', { 'node_modules/dep/index.mjs': 'export {};\n' }],
    ];
    for (const [specifier, files] of cases) {
      process.env.RECIPE_LIBRARY_PATH = `fence=${dirLibrary('fence', { echo: { source: importing(specifier) } }, files)}`;
      configureHarnessAdapters(createAdapterRegistry());
      const error = await refusal('echo');
      assert.equal(error.code, 'RECIPE_SOURCE_INVALID', `${specifier}: ${error.message}`);
      assert.match(error.message, /outside the files its digest covers/u);
    }
    // Its own directory, actions/ and builtins are fine.
    process.env.RECIPE_LIBRARY_PATH = `fence=${dirLibrary(
      'fence',
      {
        echo: {
          source: importing('./helper.mjs').replace(
            'import "./helper.mjs";',
            'import "./helper.mjs"; import "../../actions/shared.mjs"; import "node:fs";',
          ),
        },
      },
      { 'plugins/echo/helper.mjs': 'export {};\n', 'actions/shared.mjs': 'export {};\n' },
    )}`;
    configureHarnessAdapters(createAdapterRegistry());
    await ensureAdapterLoaded('echo');
    assert.ok(harnessAdapters().has('echo'));
    // A symlinked directory in the plugin's directory is refused before any import.
    const linked = dirLibrary(
      'linked',
      { echo: { source: pluginSource('echo') } },
      {
        'lib/helper.mjs': 'export {};\n',
      },
    );
    fs.symlinkSync('../../lib', path.join(linked, 'plugins', 'echo', 'shared'));
    process.env.RECIPE_LIBRARY_PATH = `linked=${linked}`;
    configureHarnessAdapters(createAdapterRegistry());
    (globalThis as Record<string, unknown>).__pluginImports = [];
    assert.equal((await refusal('echo')).code, 'RECIPE_SOURCE_INVALID');
    assert.deepEqual(imports(), []);
  });

  const importing = (specifier: string) =>
    pluginSource('echo').replace(
      'export const adapter = {',
      `import ${JSON.stringify(specifier)};\nexport const adapter = {`,
    );

  // A package directory: <dir>/package.json and index.mjs.
  function writePackage(dir: string, name: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.mjs' }));
    fs.writeFileSync(path.join(dir, 'index.mjs'), 'export {};\n');
  }

  // Run `body` with the host's package root at `packageRoot`.
  async function withHostAt(packageRoot: string, body: () => Promise<void>): Promise<void> {
    const host = harnessHost();
    configureHarnessHost({ ...host, packageRoot });
    configureHarnessAdapters(createAdapterRegistry());
    try {
      await body();
    } finally {
      configureHarnessHost(host);
    }
  }

  test("bare packages resolve from the host's install, never from the library's location", async () => {
    // The host's package loads from a library outside the host's tree.
    process.env.RECIPE_LIBRARY_PATH = `sdk=${dirLibrary('sdk', { echo: { source: importing('@farmslot/adapter-sdk') } })}`;
    await ensureAdapterLoaded('echo');
    assert.ok(harnessAdapters().has('echo'));

    // A package in a node_modules above the library, which the host doesn't install.
    const above = tempRoot('recipe-cli-plugins-above-');
    writePackage(path.join(above, 'node_modules', 'above-dep'), 'above-dep');
    const nested = path.join(above, 'lib');
    fs.renameSync(dirLibrary('nested', { echo: { source: importing('above-dep') } }), nested);
    process.env.RECIPE_LIBRARY_PATH = `nested=${nested}`;
    configureHarnessAdapters(createAdapterRegistry());
    const error = await refusal('echo');
    assert.equal(error.code, 'RECIPE_SOURCE_INVALID');
    assert.match(error.message, /the host's install does not provide/u);
  });

  test("a library inside the host's project imports the host's own dependencies", async () => {
    // The product-repo layout: the host installed in <repo>/node_modules, the
    // library a folder of the same repo. <repo>/node_modules is on the host's
    // lookup chain, so it is the host's install, not a stray package above the library.
    const repo = tempRoot('recipe-cli-plugins-repo-');
    writePackage(path.join(repo, 'node_modules', '@scope', 'host'), '@scope/host');
    writePackage(path.join(repo, 'node_modules', 'hostdep'), 'hostdep');
    const library = path.join(repo, 'recipe-library');
    fs.renameSync(dirLibrary('repo', { echo: { source: importing('hostdep') } }), library);
    process.env.RECIPE_LIBRARY_PATH = `repo=${library}`;
    await withHostAt(path.join(repo, 'node_modules', '@scope', 'host'), async () => {
      await ensureAdapterLoaded('echo');
      assert.ok(harnessAdapters().has('echo'));
    });
  });

  test("a library at the repo root holds the host's node_modules, so its packages are refused", async () => {
    // Layout D: the library is the repo itself, so <repo>/node_modules is inside the
    // library root, where no digest covers it. Keep the library in a folder instead.
    const repo = dirLibrary('rootlib', { echo: { source: importing('hostdep') } });
    writePackage(path.join(repo, 'node_modules', '@scope', 'host'), '@scope/host');
    writePackage(path.join(repo, 'node_modules', 'hostdep'), 'hostdep');
    process.env.RECIPE_LIBRARY_PATH = `rootlib=${repo}`;
    await withHostAt(path.join(repo, 'node_modules', '@scope', 'host'), async () => {
      const error = await refusal('echo');
      assert.equal(error.code, 'RECIPE_SOURCE_INVALID');
      assert.match(error.message, /beside or above the library/u);
    });
  });

  test("a node_modules above the library but off the host's lookup chain is refused, even when the host links to it", async () => {
    // The host's resolution reaches the package only through a symlink in its own
    // node_modules; the real files sit above the library, where no digest covers them.
    const above = tempRoot('recipe-cli-plugins-stray-');
    writePackage(path.join(above, 'node_modules', 'stray'), 'stray');
    const library = path.join(above, 'lib');
    fs.renameSync(dirLibrary('stray', { echo: { source: importing('stray') } }), library);
    const hostRoot = path.join(tempRoot('recipe-cli-plugins-host-'), 'host');
    writePackage(hostRoot, 'host');
    fs.mkdirSync(path.join(hostRoot, 'node_modules'));
    fs.symlinkSync(
      path.join(above, 'node_modules', 'stray'),
      path.join(hostRoot, 'node_modules', 'stray'),
    );
    process.env.RECIPE_LIBRARY_PATH = `stray=${library}`;
    await withHostAt(hostRoot, async () => {
      const error = await refusal('echo');
      assert.equal(error.code, 'RECIPE_SOURCE_INVALID');
      assert.match(error.message, /beside or above the library/u);
    });
  });

  test('an actions/ file is fenced when plugin code reaches it, not when the host imports it', async () => {
    const root = dirLibrary(
      'shared',
      {
        echo: {
          source: pluginSource('echo').replace(
            'export const adapter = {',
            "import '../../actions/reached.mjs';\nexport const adapter = {",
          ),
        },
      },
      {
        'actions/reached.mjs': "import '../lib/outside.mjs';\n",
        'actions/host-only.mjs': "export { outside } from '../lib/outside.mjs';\n",
        'lib/outside.mjs': 'export const outside = 1;\n',
      },
    );
    process.env.RECIPE_LIBRARY_PATH = `shared=${root}`;
    // Through the plugin, actions/reached.mjs may not import outside the digest.
    const error = await refusal('echo');
    assert.equal(error.code, 'RECIPE_SOURCE_INVALID');
    assert.match(error.message, /imports \.\.\/lib\/outside\.mjs/u);
    // The host importing an actions/ file by itself is not plugin code.
    const hostImport = (await import(
      pathToFileURL(path.join(root, 'actions', 'host-only.mjs')).href
    )) as {
      outside: number;
    };
    assert.equal(hostImport.outside, 1);
  });

  test('plugin code that imports later, while it runs, is fenced too', async () => {
    const root = dirLibrary(
      'late',
      {
        echo: {
          source: pluginSource('echo').replace(
            'async execute() { return { output: {} }; }',
            "async execute() { return { output: await import('../../lib/late.mjs') }; }",
          ),
        },
      },
      { 'lib/late.mjs': 'export const late = 1;\n' },
    );
    process.env.RECIPE_LIBRARY_PATH = `late=${root}`;
    await ensureAdapterLoaded('echo');
    const [ping] = (await harnessAdapter('echo').actions.adapters?.()) ?? [];
    await assert.rejects(
      ping!.execute({}, {} as Parameters<typeof ping.execute>[1]),
      /outside the files its digest covers/u,
    );
  });

  test("only the operator's environment declares plugins, for choices and loading", async () => {
    const root = library('hydrated', { echo: { source: pluginSource('echo') } });
    // The host's discovery extended process.env; the operator started with none.
    process.env.RECIPE_LIBRARY_PATH = `hydrated=${root}`;
    const operator = { ...process.env, RECIPE_LIBRARY_PATH: '' };
    assert.deepEqual(adapterChoices([], { env: operator }).includes('echo'), false);
    await ensureAdapterLoaded('echo', { env: operator });
    assert.equal(harnessAdapters().has('echo'), false);
    assert.deepEqual(imports(), []);
    // A library the hydrated env adds may not claim a built-in either way.
    process.env.RECIPE_LIBRARY_PATH = `hydrated=${library('claim', { core: { source: pluginSource('core') } })}`;
    await ensureAdapterLoaded('core', { env: operator });
  });

  test("live scripts: a child adapter finds its parents' scripts, child first, then shared", async () => {
    harnessAdapters().register(builtin('web-dapp'));
    harnessAdapters().register({ ...builtin('terminal'), extends: 'web-dapp' } as PlatformAdapter);
    harnessAdapters().register({ ...builtin('kiosk'), extends: 'terminal' } as PlatformAdapter);
    const root = tempRoot('recipe-cli-live-chain-');
    const env = { RECIPE_ACTION_SOURCE_MAP: JSON.stringify({ 'team.probe': root }) };
    const script = (platform: string) => {
      const file = path.join(root, platform, 'team', 'probe.mjs');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'export default {};\n');
      return file;
    };
    const resolve = (platform: string) => resolveLiveAdapter(platform, 'team.probe', 'shop', env);

    const shared = script('shared');
    const parent = script('web-dapp');
    // A child finds its parent's script before the shared one.
    assert.equal(await resolve('terminal'), parent);
    // Two levels: the grandparent's script, through the parent.
    assert.equal(await resolve('kiosk'), parent);
    // The child's own script wins; a grandchild reaches its nearest ancestor's.
    const child = script('terminal');
    assert.equal(await resolve('terminal'), child);
    assert.equal(await resolve('kiosk'), child);
    assert.equal(await resolve('web-dapp'), parent);
    // A built-in that extends nothing is unchanged: its own script, else shared.
    assert.equal(await resolve('core'), shared);
  });

  test("live scripts: every one of a child's files comes before its parent's", async () => {
    harnessAdapters().register(builtin('echo'));
    harnessAdapters().register({ ...builtin('echo-child'), extends: 'echo' } as PlatformAdapter);
    const action = 'metamask.app.launch';
    const write = (root: string, file: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'export default {};\n');
      return path.join(root, file);
    };
    const resolveIn = (root: string) =>
      resolveLiveAdapter('echo-child', action, 'metamask', {
        RECIPE_ACTION_SOURCE_MAP: JSON.stringify({ [action]: root }),
      });
    // The child's short name beats the parent's qualified name.
    const short = tempRoot('recipe-cli-live-short-');
    write(short, 'echo/app/metamask.app.launch.mjs');
    const childShort = write(short, 'echo-child/app/launch.mjs');
    assert.equal(await resolveIn(short), childShort);
    // The child's dispatcher beats the parent's short name.
    const dispatcher = tempRoot('recipe-cli-live-dispatcher-');
    write(dispatcher, 'echo/app/launch.mjs');
    const childDispatcher = write(dispatcher, 'echo-child/app/app.mjs');
    assert.equal(await resolveIn(dispatcher), childDispatcher);
  });

  test('live scripts: a built-in tries the same files, in the same order, as before extends', () => {
    // The list a built-in got before live scripts followed `extends`.
    assert.deepEqual(
      candidatePaths('core', 'metamask.app.launch', 'metamask', {
        RECIPE_ACTION_SOURCE_MAP: JSON.stringify({ 'metamask.app.launch': '/R' }),
      }),
      [
        '/R/core/app/metamask.app.launch.mjs',
        '/R/shared/app/metamask.app.launch.mjs',
        '/R/core/app/launch.mjs',
        '/R/shared/app/launch.mjs',
        '/R/core/app/app.mjs',
        '/R/shared/app/app.mjs',
      ],
    );
  });

  test('live scripts: an extends cycle between registered adapters ends', async () => {
    harnessAdapters().register({ ...builtin('loop-a'), extends: 'loop-b' } as PlatformAdapter);
    harnessAdapters().register({ ...builtin('loop-b'), extends: 'loop-a' } as PlatformAdapter);
    const root = tempRoot('recipe-cli-live-cycle-');
    const env = { RECIPE_ACTION_SOURCE_MAP: JSON.stringify({ 'team.probe': root }) };
    assert.equal(await resolveLiveAdapter('loop-a', 'team.probe', 'shop', env), null);
    const file = path.join(root, 'loop-b', 'team', 'probe.mjs');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export default {};\n');
    assert.equal(await resolveLiveAdapter('loop-a', 'team.probe', 'shop', env), file);
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
