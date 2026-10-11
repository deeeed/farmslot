import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { createAdapterRegistry } from '@farmslot/adapter-sdk';
import type { ProjectConfig } from '@farmslot/protocol';

import { configureHarnessAdapters, harnessAdapters } from '../src/harness/adapters.js';
import { loadProjectProvider, resolveProjectContext } from '../src/harness/context.js';
import {
  inputSourceSnapshot,
  providerSourceSnapshot,
  sourceSnapshot,
} from '../src/harness/execution-provenance.js';
import { configureHarnessHost, harnessHost } from '../src/harness/host.js';

const roots: string[] = [];
const savedHost = harnessHost();
const savedEnv = { ...process.env };
const globals = globalThis as typeof globalThis & {
  bindingImports?: number;
  bindingHost?: unknown;
  bindingLibraries?: unknown[];
};

function root(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-binding-')));
  roots.push(directory);
  return directory;
}

function write(directory: string, file: string, value: string): void {
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), value);
}

function project(directory: string, extra: Partial<ProjectConfig> = {}): ProjectConfig {
  const config = {
    name: 'headless',
    repoUrl: '',
    paths: { runtimeDir: '.runtime', artifactDir: 'artifacts' },
    recipe: { provider: { module: 'provider.mjs' }, adapter: 'headless' },
    ...extra,
  } as ProjectConfig;
  write(directory, 'project.json', JSON.stringify(config));
  write(
    directory,
    'provider.mjs',
    `
    globalThis.bindingImports = (globalThis.bindingImports ?? 0) + 1;
    export const providerHost = {
      name: 'original', product: 'fixture', envPrefix: 'FIXTURE', recipeEnvPrefix: 'FIXTURE_RECIPE',
      packageName: 'fixture-provider', packageRoot: ${JSON.stringify(directory)}, bin: 'bin/fixture'
    };
    export function createProvider(context) {
      globalThis.bindingHost = context.host;
      globalThis.bindingLibraries = context.libraries;
      return { runtime: {
        id: 'headless', sdkVersion: 1, headless: true, targets: ['node'],
        runtimeStatus: async () => ({decision:'ready',reasons:[]}),
        resolveSlotPorts() {}, logSources: () => [], appLogSource: () => null,
        launch: async () => 0, devServer: {}, hints: {}, harness: {}, runtimeContext: {},
        actions: {manifestPath: () => 'actions.json',semantic:[],cdpTarget:{transport:'none'}}
      }, cancel: async () => {}, finalize: async () => {} };
    }
  `,
  );
  return config;
}

beforeEach(() => {
  configureHarnessAdapters(createAdapterRegistry());
  delete process.env.RECIPE_RUNTIME_CONTEXT;
  delete process.env.RECIPE_RUNTIME_DIR;
  delete process.env.FARMSLOT_POOL_DIR;
  delete process.env.FARMSLOT_ROOT;
  delete process.env.RECIPE_LIBRARY_PATH;
  globals.bindingImports = 0;
});

afterEach(() => {
  configureHarnessAdapters(createAdapterRegistry());
  configureHarnessHost(savedHost);
  process.env = { ...savedEnv };
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  delete globals.bindingImports;
  delete globals.bindingHost;
  delete globals.bindingLibraries;
});

test('discovery reads metadata without importing provider or task code', async () => {
  const directory = root();
  project(directory);
  write(directory, 'task-code.mjs', 'throw new Error("task code must not load");');
  const context = await resolveProjectContext({ tokens: [], cwd: directory, load: { env: {} } });
  assert.equal(context.project?.provider.authority, 'discovered');
  assert.equal(globals.bindingImports, 0);
  await assert.rejects(loadProjectProvider(context), { code: 'PROVIDER_UNAUTHORIZED' });
  assert.equal(globals.bindingImports, 0);
});

test('configured headless provider loads and registers with provider host paths', async () => {
  const directory = root();
  const config = project(directory);
  const context = await resolveProjectContext({
    tokens: [],
    cwd: directory,
    projects: [{ config, root: directory }],
    load: { env: {} },
  });
  assert.equal(globals.bindingImports, 0);
  const provider = await loadProjectProvider(context, { command: 'doctor' });
  assert.equal(provider.runtime.headless, true);
  assert.equal(harnessAdapters().get('headless'), provider.runtime);
  assert.equal((await provider.runtime.runtimeStatus(directory)).decision, 'ready');
  assert.equal(typeof provider.cancel, 'function');
  assert.equal(typeof provider.finalize, 'function');
  assert.equal(harnessHost().name, 'farmslot recipe');
  assert.equal(harnessHost().recipeEnvPrefix, 'FIXTURE_RECIPE');
  assert.equal(harnessHost().packageRoot, directory);
});

