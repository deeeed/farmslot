import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import type { ProjectConfig } from '@farmslot/protocol';

import { harnessAdapters } from '../src/harness/adapters.js';
import { recipeConformanceIdentity } from '../src/harness/conformance.js';
import { harnessContext } from '../src/harness/context-state.js';
import { sourceSnapshot } from '../src/harness/execution-provenance.js';
import { harnessHost } from '../src/harness/host.js';
import { recipeOutputRoots } from '../src/harness/paths.js';
import { withProjectRecipeHost } from '../src/harness/project-host.js';

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-host-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'provider.mjs'),
    `
    export function createProvider(context) {
      process.env.GOAL3_SCOPE_TEST = context.options.scope;
      return {
        runtime: {
          id: 'headless', sdkVersion: 1, headless: true,
          runtimeStatus: async () => ({decision:'ready', reasons:[]}),
          resolveSlotPorts() {}, logSources: () => [], appLogSource: () => null,
          devServer: {}, hints: {}, harness: {}, runtimeContext: {},
          launch: async () => { throw new Error('unexpected launch'); },
          actions: {manifestPath: () => '', semantic: [], cdpTarget: {transport:'none'}},
        },
        finalize: async () => {
          process.env.GOAL3_SCOPE_TEST = 'finalizing';
          if (context.options.finalizeFail) throw new Error('finalization failed');
        },
      };
    }
  `,
  );
  const config = {
    name: 'example',
    paths: { runtimeDir: 'runtime', artifactDir: 'artifacts' },
    recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } },
  } as ProjectConfig;
  return { cwd: root, tokens: [], projects: [{ config, root }], command: 'doctor' };
}

test('host restores caller state after callback and finalization failures', async (t) => {
  const options = fixture(t);
  const previous = {
    env: process.env.GOAL3_SCOPE_TEST,
    runtimeDir: process.env.RECIPE_RUNTIME_DIR,
    host: harnessHost(),
    context: harnessContext(),
    adapters: harnessAdapters(),
  };
  await assert.rejects(
    withProjectRecipeHost({ ...options, options: { scope: 'inside' } }, async ({ context }) => {
      assert.equal(process.env.GOAL3_SCOPE_TEST, 'inside');
      assert.equal(harnessContext(), context);
      throw new Error('callback failed');
    }),
    /callback failed/u,
  );
  await assert.rejects(
    withProjectRecipeHost(
      { ...options, options: { scope: 'inside', finalizeFail: true } },
      async () => {},
    ),
    /finalization failed/u,
  );
  assert.equal(process.env.GOAL3_SCOPE_TEST, previous.env);
  assert.equal(process.env.RECIPE_RUNTIME_DIR, previous.runtimeDir);
  assert.deepEqual(harnessHost(), previous.host);
  assert.equal(harnessContext(), previous.context);
  assert.equal(harnessAdapters(), previous.adapters);
});

test('overlapping project hosts wait for the active invocation before changing state', async (t) => {
  const options = fixture(t);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const observed: string[] = [];
  const first = withProjectRecipeHost({ ...options, options: { scope: 'first' } }, async () => {
    observed.push(process.env.GOAL3_SCOPE_TEST!);
    started();
    await gate;
    observed.push(process.env.GOAL3_SCOPE_TEST!);
  });
  await firstStarted;
  const second = withProjectRecipeHost({ ...options, options: { scope: 'second' } }, async () => {
    observed.push(process.env.GOAL3_SCOPE_TEST!);
  });
  try {
    await Promise.resolve();
    assert.deepEqual(observed, ['first']);
  } finally {
    release();
  }
  await Promise.all([first, second]);
  assert.deepEqual(observed, ['first', 'first', 'second']);
});

test('recipe runtime defaults and overrides stay separate from farm state', async (t) => {
  const previous = process.env.RECIPE_RUNTIME_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.RECIPE_RUNTIME_DIR;
    else process.env.RECIPE_RUNTIME_DIR = previous;
  });
  for (const [env, flag, expected] of [
    [undefined, undefined, 'temp/recipe/runtime'],
    ['env-runtime', undefined, 'env-runtime'],
    ['env-runtime', 'flag-runtime', 'flag-runtime'],
  ]) {
    const options = fixture(t);
    if (env === undefined) delete process.env.RECIPE_RUNTIME_DIR;
    else process.env.RECIPE_RUNTIME_DIR = env;
    const file = path.join(options.cwd, expected!, 'agentic-runtime.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ repoRoot: options.cwd, project: 'example' }));
    await withProjectRecipeHost(
      {
        ...options,
        tokens: flag ? ['--runtime-dir', flag] : [],
        options: {},
      },
      async ({ context, cli }) => {
        assert.equal(context.runtimeConfigPath, file);
        assert.equal(context.project?.runtimeDir, expected);
        assert.equal(context.project?.farmRuntimeDir, 'runtime');
        assert.equal(cli.runtimeDir, expected);
        assert.equal(process.env.RECIPE_RUNTIME_DIR, expected);
      },
    );
  }
});

