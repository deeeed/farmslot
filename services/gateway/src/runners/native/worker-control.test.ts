import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentContext,
  NativeSessionReadResult,
  NativeWorkerSessionBinding,
} from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

import {
  checkAgentLive,
  shouldHoldForMissingTerminalSignal,
} from '../../run-engine/run-monitor.js';
import { deleteTestRunIfPresent } from '../../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../../runs/store.js';
import { makeVars } from '../test-fixtures.js';

import {
  assertNativeWorkerSnapshot,
  clearSupersededWorkerError,
  nativeWorkerLiveStatus,
} from './worker-control.js';

const binding: NativeWorkerSessionBinding = {
  sessionId: 'session',
  generation: 'generation',
  leaseId: 'task',
  commandId: 'command',
  ownerPrincipalId: 'owner',
  executionNodeId: 'node',
};
function snapshot(state: NativeSessionReadResult['session']['state']): NativeSessionReadResult {
  return {
    session: {
      id: binding.sessionId,
      generation: binding.generation!,
      workerLeaseId: binding.leaseId,
      ownerPrincipalId: binding.ownerPrincipalId,
      executionNodeId: binding.executionNodeId,
      state,
      processPid: 123,
      hostPid: 122,
      runner: 'codex',
      nativeSessionId: 'conversation',
      accountContextId: 'account',
      cwd: '/fixture',
      executable: 'codex',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: true,
        questions: true,
        interrupt: true,
        resume: true,
      },
    },
    events: [],
    pendingRequests: [],
    commands: [],
    cursor: 0,
    hasMore: false,
  };
}

test('native idle and waiting remain live; uncertain process cleanup is never a completed task', () => {
  for (const state of ['idle', 'running', 'waiting'] as const)
    assert.equal(nativeWorkerLiveStatus(snapshot(state)), 'working');
  for (const state of ['closed', 'failed'] as const) {
    const read = snapshot(state);
    assert.equal(nativeWorkerLiveStatus(read), 'unknown');
    read.session.processStopped = true;
    assert.equal(nativeWorkerLiveStatus(read), 'idle');
  }
  assert.equal(nativeWorkerLiveStatus(snapshot('starting')), 'unknown');
  assert.equal(
    shouldHoldForMissingTerminalSignal(
      { requireSignal: false },
      {
        transport: 'native',
        flowType: 'pr-complete',
        mode: 'interactive',
      },
    ),
    true,
  );
  assert.equal(
    shouldHoldForMissingTerminalSignal(
      { requireSignal: false },
      {
        transport: 'tmux',
        flowType: 'pr-complete',
        mode: 'interactive',
      },
    ),
    false,
  );
});

test('monitor keeps a retained native worker live between turns and requires confirmed shutdown', async (t) => {
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'fixture-service';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  });
  const run = createRun(
    {
      project: 'fixture',
      flowType: 'dev',
      mode: 'autonomous',
      ticketOrPr: 'WAIT-1',
      transport: 'native',
      runner: 'codex',
    },
    { nativeOwnerPrincipalId: 'fixture-service' },
  );
  t.after(() => deleteTestRunIfPresent(run.id));
  for (const state of ['idle', 'running', 'waiting', 'closed', 'failed'] as const) {
    const read = snapshot(state);
    const observe = () =>
      checkAgentLive('fixture-slot', 'codex', run.id, undefined, undefined, {
        native: async () => read,
      });
    const terminal = state === 'closed' || state === 'failed';
    assert.equal(await observe(), terminal ? 'unknown' : 'working', state);
    if (terminal) {
      read.session.processStopped = true;
      assert.equal(await observe(), 'idle', state);
    }
  }
});

test('monitor distinguishes a live prompt, confirmed exit, lost pane and uncertain process evidence', async () => {
  for (const state of ['present', 'absent', 'unknown', 'no-pane'] as const) {
    const live = await checkAgentLive('fixture-slot', 'claude', undefined, undefined, undefined, {
      slot: async () => makeVars(),
      target: async () => ({ target: '%1', session: 'fixture' }),
      exec: async () => ({ exitCode: 0, stdout: state === 'no-pane' ? '' : '123', stderr: '' }),
      process: async () =>
        state === 'present'
          ? { state: 'present', pid: '124' }
          : state === 'absent'
            ? { state: 'absent' }
            : { state: 'unknown', code: 'probe-transport', reason: 'Process census unavailable' },
    });
    assert.equal(
      live,
      state === 'present'
        ? 'working'
        : state === 'absent'
          ? 'idle'
          : state === 'no-pane'
            ? 'no-tmux'
            : 'unknown',
    );
  }
});

