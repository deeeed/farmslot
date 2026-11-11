import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { AgentContext, Run, RunStep } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

const registry = await import('../runners/registry.js');
const observer = registry.getRunnerObservability('codex');
assert(observer);
let terminalState: 'active' | 'idle' = 'active';
let nativeText = true;
let terminalAt = 20;
const runs = new Map<string, Run>();
const readWorker = mock.fn(async () => {
  throw new Error('Native source unavailable');
});
const security = await import('../security/native-worker-owner.js');
mock.module('../security/native-worker-owner.js', {
  namedExports: { ...security, assertNativeRunOwner: () => {} },
});
const actualWorker = await import('../runners/native/review-workspace.js');
mock.module('../runners/native/review-workspace.js', {
  namedExports: { ...actualWorker, readReviewWorkspaceWorker: readWorker },
});
mock.module('../runners/review-startup.js', {
  namedExports: { reviewWorkspaceRunnerVars: async () => makeVars({ session: 'retained' }) },
});
mock.module('../runners/registry.js', {
  namedExports: {
    ...registry,
    getRunnerObservability: () => ({
      ...observer,
      promptAccepted: async () => ({
        value: true,
        source: 'signal' as const,
        confidence: 'high' as const,
        observedAt: 10,
        exactPromptMatch: true,
      }),
      promptAcceptedInSession: nativeText
        ? async () => ({
            value: true,
            source: 'signal' as const,
            confidence: 'high' as const,
            observedAt: 10,
            exactPromptMatch: true,
          })
        : undefined,
      getSessionDeliveryState: async () => ({
        value: terminalState,
        source: 'signal' as const,
        confidence: 'high' as const,
        observedAt: terminalAt,
      }),
    }),
  },
});
function current(id: string): Run {
  const run = runs.get(id);
  assert(run);
  return run;
}
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getAllRuns: () => [...runs.values()],
    getRun: (id: string) => runs.get(id),
    persistRunNow: async () => {},
    updateRunStep: (id: string, name: string, patch: Partial<RunStep>) => {
      const step = current(id).steps.find((entry) => entry.name === name);
      assert(step);
      Object.assign(step, patch);
    },
  },
});
const { activeWorkspaceReviews, assertReviewWorkspaceCapacity, settleReviewWorkspaceFollowups } =
  await import('./admission.js');

function retained(transport: 'native' | 'tmux'): Run {
  const context: AgentContext = {
    id: 'review',
    role: 'review',
    label: 'Reviewer',
    runId: 'retained',
    slotId: null,
    status: 'waiting',
    runner: 'codex',
    model: 'gpt-6.1-sol',
    runnerSessionId: 'conversation',
    runnerSessionPath: '/owned/conversation.jsonl',
  };
  if (transport === 'native')
    context.nativeSession = {
      sessionId: 'host-session',
      leaseId: 'lease',
      generation: 'generation',
      commandId: 'original-command',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
    };
  const run: Run = {
    ...makeRun({ id: 'retained', flowType: 'review-pr', slotId: null, status: 'human-gating' }),
    nativeOwnerPrincipalId: 'owner',
    transport,
    reviewWorkspaceTarget: { machine: 'node' },
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'node',
      executionNodeId: 'local',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
      retainedAt: '2026-11-11T00:00:00Z',
    },
    reviewResult: {
      recommendation: 'APPROVE',
      reviewMd: 'Saved review',
      lineComments: [],
      artifactManifest: [],
    },
    agentContexts: [context],
    steps: [
      {
        name: 'human-gate',
        status: 'running',
        outputs: {
          reviewFollowupCommandId: 'follow-up',
          ...(transport === 'tmux'
            ? {
                reviewFollowupTerminal: {
                  sessionId: 'conversation',
                  sessionPath: '/owned/conversation.jsonl',
                  message: 'Explain the finding',
                  since: 1,
                },
              }
            : {}),
        },
      },
    ],
  };
  runs.set(run.id, run);
  return run;
}
beforeEach(() => {
  runs.clear();
  readWorker.mock.resetCalls();
  terminalState = 'active';
  terminalAt = 20;
  nativeText = true;
});

test('a stopped review clears a stale follow-up without reading its unavailable host', async () => {
  const run = retained('native');
  run.status = 'done';
  assert(run.reviewWorkspace);
  run.reviewWorkspace.executionStoppedAt = '2026-11-11T00:00:02Z';
  const binding = run.agentContexts?.[0].nativeSession;
  assert(binding);
  binding.closedAt = '2026-11-11T00:00:02Z';
  await settleReviewWorkspaceFollowups('node', 'owner');
  assert.equal(readWorker.mock.callCount(), 0);
  assert.equal(run.steps[0].outputs?.reviewFollowupCommandId, undefined);
  assert.doesNotThrow(() => assertReviewWorkspaceCapacity('node', 1));
});

test('an uncertain live follow-up keeps only its reservation and exposes its read failure', async () => {
  const run = retained('native');
  await settleReviewWorkspaceFollowups('node', 'owner');
  assert.equal(run.steps[0].outputs?.reviewFollowupCommandId, 'follow-up');
  assert.equal(run.steps[0].outputs?.reviewFollowupObservationError, 'Native source unavailable');
  assert.equal(activeWorkspaceReviews('node', [...runs.values()]), 1);
  assert.doesNotThrow(() => assertReviewWorkspaceCapacity('node', 2));
});

test('terminal follow-up capacity clears only after exact acceptance and structured idle', async () => {
  const run = retained('tmux');
  await settleReviewWorkspaceFollowups('node', 'owner');
  assert.equal(activeWorkspaceReviews('node', [...runs.values()]), 1);
  assert.throws(() => assertReviewWorkspaceCapacity('node', 1), {
    code: 'REVIEW_WORKSPACE_CAPACITY',
  });
  terminalState = 'idle';
  await settleReviewWorkspaceFollowups('node', 'owner');
  assert.equal(run.steps[0].outputs?.reviewFollowupCommandId, undefined);
  assert.equal(activeWorkspaceReviews('node', [...runs.values()]), 0);
  assert.equal(readWorker.mock.callCount(), 0);
});

test('digest-only observers release a completed retained terminal turn', async () => {
  const run = retained('tmux');
  nativeText = false;
  terminalState = 'idle';
  await settleReviewWorkspaceFollowups('node', 'owner');
  assert.equal(run.steps[0].outputs?.reviewFollowupCommandId, undefined);
  assert.equal(activeWorkspaceReviews('node', [...runs.values()]), 0);
});

test('raw terminal input keeps capacity until that exact session ends a newer turn', async () => {
  const run = retained('tmux');
  run.steps[0].outputs!.reviewFollowupTerminal = {
    sessionId: 'conversation',
    sessionPath: '/owned/conversation.jsonl',
    since: 21,
  };
  terminalState = 'idle';
  await settleReviewWorkspaceFollowups('node', 'owner');
  assert.equal(
    activeWorkspaceReviews('node', [...runs.values()]),
    1,
    'old idle cannot release raw input',
  );
  terminalAt = 30;
  await settleReviewWorkspaceFollowups('node', 'owner');
  assert.equal(activeWorkspaceReviews('node', [...runs.values()]), 0);
});
