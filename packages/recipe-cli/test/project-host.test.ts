import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import type { ProjectConfig } from '@farmslot/protocol';

import { harnessAdapters } from '../src/harness/adapters.js';
import { harnessContext } from '../src/harness/context-state.js';
import { harnessHost } from '../src/harness/host.js';
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