test('installed provider package is authorized independently of discovered checkout metadata', async () => {
  const directory = root();
  project(directory);
  const code = fs.readFileSync(path.join(directory, 'provider.mjs'), 'utf8');
  write(
    directory,
    'node_modules/installed-provider/package.json',
    JSON.stringify({ name: 'installed-provider', version: '1.0.0', exports: './index.mjs' }),
  );
  write(directory, 'node_modules/installed-provider/index.mjs', code);
  project(directory, {
    recipe: {
      adapter: 'headless',
      provider: { module: 'installed-provider', package: 'installed-provider' },
    },
  });
  const context = await resolveProjectContext({ tokens: [], cwd: directory, load: { env: {} } });
  assert.equal(context.project?.provider.authority, 'installed');
  assert.equal(context.project?.provider.version, '1.0.0');
  const provider = await loadProjectProvider(context);
  assert.equal(provider.runtime.headless, true);
});

test('operator authorization loads discovered provider without authorizing discovered libraries', async () => {
  const directory = root();
  fs.mkdirSync(path.join(directory, 'team'));
  project(directory, {
    recipe: {
      adapter: 'headless',
      provider: { module: 'provider.mjs' },
      libraries: [{ name: 'team', source: 'team', owner: 'team' }],
    },
  });
  const context = await resolveProjectContext({ tokens: [], cwd: directory, load: { env: {} } });
  if (context.project?.libraries[0]) context.project.libraries[0].origin = 'flag';
  await loadProjectProvider(context, { authorizedProviders: ['provider.mjs'] });
  assert.equal(globals.bindingImports, 1);
  assert.deepEqual(globals.bindingLibraries, []);
});

test('multiple project matches refuse until explicitly selected', async () => {
  const directory = root();
  const first = project(directory);
  const second = { ...first, name: 'second' };
  const options = {
    tokens: [],
    cwd: directory,
    projects: [
      { config: first, root: directory },
      { config: second, root: directory },
    ],
    load: { env: {} },
  };
  await assert.rejects(resolveProjectContext(options), { code: 'PROJECT_AMBIGUOUS' });
  const context = await resolveProjectContext({ ...options, tokens: ['--project', 'second'] });
  assert.equal(context.project?.name, 'second');
  assert.equal(context.project?.source, 'flag');
  assert.equal(globals.bindingImports, 0);
});

test('missing provider declaration and missing installed module refuse', async () => {
  const directory = root();
  project(directory, { recipe: undefined });
  await assert.rejects(resolveProjectContext({ tokens: [], cwd: directory }), {
    code: 'PROVIDER_MISSING',
  });
  project(directory, { recipe: { provider: { module: './absent.mjs' } } });
  await assert.rejects(resolveProjectContext({ tokens: [], cwd: directory }), {
    code: 'PROVIDER_MISSING',
  });
  assert.equal(globals.bindingImports, 0);
});

test('ambiguous apps and incompatible runtime targets refuse', async () => {
  const directory = root();
  const config = project(directory, { apps: ['apps/a', 'apps/b'] });
  fs.mkdirSync(path.join(directory, 'apps/a'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'apps/b'), { recursive: true });
  const options = {
    tokens: [],
    cwd: directory,
    projects: [{ config, root: directory }],
    load: { env: {} },
  };
  await assert.rejects(resolveProjectContext(options), { code: 'APP_AMBIGUOUS' });
  await assert.rejects(resolveProjectContext({ ...options, tokens: ['--app', 'apps/c'] }), {
    code: 'APP_INCOMPATIBLE',
  });
  const context = await resolveProjectContext({
    ...options,
    tokens: ['--app', 'apps/a', '--adapter', 'unsupported'],
  });
  await assert.rejects(loadProjectProvider(context), { code: 'TARGET_INCOMPATIBLE' });
});

test('provider source drift and forged report authority refuse before import', async () => {
  const directory = root();
  const config = project(directory);
  const context = await resolveProjectContext({
    tokens: [],
    cwd: directory,
    projects: [{ config, root: directory }],
    load: { env: {} },
  });
  write(directory, 'provider.mjs', 'throw new Error("changed code must not execute");');
  await assert.rejects(loadProjectProvider(context), { code: 'PROVIDER_SOURCE_CHANGED' });
  await assert.rejects(loadProjectProvider(structuredClone(context)), { code: 'PROVIDER_MISSING' });
  assert.equal(globals.bindingImports, 0);
});

