import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

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