test('native observation rejects another owner, node, session, generation or task lease', () => {
  assert.doesNotThrow(() => assertNativeWorkerSnapshot(binding, snapshot('idle')));
  for (const key of [
    'id',
    'generation',
    'ownerPrincipalId',
    'executionNodeId',
    'workerLeaseId',
  ] as const) {
    const read = snapshot('idle');
    read.session[key] = 'different';
    assert.throws(() => assertNativeWorkerSnapshot(binding, read), /changed/);
  }
});

test('worker observations reject another profile registration even with the same task lease', () => {
  const profile = {
    executionNodeId: binding.executionNodeId,
    runner: 'codex',
    profileId: 'work',
    accountContextId: '00000000-0000-4000-8000-000000000001',
  };
  const read = snapshot('idle');
  read.session.profileId = profile.profileId;
  read.session.accountContextId = profile.accountContextId;
  assert.doesNotThrow(() => assertNativeWorkerSnapshot({ ...binding, profile }, read));
  for (const field of ['executionNodeId', 'runner'] as const)
    assert.throws(
      () =>
        assertNativeWorkerSnapshot(
          { ...binding, profile: { ...profile, [field]: 'different' } },
          read,
        ),
      /changed/,
    );
  assert.throws(() => assertNativeWorkerSnapshot(binding, read), /changed/);
  read.session.accountContextId = 'another-registration';
  assert.throws(() => assertNativeWorkerSnapshot({ ...binding, profile }, read), /changed/);
});

// TAT-4146 v2 70bf7864, 16:24Z: the reviewer died on an oversized event, its relaunch was working
// (Review: 4/8 steps), and run.error still showed the dead reviewer's failure.
test('a running relaunch clears the failure its predecessor left in run.error', async (t) => {
  const error = 'Native runner emitted invalid JSON';
  const reviewer = (
    runId: string,
    suffix: string,
    sessionId: string,
    closedAt?: string,
  ): AgentContext => ({
    id: `rev-claude-native-e70880c75f12-${suffix}`,
    runId,
    role: 'review',
    label: 'rev-claude (opus)',
    status: 'working',
    runner: 'claude',
    model: 'opus',
    reviewId: 'pipeline-review-70bf7864-d119-4f5f-8fa3-e8106aaf81ab',
    slotId: 'macpro-mmt-2',
    nativeSession: { ...binding, sessionId, executionNodeId: 'macpro', closedAt },
  });
  const cases: Array<{
    name: string;
    runError: string;
    relaunch?: Partial<AgentContext>;
    cleared: boolean;
  }> = [
    { name: 'relaunch running', runError: error, cleared: true },
    { name: 'other run error', runError: 'Gate failed', cleared: false },
    {
      name: 'relaunch not running yet',
      runError: error,
      relaunch: { status: 'launching' },
      cleared: false,
    },
    {
      name: 'another review',
      runError: error,
      relaunch: { reviewId: 'pipeline-review-other' },
      cleared: false,
    },
  ];
  for (const { name, runError, relaunch, cleared } of cases) {
    const run = createRun({ project: 'fixture', flowType: 'dev', ticketOrPr: 'TAT-4146' });
    const failed: AgentContext = {
      ...reviewer(
        run.id,
        '1ab73d55',
        '3c9dd59b-8912-416a-aa8e-f87a7102b8b4',
        '2026-10-18T16:24:20.049Z',
      ),
      status: 'failed',
      error,
    };
    const relaunchSession = 'f7c71b68-dd9c-4c9c-a27a-9c6ea1a5687f';
    const next = { ...reviewer(run.id, '3a5e402b', relaunchSession), ...relaunch };
    updateRun(run.id, { status: 'reviewing', error: runError, agentContexts: [failed, next] });
    t.after(() => {
      // Close the fixture relaunch so the store lets the run go.
      updateRun(run.id, {
        agentContexts: [
          failed,
          {
            ...next,
            nativeSession: reviewer(run.id, '3a5e402b', relaunchSession, new Date().toISOString())
              .nativeSession,
          },
        ],
      });
      return deleteTestRunIfPresent(run.id);
    });
    clearSupersededWorkerError(run.id, next.id);
    assert.equal(getRun(run.id)?.error, cleared ? undefined : runError, name);
  }
});