test('a fresh binding cannot label previously imported provider code with a changed identity', async () => {
  const directory = root();
  const config = project(directory);
  const options = {
    tokens: [],
    cwd: directory,
    projects: [{ config, root: directory }],
    load: { env: {} },
  };
  await loadProjectProvider(await resolveProjectContext(options));
  write(directory, 'provider.mjs', 'throw new Error("changed source must not load");');
  const changed = await resolveProjectContext(options);
  await assert.rejects(loadProjectProvider(changed), { code: 'PROVIDER_SOURCE_CHANGED' });
  assert.equal(globals.bindingImports, 1);
});

test('provider revision and package source identity are checked without imports', async () => {
  const directory = root();
  project(directory, { recipe: { provider: { module: 'provider.mjs', revision: 'pinned-sha' } } });
  await assert.rejects(resolveProjectContext({ tokens: [], cwd: directory }), {
    code: 'SOURCE_REVISION_MISMATCH',
  });
  write(
    directory,
    'node_modules/installed-provider/package.json',
    JSON.stringify({ name: 'installed-provider', version: '1.0.0', exports: './index.mjs' }),
  );
  write(
    directory,
    'node_modules/installed-provider/index.mjs',
    'throw new Error("wrong package must not execute");',
  );
  project(directory, {
    recipe: { provider: { module: 'installed-provider', package: 'wrong-provider' } },
  });
  await assert.rejects(resolveProjectContext({ tokens: [], cwd: directory }), {
    code: 'PROVIDER_SOURCE_MISMATCH',
  });
  assert.equal(globals.bindingImports, 0);
});

test('library overrides retain ordering and configured source provenance', async () => {
  const directory = root();
  const override = root();
  const environment = root();
  fs.mkdirSync(path.join(directory, 'team'));
  fs.mkdirSync(path.join(directory, 'other'));
  const config = project(directory, {
    recipe: {
      adapter: 'headless',
      provider: { module: 'provider.mjs' },
      libraries: [
        { name: 'team', source: 'team', owner: 'team' },
        { name: 'other', source: 'other', owner: 'other' },
      ],
    },
  });
  const context = await resolveProjectContext({
    tokens: ['--library', `team=${override}`],
    cwd: directory,
    projects: [{ config, root: directory }],
    load: { env: { RECIPE_LIBRARY_PATH: `env=${environment}` } },
  });
  assert.deepEqual(
    context.project?.libraries.map((library) => library.name),
    ['team', 'env', 'other'],
  );
  assert.equal(context.project?.libraries[0]?.origin, 'flag');
  assert.equal(context.project?.libraries[0]?.overrides, path.join(directory, 'team'));
  assert.deepEqual(context.project?.libraries[0]?.overriddenSource, {
    root: path.join(directory, 'team'),
    owner: 'team',
    revision: undefined,
  });
  assert.equal(context.project?.libraries[2]?.owner, 'other');
  assert.equal(context.project?.libraries[2]?.provenance?.path, path.join(directory, 'other'));
  assert.equal(context.project?.libraries[2]?.provenance?.trust, 'unknown');
});

test('configured libraries require owners and reject unmatched revision pins', async () => {
  const directory = root();
  fs.mkdirSync(path.join(directory, 'team'));
  project(directory, {
    recipe: {
      provider: { module: 'provider.mjs' },
      libraries: [{ name: 'team', source: 'team', owner: '' }],
    },
  });
  await assert.rejects(resolveProjectContext({ tokens: [], cwd: directory, load: { env: {} } }), {
    code: 'LIBRARY_OWNER_MISSING',
  });
  project(directory, {
    recipe: {
      provider: { module: 'provider.mjs' },
      libraries: [{ name: 'team', source: 'team', owner: 'team', revision: 'pinned-sha' }],
    },
  });
  await assert.rejects(resolveProjectContext({ tokens: [], cwd: directory, load: { env: {} } }), {
    code: 'SOURCE_REVISION_MISMATCH',
  });
});

