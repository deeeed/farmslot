import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import {
  nativeWorkerEnvironment,
  nativeWorkerLaunchDigest,
} from '@farmslot/agent-runtime/native/worker-launch';
import {
  findSlotByRepo,
  resolveSlotPoolDir,
  type SlotPoolFile,
} from '@farmslot/protocol/node/slot-by-repo';

import {
  retainTaskExecution,
  verifyTaskExecutionProvenance,
} from '../../../../../packages/agent-runtime/src/task-init/execution-provenance.js';

await import('../../runtime/mock-pty.test-support.js');
const exec = await import('../../core/exec.js');
const execOnSlot: typeof exec.execOnSlot = async (_vars, command) => ({
  exitCode: command.includes('/codex-home/config.toml') ? 0 : 1,
  stdout: '',
  stderr: '',
});
mock.module('../../core/exec.js', {
  namedExports: { ...exec, execOnSlot },
});
const { makeVars } = await import('../test-fixtures.js');
const { prepareNativeWorkerLaunch } = await import('./worker-launch.js');

interface ProviderPool extends SlotPoolFile {
  env: { PROVIDER_ROOT: string };
}

for (const [runner, model] of [
  ['claude', 'opus'],
  ['codex', 'gpt-6.1-sol'],
] as const) {
  test(`a static native ${runner} reviewer verifies its task and resolves the selected pool provider`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-review-task-home-'));
    const previous = process.env.FARMSLOT_HOME;
    const previousPool = process.env.FARMSLOT_POOL_DIR;
    t.after(() => {
      if (previous === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previous;
      if (previousPool === undefined) delete process.env.FARMSLOT_POOL_DIR;
      else process.env.FARMSLOT_POOL_DIR = previousPool;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const selectedHome = path.join(root, 'selected-home');
    const nativeHome = path.join(root, 'native-host-home');
    const distribution = path.join(root, 'cli');
    const executable = path.join(distribution, 'bin/farmslot.mjs');
    const taskDir = path.join(root, 'task');
    const selectedPool = path.join(root, 'selected-pool');
    const retiredPool = path.join(root, 'retired-pool');
    const providerRoot = path.join(root, 'providers/current');
    fs.mkdirSync(providerRoot, { recursive: true });
    for (const [poolDir, provider] of [
      [selectedPool, providerRoot],
      [retiredPool, path.join(root, 'providers/removed')],
    ] as const) {
      fs.mkdirSync(poolDir, { recursive: true });
      const pool: ProviderPool = {
        slots: [{ id: 'review-slot', repo: taskDir }],
        env: { PROVIDER_ROOT: provider },
      };
      fs.writeFileSync(path.join(poolDir, 'fixture.json'), JSON.stringify(pool));
    }
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(path.join(nativeHome, 'task-pins'), { recursive: true });
    fs.writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("fixture");\n');
    fs.writeFileSync(
      path.join(distribution, 'package.json'),
      JSON.stringify({ name: '@farmslot/cli', version: '1.0.0' }),
    );
    process.env.FARMSLOT_HOME = selectedHome;
    const receipt = retainTaskExecution(taskDir, {
      executable,
      packageRoot: distribution,
      distributionRoot: distribution,
      bindingIdentity: null,
      inputs: [],
    });
    process.env.FARMSLOT_HOME = nativeHome;
    process.env.FARMSLOT_POOL_DIR = retiredPool;
    const { launch } = await prepareNativeWorkerLaunch({
      vars: makeVars({
        machineEnv: {
          FARMSLOT_HOME: selectedHome,
          FARMSLOT_POOL_DIR: selectedPool,
          PROVIDER_ROOT: '/unrelated/provider',
        },
      }),
      project: {},
      runner,
      model,
      role: 'review',
      reviewValidationDepth: 'static-code',
      safetyTier: 'sandboxed',
      taskDir,
      leaseId: 'proof-lease',
      sessionId: 'proof-session',
      prepareAccount: false,
    });
    const environment = nativeWorkerEnvironment(launch);
    const reviewerHome = environment.FARMSLOT_HOME;
    assert.ok(reviewerHome);
    process.env.FARMSLOT_HOME = reviewerHome;
    assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), receipt);
    assert.equal(reviewerHome, selectedHome);
    assert.equal(launch.environment.set.PROVIDER_ROOT, undefined);
    const pool = resolveSlotPoolDir(environment);
    assert.ok(pool);
    const slot = await findSlotByRepo<ProviderPool>(pool.dir, fs.realpathSync(taskDir));
    assert.ok(slot);
    assert.equal(fs.realpathSync(slot.pool.env.PROVIDER_ROOT), fs.realpathSync(providerRoot));
  });
}

