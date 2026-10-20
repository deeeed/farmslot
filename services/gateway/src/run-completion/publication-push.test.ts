import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { makeVars } from '../runners/test-fixtures.js';

import { makeRun } from './test-fixtures.js';

const nativeConfig = await import('../core/config.js');
const nativeExec = await import('../core/exec.js');
const nativeGithub = await import('../integrations/github-client.js');
const commands: string[] = [];
const githubRequests: string[][] = [];
let push = { exitCode: 0, stdout: '', stderr: '' };
const headSha = 'ec2db26d96';
let pushTimeout: number | undefined;
mock.module('../core/config.js', {
  namedExports: {
    ...nativeConfig,
    loadSlotVars: async () => makeVars({ slotId: 'core-2', remoteRepo: '/slot/core' }),
    loadProjectVars: async () => ({ projectJson: { default_branch: 'main' } }),
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...nativeExec,
    execOnSlot: async (_vars: unknown, command: string, options?: { timeout?: number }) => {
      commands.push(command);
      if (command.includes(' push -u origin ')) pushTimeout = options?.timeout;
      if (command.includes(' rev-parse HEAD'))
        return { exitCode: 0, stdout: `${headSha}\n`, stderr: '' };
      if (command.includes(' push -u origin ')) return push;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
});
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...nativeGithub,
    ghRequest: async (args: string[]) => {
      githubRequests.push(args);
      return { exitCode: 0, stdout: 'https://github.com/MetaMask/core/pull/7\n', stderr: '' };
    },
  },
});
const { makeReadyGatePackage } = await import('../run-engine/test-fixtures.js');
const { createPrFromApprovedPackage } = await import('./orchestrator.js');
const prepared = makeReadyGatePackage({ branch: 'TAT-4006-feat', headSha });

test('a push the pre-push hook refuses stops publication with its output, before any PR is created', async () => {
  // TAT-4006 run 7721a02b: MetaMask/core's pre-push `yarn lint` refused the push, and
  // `gh pr create` then failed with only "Head sha can't be blank".
  const run = makeRun({ id: '7721a02b-run', slotId: 'core-2', project: 'core' });
  push = {
    exitCode: 1,
    stdout:
      'Unlisted dependencies (1)\n@metamask/snaps-sdk  packages/bridge-controller/dist/x.d.ts\n',
    stderr: "error: failed to push some refs to 'github.com:MetaMask/core.git'\n",
  };
  await assert.rejects(
    createPrFromApprovedPackage(run, 'MetaMask/core', prepared),
    /git push of TAT-4006-feat failed \(exit 1\); a pre-push hook or the remote refused it: error: failed to push some refs/,
  );
  assert.ok(commands.some((command) => command.includes(" push -u origin 'TAT-4006-feat'")));
  // The hook's `yarn lint` took 165-171 s on that slot; the push must outlast it.
  assert.ok((pushTimeout ?? 0) >= 300_000);
  assert.equal(githubRequests.length, 0);
  // A push that lands opens the draft PR from the pushed branch.
  push = { exitCode: 0, stdout: '', stderr: '' };
  assert.equal(await createPrFromApprovedPackage(run, 'MetaMask/core', prepared), 7);
  assert.deepEqual(githubRequests[0]?.slice(0, 6), [
    'pr',
    'create',
    '--repo',
    'MetaMask/core',
    '--head',
    'TAT-4006-feat',
  ]);
});