test('checkout runtime binding takes precedence over pool project and flags take precedence over both', async () => {
  const directory = root();
  const poolDirectory = root();
  const config = project(directory);
  const other = { ...config, name: 'pool-project' };
  write(
    directory,
    'temp/recipe/runtime/agentic-runtime.json',
    JSON.stringify({ repoRoot: directory, project: 'headless' }),
  );
  write(
    poolDirectory,
    'local.json',
    JSON.stringify({
      host: 'localhost',
      project: 'pool-project',
      slots: [{ id: 'one', repo: directory }],
    }),
  );
  const options = {
    tokens: [],
    cwd: directory,
    projects: [
      { config, root: directory },
      { config: other, root: directory },
    ],
    slotPoolDir: poolDirectory,
    load: { env: {} },
  };
  const bound = await resolveProjectContext(options);
  assert.equal(bound.project?.name, 'headless');
  assert.equal(bound.project?.source, 'binding');
  const flagged = await resolveProjectContext({
    ...options,
    tokens: ['--project', 'pool-project'],
  });
  assert.equal(flagged.project?.name, 'pool-project');
  assert.equal(flagged.project?.source, 'flag');
});

test('strict slot ambiguity and explicit selection survive project resolution', async () => {
  const directory = root();
  const poolDirectory = root();
  const config = project(directory);
  write(
    poolDirectory,
    'local.json',
    JSON.stringify({
      host: 'localhost',
      project: 'headless',
      slots: [
        { id: 'one', repo: directory },
        { id: 'two', repo: directory },
      ],
    }),
  );
  const options = {
    tokens: [],
    cwd: directory,
    projects: [{ config, root: directory }],
    slotPoolDir: poolDirectory,
    load: { env: {} },
  };
  await assert.rejects(resolveProjectContext(options), { code: 'SLOT_AMBIGUOUS' });
  const selected = await resolveProjectContext({ ...options, tokens: ['--slot', 'two'] });
  assert.equal(selected.slot?.value, 'two');
});

test('git subdirectories resolve the root and selected monorepo app', async () => {
  const directory = root();
  const config = project(directory, { apps: ['apps/a', 'apps/b'] });
  fs.mkdirSync(path.join(directory, 'apps/a/src'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'apps/b'), { recursive: true });
  write(directory, 'apps/a/src/index.ts', 'export {};');
  // A fixture-only commit gives sourceSnapshot a real HEAD.
  execFileSync('git', ['-C', directory, 'init', '-q']);
  execFileSync('git', ['-C', directory, 'add', '.']);
  execFileSync('git', [
    '-C',
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  ]);
  const context = await resolveProjectContext({
    tokens: [],
    cwd: path.join(directory, 'apps/a/src'),
    projects: [{ config, root: directory }],
    load: { env: {} },
  });
  assert.equal(context.project?.checkoutRoot, directory);
  assert.equal(context.project?.app, 'apps/a');
  assert.equal(context.target.value, path.join(directory, 'apps/a'));
  const head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.match(head, /^[a-f0-9]{40}$/u);
  const explicit = await resolveProjectContext({
    tokens: ['--target', path.join(directory, 'apps/b')],
    cwd: os.tmpdir(),
    projects: [{ config, root: directory }],
    load: { env: {} },
  });
  assert.equal(explicit.project?.app, 'apps/b');
  assert.equal(explicit.target.value, path.join(directory, 'apps/b'));
  config.recipe!.libraries = [{ name: 'app', source: 'apps/a', owner: 'team' }];
  const options = {
    tokens: [],
    cwd: path.join(directory, 'apps/a/src'),
    projects: [{ config, root: directory }],
    load: { env: {} },
  };
  await assert.rejects(resolveProjectContext(options), { code: 'SOURCE_REVISION_MISSING' });
  config.recipe!.libraries[0]!.revision = head;
  const pinned = await resolveProjectContext(options);
  assert.equal(pinned.project?.libraries[0]?.provenance?.revision, head);
});

test('configured default resolves relative targets and registered projectsDir without imports', async () => {
  const directory = root();
  const registry = root();
  const pack = path.join(registry, 'headless');
  fs.mkdirSync(pack);
  const config = project(pack);
  write(
    pack,
    'project.json',
    JSON.stringify({
      ...config,
      repoUrl: undefined,
      repo_url: '',
      paths: { runtime_dir: '.runtime', artifact_dir: 'artifacts' },
    }),
  );
  fs.mkdirSync(path.join(directory, 'checkout'));
  const context = await resolveProjectContext({
    tokens: ['--target', 'checkout'],
    cwd: directory,
    projectsDir: registry,
    defaultProject: 'headless',
    load: { env: {} },
  });
  assert.equal(context.project?.source, 'default');
  assert.equal(context.target.value, path.join(directory, 'checkout'));
  assert.equal(context.project?.provider.authority, 'configured');
  assert.equal(context.project?.runtimeDir, 'temp/recipe/runtime');
  assert.equal(context.project?.farmRuntimeDir, '.runtime');
  assert.equal(context.project?.artifactDir, 'artifacts');
  assert.equal(globals.bindingImports, 0);
});

