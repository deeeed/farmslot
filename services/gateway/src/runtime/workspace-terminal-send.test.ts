import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { WebSocket } from 'ws';

import type { Run } from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

const actualExec = await import('../core/exec.js');
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { handleNodeResponse } = await import('../fleet/node-rpc.js');
const session = 'review-submission-proof';
const vars = makeVars({ session });
const run: Run = {
  id: 'review-submission-proof',
  familyId: 'review-submission-proof',
  lane: 'production',
  flowType: 'review-pr',
  mode: 'autonomous',
  status: 'reviewing',
  project: 'proof',
  ticketOrPr: 'Submission regression',
  slotId: null,
  branch: null,
  taskFile: null,
  steps: [],
  decisions: [],
  metrics: { runner: 'codex', model: null, nudgeCount: 0 },
  createdAt: '2026-11-04T00:00:00Z',
  updatedAt: '2026-11-04T00:00:00Z',
  transport: 'tmux',
  reviewWorkspace: {
    workspaceId: 'submission-proof',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: '/proof/repo',
    taskPath: '/proof/task',
    artifactPath: '/proof/artifacts',
  },
  agentContexts: [
    {
      id: 'review',
      role: 'review',
      label: 'Review',
      status: 'working',
      slotId: null,
      runId: 'review-submission-proof',
      runner: 'codex',
      target: { session, target: session },
    },
  ],
};
const operations: string[] = [];
let confirmed = true;
let ownerAvailable = true;
let currentRun = run;
let runnerVars = vars;
let authority = true;
let revokeAfterInspection = false;
const nativeCommands: string[] = [];
let rawCommands = 0;
const submit = mock.fn(async (..._args: unknown[]) => {
  if (!confirmed) throw new Error('Runner submission was not confirmed');
});
mock.module('../security/native-worker-owner.js', {
  namedExports: { assertNativeRunOwner: () => {} },
});
mock.module('../fleet/state.js', { namedExports: { loadPoolConfigs: async () => [] } });
mock.module('../runs/store.js', {
  namedExports: { getRun: () => (ownerAvailable ? currentRun : undefined) },
});
mock.module('../runners/native/node.js', {
  namedExports: {
    execNativeNodeArgv: async (_owner: string, _machine: string, argv: string[]) => {
      if (!authority) throw new Error('Native authority changed');
      if (argv[0] === 'node') {
        const input = JSON.parse(argv[3]!);
        operations.push(input.action);
        if (revokeAfterInspection) authority = false;
      } else nativeCommands.push(argv.join(' '));
      return { exitCode: 0, stdout: '[]', stderr: '' };
    },
  },
});
mock.module('../runners/review-tmux.js', {
  namedExports: {
    reviewTmuxSession: () => session,
    reviewTmuxOperation: async () => ({ exists: true }),
  },
});
mock.module('../runners/review-startup.js', {
  namedExports: { reviewWorkspaceRunnerVars: async () => runnerVars },
});
mock.module('../runners/registry.js', { namedExports: { sendRunnerPrompt: submit } });
mock.module('../core/exec.js', {
  namedExports: {
    ...actualExec,
    execFileArgv: async (argv: string[]) => {
      const input = JSON.parse(argv[3]!);
      operations.push(input.action);
      return { exitCode: 0, stdout: '[]', stderr: '' };
    },
  },
});
const { workspaceTerminalOperation } = await import('./workspace-terminal.js');
beforeEach(() => {
  operations.length = 0;
  submit.mock.resetCalls();
  confirmed = true;
  ownerAvailable = true;
  currentRun = run;
  runnerVars = vars;
  authority = true;
  revokeAfterInspection = false;
  nativeCommands.length = 0;
  rawCommands = 0;
});

test('workspace semantic send verifies ownership then uses the shared runner submitter', async () => {
  const text = 'Continue the retained review.\n'.repeat(80);
  await workspaceTerminalOperation(run, 'send', { text, enter: true });
  assert.deepEqual(operations, ['inspect']);
  assert.deepEqual(submit.mock.calls[0].arguments, [
    vars,
    session,
    'codex',
    text,
    { retainedSession: undefined },
  ]);
});

test('workspace semantic send does not confirm an unsubmitted long paste', async () => {
  confirmed = false;
  await assert.rejects(
    workspaceTerminalOperation(run, 'send', { text: 'Long steer.\n'.repeat(100), enter: true }),
    /submission.*not confirmed/i,
  );
  assert.equal(submit.mock.callCount(), 1);
});

test('workspace draft input remains raw and never requests submission', async () => {
  await workspaceTerminalOperation(run, 'send', { text: 'draft', enter: false });
  assert.deepEqual(operations, ['send']);
  assert.equal(submit.mock.callCount(), 0);
});

test('workspace cannot confirm delivery after its owner closes', async () => {
  submit.mock.mockImplementationOnce(async () => {
    ownerAvailable = false;
  });
  await assert.rejects(
    workspaceTerminalOperation(run, 'send', { text: 'Steer', enter: true }),
    /closed/,
  );
});

for (const phase of ['inspection', 'paste'] as const) {
  test(`remote submission retains owner authority after ${phase}`, async () => {
    const machine = 'remote-submission-proof';
    currentRun = {
      ...run,
      nativeOwnerPrincipalId: 'profile-owner',
      reviewWorkspace: { ...run.reviewWorkspace!, machine, executionNodeId: machine },
    };
    runnerVars = makeVars({ session, machine, host: 'remote.invalid' });
    // The ordinary slot broker can still have a connected socket after native authority revocation.
    const ws = {
      readyState: WebSocket.OPEN,
      send(raw: string) {
        rawCommands++;
        const frame = JSON.parse(raw);
        handleNodeResponse(
          frame.id,
          true,
          { exitCode: 0, stdout: '', stderr: '' },
          undefined,
          undefined,
          ws,
        );
      },
    } as WebSocket;
    registerNode(
      machine,
      1,
      ws,
      undefined,
      undefined,
      { ownerPrincipalId: 'profile-owner', supportsWorkers: true, supportsEnsure: true },
      { principalId: 'node-proof', valid: () => authority },
    );
    revokeAfterInspection = phase === 'inspection';
    submit.mock.mockImplementationOnce(async () => {
      await actualExec.execOnSlot(runnerVars, 'printf paste-step');
      authority = false;
      await actualExec.execOnSlot(runnerVars, 'printf enter-step');
    });
    try {
      await assert.rejects(
        workspaceTerminalOperation(currentRun, 'send', {
          text: 'Long review steer.\n'.repeat(100),
          enter: true,
        }),
        /authority changed/i,
      );
      assert.equal(
        rawCommands,
        0,
        'No submission command may fall back to the unfenced slot broker',
      );
      assert.equal(nativeCommands.length, phase === 'paste' ? 1 : 0);
    } finally {
      unregisterByWs(ws);
    }
  });
}
