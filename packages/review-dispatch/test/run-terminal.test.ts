import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import { runReviewerView, runTerminalView } from '../src/run-activity.js';

const worker: AgentContext = {
  id: 'dev',
  role: 'dev',
  label: 'Worker',
  status: 'working',
  runId: 'run-a',
  slotId: 'slot-a',
  target: { session: 'worker-session', window: 'dev', target: 'worker-session:dev.0' },
};
const reviewer: AgentContext = {
  id: 'rev-proof-3',
  role: 'review',
  label: 'Reviewer',
  status: 'working',
  runId: 'run-a',
  slotId: 'review-slot',
  attemptStartedAt: '2026-10-21T12:00:00Z',
  target: {
    session: 'review-session',
    window: 'rev-proof-3',
    target: 'review-session:rev-proof-3.1',
  },
};
function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-a',
    familyId: 'run-a',
    parentRunId: null,
    familyRootTicketOrPr: 'TERMINAL',
    flowType: 'dev',
    lane: 'production',
    variant: null,
    mode: 'interactive',
    status: 'monitoring',
    project: 'fixture',
    ticketOrPr: 'TERMINAL',
    slotId: 'slot-a',
    branch: 'feature',
    taskFile: null,
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-6.1-sol' },
    steps: [],
    decisions: [],
    agentContexts: [worker],
    createdAt: '2026-10-21T10:00:00Z',
    updatedAt: '2026-10-21T12:00:00Z',
    ...overrides,
  };
}

test('an active run opens its exact worker, while the running reviewer takes precedence', () => {
  const active = run();
  assert.deepEqual(runTerminalView(active).target, {
    slotId: 'slot-a',
    runId: 'run-a',
    role: 'dev',
    contextId: 'dev',
  });
  const reviewing = runTerminalView(run({ agentContexts: [worker, reviewer] }));
  assert.equal(reviewing.disabledReason, null);
  assert.deepEqual(reviewing.target, {
    slotId: 'review-slot',
    runId: 'run-a',
    role: 'review',
    contextId: 'rev-proof-3',
  });
  assert.deepEqual(reviewing.context?.target, reviewer.target);
  assert.equal(
    runTerminalView(run({ agentContexts: [worker, { ...reviewer, status: 'complete' }] })).context
      ?.id,
    'dev',
  );
});

test('a finished run keeps its action disabled even when its old slot and context remain', () => {
  for (const status of ['done', 'failed', 'cancelled'] as const)
    assert.equal(runTerminalView(run({ status })).disabledReason, 'This run is finished.');
});

test('Ask reviewer keeps the completed reviewer instead of selecting its active producing worker', () => {
  const view = runReviewerView(
    run({
      status: 'human-gating',
      agentContexts: [worker, { ...reviewer, status: 'waiting' }],
    }),
  );
  assert.equal(view.label, 'Ask reviewer');
  assert.equal(view.context?.id, reviewer.id);
  assert.equal(view.target?.slotId, 'review-slot');
  assert.equal(view.disabledReason, null);
  assert.equal(runReviewerView(run()).target, null);
});

test('native reviewers keep their own conversation binding on a tmux producing run', () => {
  const native: AgentContext = {
    ...reviewer,
    nativeSession: {
      sessionId: 'review-native',
      executionNodeId: 'review-node',
      ownerPrincipalId: 'person',
      generation: 'generation',
      leaseId: 'review-lease',
      commandId: 'review-command',
    },
  };
  const view = runTerminalView(run({ transport: 'tmux', agentContexts: [worker, native] }));
  assert.equal(view.label, 'Open conversation');
  assert.equal(view.context?.nativeSession?.sessionId, 'review-native');
  assert.equal(view.context?.nativeSession?.executionNodeId, 'review-node');
});

test('a removed explicit session never opens another actor', () => {
  const view = runTerminalView(run({ agentContexts: [worker, reviewer] }), 'removed-review');
  assert.equal(view.target, null);
  assert.match(view.disabledReason ?? '', /no longer available/);
});

test('a native fix opens the same-run owner of its recorded session and lease', () => {
  const nativeWorker: AgentContext = {
    ...worker,
    nativeSession: {
      sessionId: 'worker-native',
      executionNodeId: 'worker-node',
      ownerPrincipalId: 'person',
      generation: 'generation',
      leaseId: 'worker-lease',
      commandId: 'initial',
    },
  };
  const fix: AgentContext = {
    ...reviewer,
    id: 'fix',
    role: 'review-fix',
    slotId: nativeWorker.slotId,
    target: null,
    nativeSessionOwner: {
      contextId: 'dev',
      sessionId: 'worker-native',
      leaseId: 'worker-lease',
    },
  };
  const view = runTerminalView(run({ transport: 'native', agentContexts: [nativeWorker, fix] }));
  assert.equal(view.context?.id, 'fix');
  assert.equal(view.label, 'Open conversation');
  assert.equal(view.target?.contextId, 'fix');
});
