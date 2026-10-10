import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import type { ProjectConfig } from '@farmslot/protocol';

import { harnessAdapters } from '../src/harness/adapters.js';
import { harnessContext } from '../src/harness/context-state.js';
import { sourceSnapshot } from '../src/harness/execution-provenance.js';
import { harnessHost } from '../src/harness/host.js';
import { recipeOutputRoots } from '../src/harness/paths.js';
import { withProjectRecipeHost } from '../src/harness/project-host.js';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-host-'));
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
        options: flag ? { runtimeDir: flag } : {},
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
