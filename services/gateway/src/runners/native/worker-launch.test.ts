import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { nativeWorkerLaunchDigest } from '@farmslot/agent-runtime/native/worker-launch';

await import('../../runtime/mock-pty.test-support.js');
const exec = await import('../../core/exec.js');
mock.module('../../core/exec.js', {
  namedExports: { ...exec, execOnSlot: async () => ({ exitCode: 1, stdout: '', stderr: '' }) },
});
const { makeVars } = await import('../test-fixtures.js');
const { prepareNativeWorkerLaunch } = await import('./worker-launch.js');

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
