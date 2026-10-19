import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AgentContext, NativeSessionReadResult, Run } from '@farmslot/protocol';

const error = 'Native runner emitted invalid JSON';
const failedSession = '3c9dd59b-8912-416a-aa8e-f87a7102b8b4';
const relaunchSession = 'f7c71b68-dd9c-4c9c-a27a-9c6ea1a5687f';
let current: Run | undefined;

const binding = (sessionId: string) => ({
  sessionId,
  generation: `${sessionId}-generation`,
  leaseId: `${sessionId}-lease`,
  commandId: `${sessionId}-command`,
  ownerPrincipalId: 'farm-automation',
  executionNodeId: 'macpro',
});
// The host keeps the dead reviewer's session failed after its relaunch (session-1ab73d55.json).
const failedSnapshot: NativeSessionReadResult = {
  session: {
    id: failedSession,
    generation: binding(failedSession).generation,
    workerLeaseId: binding(failedSession).leaseId,
    ownerPrincipalId: 'farm-automation',
    executionNodeId: 'macpro',
    state: 'failed',
    error,
    processStopped: true,
    processPid: 86206,
    hostPid: 886,
    runner: 'claude',
    nativeSessionId: 'd49f2a31-f967-47f6-929a-367f3094957b',
    accountContextId: 'native-node',
    cwd: '/fixture',
    executable: 'claude',
    version: '2.1.302',
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

const store = await import('../../runs/store.js');
mock.module('../../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) => (id === current?.id ? current : undefined),
    updateRun: (id: string, patch: Partial<Run>) => {
      if (!current || id !== current.id) throw new Error(`unexpected run ${id}`);
      current = { ...current, ...patch };
      return current;
    },
  },
});
mock.module('./node.js', { namedExports: { routeNativeExecution: async () => failedSnapshot } });
const owner = await import('../../security/native-worker-owner.js');
mock.module('../../security/native-worker-owner.js', {
  namedExports: { ...owner, assertNativeRunOwner: () => {} },
});
const { clearSupersededWorkerError, readNativeWorkerSnapshot } =
  await import('./worker-control.js');
const { reconcileNativeRunAgentRuntime } = await import('./worker-runtime.js');
const { makeRun } = await import('../../run-engine/test-fixtures.js');

// TAT-4146 v2 run 70bf7864 at 16:24Z: the reviewer died, its relaunch was working (Review: 4/8
// steps), and run.error still showed the dead reviewer's failure.
const reviewer = (sessionId: string, overrides: Partial<AgentContext>): AgentContext => ({
  id: `rev-claude-native-e70880c75f12-${sessionId.slice(0, 8)}`,
  runId: '70bf7864-d119-4f5f-8fa3-e8106aaf81ab',
  role: 'review',
  label: 'rev-claude (opus)',
  status: 'working',
  runner: 'claude',
  model: 'opus',
  reviewId: 'pipeline-review-70bf7864-d119-4f5f-8fa3-e8106aaf81ab',
  slotId: 'macpro-mmt-2',
  nativeSession: binding(sessionId),
  ...overrides,
});
const failed = reviewer(failedSession, {
  status: 'failed',
  error,
  nativeSession: { ...binding(failedSession), closedAt: '2026-10-18T16:24:20.049Z' },
});
const relaunch = (overrides: Partial<AgentContext> = {}) =>
  reviewer(relaunchSession, {
    nativeSession: { ...binding(relaunchSession), acceptedAt: '2026-10-18T16:24:54.394Z' },
    ...overrides,
  });
const run = (runError: string, next: AgentContext): Run => ({
  ...makeRun({ id: '70bf7864-d119-4f5f-8fa3-e8106aaf81ab', status: 'reviewing' }),
  error: runError,
  agentContexts: [failed, next],
});

test('a running relaunch clears its predecessor failure, and a restart does not put it back', async () => {
  current = run(error, relaunch());
  clearSupersededWorkerError(current.id);
  assert.equal(current.error, undefined);
  // Gateway restart: runtime reconciliation reads every unreleased binding, the failed one too.
  await readNativeWorkerSnapshot(current.id, undefined, failed.id);
  assert.equal(current.error, undefined);
  assert.equal(current.agentContexts?.[0]?.error, error);
});

test('run.error stays for another failure, a relaunch not yet accepted, or another review', async () => {
  const unaccepted = relaunch({ status: 'launching', nativeSession: binding(relaunchSession) });
  for (const [name, runError, next] of [
    ['another run error', 'Gate failed', relaunch()],
    ['relaunch not accepted', error, unaccepted],
    ['another review', error, relaunch({ reviewId: 'pipeline-review-other' })],
  ] as const) {
    current = run(runError, next);
    clearSupersededWorkerError(current.id);
    assert.equal(current.error, runError, name);
  }
  // Until a relaunch accepts its task, the failed reviewer's error is the run's error.
  current = run('', unaccepted);
  await readNativeWorkerSnapshot(current.id, undefined, failed.id);
  assert.equal(current.error, error);
});

test("a closed reviewer from an earlier round leaves a tmux worker's block reason on the run", async () => {
  // TAT-4006 7721a02b at the 16:50Z restart: dev and review-fix are tmux claude, and the round-3
  // native reviewer, closed at 15:33Z, still carries its host failure under another review id.
  const workerReason = 'Operator item 1 (deposit split) cannot run in this checkout.';
  const tmuxWorker = (role: 'dev' | 'review-fix'): AgentContext => ({
    id: role,
    runId: '7721a02b-ceda-431a-a741-d743837c40b4',
    role,
    label: role,
    status: 'blocked',
    runner: 'claude',
    slotId: 'macwork-coredev-2',
  });
  current = {
    ...makeRun({ id: '7721a02b-ceda-431a-a741-d743837c40b4', status: 'blocked' }),
    error: workerReason,
    agentContexts: [
      { ...failed, reviewId: 'rev-claude-native-d3e2200a889b-0941e7a0' },
      tmuxWorker('dev'),
      tmuxWorker('review-fix'),
    ],
  };
  await reconcileNativeRunAgentRuntime(current);
  assert.equal(current.error, workerReason);
});