test('an explicit project with an incompatible checkout origin is refused', async () => {
  const directory = root();
  const config = project(directory, { repoUrl: 'https://example.invalid/correct.git' });
  execFileSync('git', ['-C', directory, 'init', '-q']);
  execFileSync('git', [
    '-C',
    directory,
    'remote',
    'add',
    'origin',
    'https://example.invalid/wrong.git',
  ]);
  await assert.rejects(
    resolveProjectContext({
      tokens: ['--project', 'headless'],
      cwd: directory,
      projects: [{ config, root: directory }],
    }),
    { code: 'PROJECT_INCOMPATIBLE' },
  );
  assert.equal(globals.bindingImports, 0);
});

test('registered project matches HTTPS and SSH origins for the same repository', async () => {
  const directory = root();
  const registered = root();
  const config = project(registered, { repoUrl: 'git@github.com:example/project.git' });
  execFileSync('git', ['init', '-q', directory]);
  execFileSync('git', [
    '-C',
    directory,
    'remote',
    'add',
    'origin',
    'https://github.com/example/project.git',
  ]);
  const context = await resolveProjectContext({
    tokens: [],
    cwd: directory,
    projects: [{ config, root: registered }],
    load: { env: {} },
  });
  assert.equal(context.project?.name, 'headless');
  assert.equal(context.project?.provider.authority, 'configured');
});

test('unmapped infrastructure slot platform leaves the project runtime default intact', async () => {
  const directory = root();
  const poolDirectory = root();
  const config = project(directory);
  write(
    poolDirectory,
    'local.json',
    JSON.stringify({
      host: 'localhost',
      project: 'headless',
      slots: [{ id: 'one', repo: directory, platform: 'cli' }],
    }),
  );
  const context = await resolveProjectContext({
    tokens: [],
    cwd: directory,
    projects: [{ config, root: directory }],
    slotPoolDir: poolDirectory,
    load: { env: {} },
  });
  assert.equal(context.adapter?.value, 'headless');
  assert.equal(context.adapter?.source, 'default');
});

test('configured pool environment roots bind external provider and library without ambient paths', async () => {
  const checkout = root();
  const pack = root();
  const providerRoot = root();
  const libraryRoot = root();
  const pool = root();
  project(providerRoot);
  write(
    providerRoot,
    'package.json',
    JSON.stringify({
      name: 'example-provider',
      type: 'module',
      exports: { './provider': './provider.mjs' },
    }),
  );
  const config = project(pack, {
    recipe: {
      adapter: 'headless',
      provider: {
        module: 'example-provider/provider',
        package: 'example-provider',
        root: { env: 'EXAMPLE_PROVIDER_ROOT' },
      },
      libraries: [{ name: 'team', source: { env: 'EXAMPLE_LIBRARY_ROOT' }, owner: 'team' }],
    },
  });
  write(
    pool,
    'local.json',
    JSON.stringify({
      host: 'localhost',
      project: 'headless',
      env: { EXAMPLE_PROVIDER_ROOT: providerRoot, EXAMPLE_LIBRARY_ROOT: libraryRoot },
      slots: [{ id: 'one', repo: checkout }],
    }),
  );
  const context = await resolveProjectContext({
    tokens: [],
    cwd: checkout,
    projects: [{ config, root: pack }],
    slotPoolDir: pool,
    load: { env: {} },
  });
  assert.equal(context.project?.provider.root, providerRoot);
  assert.equal(context.project?.libraries[0]?.root, libraryRoot);
  assert.equal(process.env.EXAMPLE_PROVIDER_ROOT, undefined);
  const provider = await loadProjectProvider(context);
  assert.equal(provider.runtime.headless, true);
  assert.equal(globals.bindingLibraries?.length, 1);
  await assert.rejects(
    resolveProjectContext({
      tokens: [],
      cwd: checkout,
      projects: [{ config, root: pack }],
      slotPoolDir: pool,
      load: { env: { EXAMPLE_PROVIDER_ROOT: path.join(providerRoot, 'missing') } },
    }),
    { code: 'SOURCE_ROOT_MISSING' },
  );
});