test('app output exclusions use the checkout farm paths and preserve library provenance', async (t) => {
  const options = fixture(t);
  const config = options.projects[0]!.config;
  config.apps = ['apps/ui'];
  fs.mkdirSync(path.join(options.cwd, 'apps/ui'), { recursive: true });
  const library = path.join(options.cwd, 'team');
  fs.mkdirSync(library);
  config.recipe!.libraries = [{ name: 'team', source: 'team', owner: 'team' }];
  await withProjectRecipeHost(
    { ...options, tokens: ['--app', 'apps/ui'] },
    async ({ context, cli, librarySources }) => {
      const binding = context.project!;
      assert.equal(cli.artifactsDir, path.join(binding.checkoutRoot, 'artifacts'));
      const exclusions = recipeOutputRoots(context.target.value, binding);
      const before = sourceSnapshot(options.cwd, undefined, exclusions);
      for (const root of exclusions) {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'state'), 'runtime state');
      }
      assert.deepEqual(sourceSnapshot(options.cwd, undefined, exclusions), before);
      assert.deepEqual(librarySources[0]?.provenance, binding.libraries[0]?.provenance);
      fs.writeFileSync(
        path.join(options.cwd, 'implementation.mjs'),
        'export const changed = true;',
      );
      assert.notEqual(
        sourceSnapshot(options.cwd, undefined, exclusions).sourceFingerprint,
        before.sourceFingerprint,
      );
    },
  );
});

test('app runtime targeting and its config identity come from the selected app', async (t) => {
  const options = fixture(t);
  options.projects[0]!.config.apps = ['apps/ui'];
  execFileSync('git', ['init', '-q', options.cwd]);
  const app = path.join(options.cwd, 'apps/ui');
  for (const [root, slotId, watcherPort] of [
    [options.cwd, 'root-slot', 8111],
    [app, 'app-slot', 8222],
  ] as const) {
    const file = path.join(root, 'temp/recipe/runtime/agentic-runtime.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ repoRoot: root, project: 'example', slotId, watcherPort }),
    );
  }
  await withProjectRecipeHost({ ...options, tokens: ['--app', 'apps/ui'] }, async ({ context }) => {
    assert.equal(
      context.runtimeConfigPath,
      path.join(app, 'temp/recipe/runtime/agentic-runtime.json'),
    );
    assert.equal(context.slot?.value, 'app-slot');
    assert.equal(context.slot?.value && context.slot.ports.watcherPort, 8222);
  });
});

test('checkout library provenance excludes doctor output across repeated hosts', async (t) => {
  const options = fixture(t);
  execFileSync('git', ['init', '-q', options.cwd]);
  execFileSync('git', ['-C', options.cwd, 'add', '.']);
  execFileSync('git', [
    '-C',
    options.cwd,
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
  const invocation = { ...options, tokens: ['--library', `team=${options.cwd}`] };
  let before: unknown;
  await withProjectRecipeHost(invocation, async ({ librarySources, cli }) => {
    before = librarySources[0]!.provenance;
    assert.equal(librarySources[0]!.provenance?.dirty, false);
    fs.mkdirSync(String(cli.artifactsDir), { recursive: true });
    fs.writeFileSync(path.join(String(cli.artifactsDir), 'conformance-report.json'), '{}');
  });
  await withProjectRecipeHost(invocation, async ({ librarySources }) => {
    assert.deepEqual(librarySources[0]!.provenance, before);
  });
});

test('normalized provider runtimes retain the selected platform in report identity', async (t) => {
  const options = fixture(t);
  const providerFile = path.join(options.cwd, 'provider.mjs');
  fs.writeFileSync(
    providerFile,
    fs
      .readFileSync(providerFile, 'utf8')
      .replace(
        "id: 'headless', sdkVersion: 1, headless: true,",
        "id: 'headless', sdkVersion: 1, headless: true, targets: ['ios', 'android'],",
      ),
  );
  const targets: string[] = [];
  for (const selection of ['ios', 'android']) {
    await withProjectRecipeHost(
      { ...options, tokens: ['--adapter', selection] },
      async ({ context, engine, librarySources }) => {
        assert.equal(context.adapter?.value, 'headless');
        const identity = await recipeConformanceIdentity(engine, {
          project: 'example',
          context,
          providerRoot: options.cwd,
          configurationPaths: [],
          librarySources,
          artifactsDir: path.join(options.cwd, 'artifacts'),
          recipes: [],
        });
        assert.equal(identity.selection?.adapterTarget, selection);
        targets.push(JSON.stringify(identity));
      },
    );
  }
  assert.notEqual(targets[0], targets[1]);
});
