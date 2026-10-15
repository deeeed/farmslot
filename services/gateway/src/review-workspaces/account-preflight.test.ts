import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import { type NativeProfileInfo, PipelineSteps } from '@farmslot/protocol';
import type { RawPoolJson } from '@farmslot/slot-config';

await import('../runtime/mock-pty.test-support.js');
const priorOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'review-owner';
after(() => {
  if (priorOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = priorOwner;
});
const { createRun, updateRun } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
const config = await import('../core/config.js');
const pool: RawPoolJson = {
  machine: 'review-node',
  host: 'localhost',
  project: 'demo',
  platform: 'test',
  os: 'macos',
  ssh_user: 'fixture',
  slots: [],
  grok_path: '/configured/outside-path/grok',
};
mock.module('../core/config.js', {
  namedExports: { ...config, loadMachinePool: async () => pool },
});
const localExec = await import('../core/exec.js');
const localCalls: Array<{ argv: string[]; timeout: number }> = [];
mock.module('../core/exec.js', {
  namedExports: {
    ...localExec,
    execFileArgv: async (argv: string[], options: { timeout: number }) => {
      localCalls.push({ argv, timeout: options.timeout });
      return { stdout: '', stderr: error, exitCode: error ? 1 : 0 };
    },
  },
});
const node = await import('../runners/native/node.js');
const calls: Array<{ owner: string; machine: string; argv: string[]; timeout: number }> = [];
let error = '';
mock.module('../runners/native/node.js', {
  namedExports: {
    ...node,
    execNativeNodeArgv: async (owner: string, machine: string, argv: string[], timeout: number) => {
      calls.push({ owner, machine, argv, timeout });
      return { stdout: '', stderr: error, exitCode: error ? 1 : 0 };
    },
  },
});
const profiles = await import('../runners/native/worker-profile.js');
const profile: NativeProfileInfo = {
  id: 'review-safe',
  runner: 'grok',
  directory: '/owned/review-account',
  accountContextId: '7ba11cd2-f1d9-40fd-838b-0b47222796b0',
  state: 'active',
};
mock.module('../runners/native/worker-profile.js', {
  namedExports: { ...profiles, inspectNativeWorkerProfile: async () => profile },
});
const support = await import('./support.js');
let supportReads = 0;
mock.module('./support.js', {
  namedExports: {
    ...support,
    ensureReviewWorkspaceSupport: async () => {
      supportReads++;
    },
  },
});
const { executeReviewWorkspaceStep } = await import('./pipeline.js');
const { preflightReviewWorkspaceAccount } = await import('./account-preflight.js');

function reviewRun(
  selectedProfile = false,
  local = false,
  transport: 'native' | 'tmux' = 'native',
) {
  const run = createRun(
    {
      flowType: 'review-pr',
      project: 'demo',
      ticketOrPr: 'REVIEW-1',
      runner: 'grok',
      model: 'grok-4.7',
      transport,
      reviewWorkspaceTarget: { machine: 'review-node' },
      ...(selectedProfile
        ? {
            nativeProfile: {
              executionNodeId: 'review-node',
              profileId: profile.id,
              accountContextId: profile.accountContextId,
              runner: 'grok',
            },
          }
        : {}),
    },
    { nativeOwnerPrincipalId: 'review-owner' },
  );
  return updateRun(run.id, {
    status: 'writing-task',
    slotId: null,
    reviewWorkspace: {
      workspaceId: 'owned',
      machine: 'review-node',
      executionNodeId: local ? 'local' : 'review-node',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
    },
    reviewWorkspaceSubject: {
      repository: 'owner/repo',
      repositoryUrl: 'https://github.com/owner/repo',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'feature',
      title: 'Review',
      body: '',
      url: 'https://github.com/owner/repo/pull/1',
      capturedAt: run.createdAt,
    },
  });
}

async function disposeRun(run: ReturnType<typeof reviewRun>) {
  updateRun(run.id, {
    reviewWorkspace: { ...run.reviewWorkspace!, cleanedAt: new Date().toISOString() },
  });
  await deleteTestRunIfPresent(run.id);
}

test('write-task refuses unsafe account hooks before any support copy or task materialization', async (t) => {
  const run = reviewRun();
  t.after(() => disposeRun(run));
  error =
    'Grok review refused: this account has startup hooks enabled. Select an isolated review profile.';
  const before = supportReads;
  await assert.rejects(
    executeReviewWorkspaceStep(run.id, PipelineSteps.WRITE_TASK, 0, () => {}),
    new RegExp(error),
  );
  assert.equal(supportReads, before);
  const command = calls.at(-1)!;
  assert.equal(command.owner, 'review-owner');
  assert.equal(command.machine, 'review-node');
  assert.equal(command.timeout, 15_000);
  assert.equal(
    command.argv[5],
    pool.grok_path,
    'native preflight uses the same configured executable as launch',
  );
  assert.equal(command.argv[3], '/owned/task', 'inspection uses engine-owned task, not PR source');
});

test('profile preflight transports only its checked account directory and retains lifecycle guards', async (t) => {
  const run = reviewRun(true);
  t.after(() => disposeRun(run));
  error = '';
  await preflightReviewWorkspaceAccount(run, () => {});
  assert.equal(calls.at(-1)!.argv[4], profile.directory);
  let checks = 0;
  await assert.rejects(
    preflightReviewWorkspaceAccount(run, () => {
      if (++checks === 3) throw new Error('generation changed');
    }),
    /generation changed/,
  );
});

test('local reviews preflight without a registered node and tmux uses its configured executable', async (t) => {
  const run = reviewRun(false, true, 'tmux');
  t.after(() => disposeRun(run));
  error = '';
  const remoteCalls = calls.length;
  await preflightReviewWorkspaceAccount(run, () => {});
  assert.equal(calls.length, remoteCalls);
  const command = localCalls.at(-1)!;
  assert.equal(command.argv[0], process.execPath);
  assert.equal(command.argv[5], pool.grok_path);
  assert.equal(command.timeout, 15_000);
});
