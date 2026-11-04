import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

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
const submit = mock.fn(async (..._args: unknown[]) => {
  if (!confirmed) throw new Error('Runner submission was not confirmed');
});
mock.module('../security/native-worker-owner.js', {
  namedExports: { assertNativeRunOwner: () => {} },
});
mock.module('../fleet/state.js', { namedExports: { loadPoolConfigs: async () => [] } });
mock.module('../runs/store.js', {
  namedExports: { getRun: () => (ownerAvailable ? run : undefined) },
});
mock.module('../runners/native/node.js', {
  namedExports: {
    execNativeNodeArgv: () => {
      throw new Error('Unexpected remote execution');
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
  namedExports: { reviewWorkspaceRunnerVars: async () => vars },
});
mock.module('../runners/registry.js', { namedExports: { sendRunnerPrompt: submit } });
mock.module('../core/exec.js', {
  namedExports: {
    isLocal: () => true,
    execArgvOnSlot: async () => {
      throw new Error('Unexpected slot argv execution');
    },
    execLocal: async () => {
      throw new Error('Unexpected local execution');
    },
    execOnSlot: async () => {
      throw new Error('Unexpected slot execution');
    },
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