for (const role of ['review', 'primary', 'review-fix'] as const) {
  test(`native ${role} launch keeps its sandboxed tier and derives reviewer-only approval`, async () => {
    const { launch } = await prepareNativeWorkerLaunch({
      vars: makeVars(),
      project: {},
      runner: 'claude',
      model: 'opus',
      role,
      safetyTier: 'sandboxed',
      taskDir: 'tasks/proof',
      leaseId: 'proof-lease',
      sessionId: 'proof-session',
      prepareAccount: false,
    });
    assert.equal(launch.safetyTier, 'sandboxed');
    assert.equal(launch.approvalPolicy, role === 'review' ? 'never' : undefined);
    assert.equal(launch.filesystemPolicy, undefined);
  });
}

test('review launch identity ignores unrelated pool selections and keeps explicit project settings', async () => {
  const prepare = (
    version: string,
    role: 'review' | 'primary' = 'review',
    reviewValidationDepth: 'static-code' | 'full-live' = 'static-code',
  ) =>
    prepareNativeWorkerLaunch({
      vars: makeVars({
        machineEnv: {
          PROVIDER_ROOT: `/providers/${version}`,
          PROVIDER_BIN: `/providers/${version}/bin/provider`,
        },
      }),
      project: { command_env: { set: { REVIEW_PROJECT_SETTING: 'pinned' } } },
      runner: 'claude',
      model: 'opus',
      role,
      reviewValidationDepth,
      safetyTier: 'sandboxed',
      taskDir: 'tasks/proof',
      leaseId: 'proof-lease',
      sessionId: 'proof-session',
      prepareAccount: false,
    });
  const before = (await prepare('old')).launch;
  const after = (await prepare('new')).launch;
  assert.equal(before.environment.set.REVIEW_PROJECT_SETTING, 'pinned');
  assert.equal(after.environment.set.PROVIDER_ROOT, undefined);
  assert.equal(nativeWorkerLaunchDigest(before), nativeWorkerLaunchDigest(after));
  assert.notEqual(
    nativeWorkerLaunchDigest((await prepare('old', 'primary')).launch),
    nativeWorkerLaunchDigest((await prepare('new', 'primary')).launch),
  );
  assert.notEqual(
    nativeWorkerLaunchDigest((await prepare('old', 'review', 'full-live')).launch),
    nativeWorkerLaunchDigest((await prepare('new', 'review', 'full-live')).launch),
  );
});

test('legacy review launches retain their pool environment without a captured depth', async () => {
  const { launch } = await prepareNativeWorkerLaunch({
    vars: makeVars({ machineEnv: { PROVIDER_ROOT: '/providers/pinned' } }),
    project: {},
    runner: 'claude',
    model: 'opus',
    role: 'review',
    safetyTier: 'sandboxed',
    taskDir: 'tasks/proof',
    leaseId: 'proof-lease',
    sessionId: 'proof-session',
    prepareAccount: false,
  });
  assert.equal(launch.environment.set.PROVIDER_ROOT, '/providers/pinned');
});

test('a bound worker launch resolves RECIPE_LIBRARY_PATH to its pinned libraries', async () => {
  const pin = '/home/.farmslot/task-pins/ba9f77/inputs/39/recipe-perps';
  const { launch } = await prepareNativeWorkerLaunch({
    vars: makeVars(),
    project: { command_env: { set: { RECIPE_LIBRARY_PATH: 'perps=/dev/recipe-perps:/plain' } } },
    runner: 'claude',
    model: 'opus',
    role: 'primary',
    safetyTier: 'sandboxed',
    taskDir: 'tasks/proof',
    taskLibraries: new Map([['perps', pin]]),
    leaseId: 'proof-lease',
    sessionId: 'proof-session',
    prepareAccount: false,
  });
  assert.equal(launch.environment.set.RECIPE_LIBRARY_PATH, `perps=${pin}:/plain`);
});