test('discovered environment root references refuse before reading operator values or importing', async () => {
  const directory = root();
  project(directory, {
    recipe: {
      adapter: 'headless',
      provider: { module: 'provider.mjs', root: { env: 'EXAMPLE_PRIVATE_VALUE' } },
    },
  });
  await assert.rejects(
    resolveProjectContext({
      tokens: [],
      cwd: directory,
      load: { env: { EXAMPLE_PRIVATE_VALUE: 'must-not-read' } },
    }),
    { code: 'SOURCE_UNAUTHORIZED' },
  );
  assert.equal(globals.bindingImports, 0);
});

test('missing declared and overridden library paths return the same structured refusal', async () => {
  const directory = root();
  const config = project(directory);
  const options = { cwd: directory, projects: [{ config, root: directory }], load: { env: {} } };
  config.recipe!.libraries = [{ name: 'team', source: 'missing', owner: 'team' }];
  await assert.rejects(resolveProjectContext({ ...options, tokens: [] }), {
    code: 'SOURCE_ROOT_MISSING',
  });
  config.recipe!.libraries = [];
  await assert.rejects(
    resolveProjectContext({ ...options, tokens: ['--library', `team=${directory}/missing`] }),
    { code: 'SOURCE_ROOT_MISSING' },
  );
});

test('project metadata without paths uses the schema defaults for farm state and artifacts', async () => {
  const directory = root();
  const config = project(directory);
  write(directory, 'project.json', JSON.stringify({ ...config, paths: undefined }));
  const context = await resolveProjectContext({ cwd: directory, tokens: [], load: { env: {} } });
  assert.equal(context.project?.farmRuntimeDir, '.agent');
  assert.equal(context.project?.artifactDir, '.task');
  assert.equal(context.project?.runtimeDir, 'temp/recipe/runtime');
});

test('ignored compiled provider bytes cannot retain a checked source identity', async () => {
  const directory = root();
  const config = project(directory, {
    recipe: { provider: { module: 'dist/provider.mjs' }, adapter: 'headless' },
    paths: { runtimeDir: 'dist/runtime', artifactDir: 'artifacts' },
  });
  write(directory, '.gitignore', 'dist/\n');
  write(
    directory,
    'dist/provider.mjs',
    fs.readFileSync(path.join(directory, 'provider.mjs'), 'utf8'),
  );
  execFileSync('git', ['init', '-q', directory]);
  execFileSync('git', ['-C', directory, 'add', '.']);
  execFileSync('git', [
    '-C',
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'Fixture',
  ]);
  const context = await resolveProjectContext({
    tokens: [],
    cwd: directory,
    projects: [{ config, root: directory }],
    load: { env: {} },
  });
  const tracked = sourceSnapshot(directory).sourceFingerprint;
  write(directory, 'dist/runtime/state.json', '{}');
  await loadProjectProvider(context);
  fs.appendFileSync(path.join(directory, 'dist/provider.mjs'), '\n// Changed delivery bytes.\n');
  assert.equal(sourceSnapshot(directory).sourceFingerprint, tracked);
  await assert.rejects(loadProjectProvider(context), { code: 'PROVIDER_SOURCE_CHANGED' });
  assert.equal(globals.bindingImports, 1);
});

test('nested SDK snapshots retain ignored delivery bytes without duplicate hashing', () => {
  const repository = root();
  const sdk = path.join(repository, 'sdk');
  write(sdk, 'package.json', '{"name":"example-sdk"}');
  write(repository, '.gitignore', 'sdk/dist/\n');
  execFileSync('git', ['init', '-q', repository]);
  execFileSync('git', ['-C', repository, 'add', '.']);
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'Fixture',
  ]);
  write(sdk, 'dist/index.js', 'export const policy = "original";');
  const module = path.join(sdk, 'dist/index.js');
  const before = providerSourceSnapshot(sdk, module);
  fs.writeFileSync(module, 'export const policy = "changed";');
  const after = providerSourceSnapshot(sdk, module);
  assert.equal(before.head, after.head);
  assert.equal(before.status, after.status);
  assert.notEqual(before.sourceFingerprint, after.sourceFingerprint);
  assert.equal(after.sourceFingerprint, inputSourceSnapshot(sdk).sourceFingerprint);
  assert.equal(
    providerSourceSnapshot(sdk, module, [repository]).sourceFingerprint,
    after.sourceFingerprint,
  );
});
