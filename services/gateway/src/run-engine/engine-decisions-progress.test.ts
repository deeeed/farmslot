import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type BranchAffinityNudgePayload,
  Events,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import type { RunProgressObservation } from '../runners/run-progress.js';

import { canReplayBranchAffinityDecision } from './decision-replay.js';

await import('../runtime/mock-pty.test-support.js');
const store = await import('../runs/store.js');
const progressReader = await import('../runners/run-progress.js');
const { makeRun } = await import('./test-fixtures.js');

function createObservedRun(
  t: { after(callback: () => Promise<void>): void },
  ticketOrPr = 'PROGRESS-FENCE',
): Run {
  const run = store.createRun({ flowType: 'dev', project: 'demo', ticketOrPr });
  store.updateRun(run.id, { status: 'monitoring', engineState: { generation: 1 } });
  t.after(async () => {
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  });
  return run;
}

let observe: () => Promise<RunProgressObservation> = async () => ({ kind: 'idle' });
const { createEngineDecision, resolveEngineDecision, setEngineDecisionRuntime } =
  await import('./engine-decisions.js');

for (const reason of ['human_gate', 'review_posting', 'no_change']) {
  test(`${reason} labels an operator wait only after its decision is published`, async (t) => {
    const run = store.createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'GATE-PREPARING' });
    store.updateRun(run.id, {
      status: 'human-gating',
      steps: [{ name: 'human-gate', status: 'running', detail: 'Preparing operator decision' }],
    });
    let started!: () => void;
    let release!: (value: RunProgressObservation) => void;
    let published!: () => void;
    const observing = new Promise<void>((resolve) => (started = resolve));
    const observed = new Promise<RunProgressObservation>((resolve) => (release = resolve));
    const presentation = new Promise<void>((resolve) => (published = resolve));
    let presented: Run | undefined;
    setEngineDecisionRuntime({
      broadcast: (event) => {
        if (event !== Events.RUN_DECISION_NEW) return;
        presented = structuredClone(store.getRun(run.id));
        published();
      },
      stepToStatus: { 'human-gate': 'human-gating' },
    });
    const waiter = createEngineDecision(
      run.id,
      reason,
      'Ready',
      [{ id: 'abort', label: 'Abort', style: 'secondary' }],
      undefined,
      {
        readProgress: async () => {
          started();
          return observed;
        },
      },
    );
    t.after(async () => {
      release({ kind: 'idle' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const decision of store.getRun(run.id)?.decisions ?? [])
        if (!decision.resolvedAt) resolveEngineDecision(decision.id, 'abort');
      await waiter;
      store.updateRun(run.id, { status: 'cancelled' });
      await store.deleteRun(run.id);
      setEngineDecisionRuntime({ broadcast: () => {}, stepToStatus: {} });
    });
    await observing;
    assert.deepEqual(store.getRun(run.id)!.decisions, []);
    assert.equal(store.getRun(run.id)!.steps[0].detail, 'Preparing operator decision');
    release({ kind: 'idle' });
    await presentation;
    assert(presented);
    assert.equal(presented.decisions.length, 1);
    assert.equal(presented.decisions[0].resolvedAt, undefined);
    assert.equal(presented.steps[0].detail, 'Waiting for operator decision');
  });
}

test('Fresh approval for A re-prompts when source restart ranks worker B first', async (t) => {
  const run = createObservedRun(t);
  const workerA = createObservedRun(t, 'TASK-A');
  const workerB = createObservedRun(t, 'TASK-B');
  const payload = (worker: Run, slotId: string): BranchAffinityNudgePayload => ({
    kind: 'branch_affinity_nudge',
    project: run.project,
    ticketOrPr: run.ticketOrPr,
    candidate: {
      slotId,
      machine: 'node',
      branch: 'shared-pr-branch',
      runner: null,
      model: null,
      nudgeCount: 0,
      ctxPct: null,
      agentStatus: 'working',
      dispatchedAt: worker.createdAt,
      currentRunId: worker.id,
      currentFlowType: worker.flowType,
      uncommittedCount: 0,
      uncommittedFiles: [],
      prMatchKind: 'branch-slug',
      canNudge: false,
    },
    freeSlotCandidates: [],
    riskFlags: [],
  });
  const actions = [
    { id: 'fresh', label: 'Fresh', style: 'primary' as const },
    { id: 'abort', label: 'Abort', style: 'secondary' as const },
  ];
  const approved: RunDecision = {
    id: 'approved-worker-a',
    type: 'engine_branch_affinity_nudge',
    title: 'Fresh A',
    description: 'Approved original worker',
    actions,
    createdAt: run.createdAt,
    resolvedAt: run.createdAt,
    resolvedAction: 'fresh',
    payload: payload(workerA, 'slot-a'),
  };
  store.updateRun(run.id, { decisions: [approved] });
  const receipt = structuredClone(approved);
  const beforeA = structuredClone(store.getRun(workerA.id));
  const beforeB = structuredClone(store.getRun(workerB.id));
  const current = payload(workerB, 'slot-b');
  assert.equal(canReplayBranchAffinityDecision(approved, payload(workerA, 'slot-a')), true);
  setEngineDecisionRuntime({ broadcast: () => {}, stepToStatus: {} });
  let resumed = false;
  const waiter = createEngineDecision(
    run.id,
    'branch_affinity_nudge',
    'Fresh B',
    actions,
    current,
    {
      canReplay: (prior) => canReplayBranchAffinityDecision(prior, current),
      readProgress: async () => ({ kind: 'idle' }),
    },
  ).then((action) => {
    resumed = true;
    return action;
  });
  t.after(async () => {
    for (const decision of store.getRun(run.id)?.decisions ?? [])
      if (!decision.resolvedAt) resolveEngineDecision(decision.id, 'abort');
    await waiter;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resumed, false, 'A must not authorize Fresh against B');
  const decisions = store.getRun(run.id)!.decisions;
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions[0], receipt, 'the original approval remains recorded');
  assert.deepEqual(decisions[1].payload, current);
  assert.deepEqual(store.getRun(workerA.id), beforeA);
  assert.deepEqual(store.getRun(workerB.id), beforeB, 'worker B remains untouched');
  resolveEngineDecision(decisions[1].id, 'abort');
  assert.equal(await waiter, 'abort');
});

for (const [label, interrupt] of [
  ['cancel', { status: 'cancelled' }],
  ['pause', { status: 'paused' }],
  ['replay', { engineState: { generation: 2 } }],
] as const) {
  test(`a ${label} during runner observation cannot publish a decision or revive the run`, async (t) => {
    const run = createObservedRun(t);
    const broadcasts: string[] = [];
    setEngineDecisionRuntime({ broadcast: (event) => broadcasts.push(event), stepToStatus: {} });
    let started!: () => void;
    let release!: (value: RunProgressObservation) => void;
    const observing = new Promise<void>((resolve) => (started = resolve));
    const result = new Promise<RunProgressObservation>((resolve) => (release = resolve));
    observe = async () => {
      started();
      return result;
    };
    const decision = createEngineDecision(run.id, 'collision', 'Check collision', [], undefined, {
      readProgress: () => observe(),
    });
    await observing;
    store.updateRun(run.id, interrupt);
    release({ kind: 'idle' });
    await assert.rejects(decision, /changed during the progress observation/);
    const after = store.getRun(run.id)!;
    assert.deepEqual(after.decisions, []);
    assert.equal(after.status, 'status' in interrupt ? interrupt.status : 'monitoring');
    assert.deepEqual(broadcasts, []);
  });
}

test('cancelling a published decision preserves the terminal status when its waiter settles', async (t) => {
  const run = createObservedRun(t);
  observe = async () => ({ kind: 'idle' });
  let published!: () => void;
  const publication = new Promise<void>((resolve) => (published = resolve));
  setEngineDecisionRuntime({
    broadcast: (event) => {
      if (event === Events.RUN_DECISION_NEW) published();
    },
    stepToStatus: {},
  });
  const waiter = createEngineDecision(
    run.id,
    'collision',
    'Check collision',
    [{ id: 'abort', label: 'Abort', style: 'secondary' }],
    undefined,
    { readProgress: () => observe() },
  );
  await publication;
  const pending = store.getRun(run.id)!;
  store.updateRun(run.id, { status: 'cancelled' });
  resolveEngineDecision(pending.decisions[0].id, 'abort');
  assert.equal(await waiter, 'abort');
  assert.equal(store.getRun(run.id)!.status, 'cancelled');
});

test('pending decisions preserve observed work and refuse to label unknown progress blocked', () => {
  const status = progressReader.runDecisionWaitingStatus;
  const run = makeRun({ status: 'human-gating' });
  assert.equal(
    status(run, { kind: 'making-progress', activeRole: 'review-fix' }, 'human_gate'),
    'fixing',
  );
  assert.equal(
    status(run, { kind: 'making-progress', activeRole: 'review' }, 'human_gate'),
    'reviewing',
  );
  assert.equal(
    status(run, { kind: 'making-progress', activeRole: 'primary' }, 'human_gate'),
    'monitoring',
  );
  assert.equal(status(run, { kind: 'unproven' }, 'human_gate'), 'reconciling');
  assert.equal(status(run, { kind: 'awaiting-input' }, 'human_gate'), 'blocked');
  assert.equal(status(run, { kind: 'idle' }, 'human_gate'), 'human-gating');
  const failedReview = makeRun({
    status: 'review-failed',
    engineState: {
      publishGate: {
        reviewRecovery: {
          status: 'operator-required',
          attempts: 1,
          startedAt: '2026-10-12T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:00.000Z',
        },
      },
    },
  });
  assert.equal(status(failedReview, { kind: 'idle' }, 'human_gate'), 'review-failed');
  assert.equal(
    status(failedReview, { kind: 'making-progress', activeRole: 'primary' }, 'human_gate'),
    'monitoring',
  );
});

test('a gate that opens a new decision supersedes the one still open before it', async (t) => {
  const run = createObservedRun(t, 'GATE-SUPERSEDE');
  // Left open by another driver of the same gate (7e88468f had two open at once).
  const stale: RunDecision = {
    id: 'stale-gate',
    type: 'engine_human_gate',
    title: 'Publication package is unavailable',
    description: 'Retry this gate.',
    actions: [{ id: 'hold', label: 'Retry Gate', style: 'secondary' }],
    createdAt: '2026-10-31T15:08:51.529Z',
  };
  store.updateRun(run.id, { decisions: [stale] });
  let published!: () => void;
  const presentation = new Promise<void>((resolve) => (published = resolve));
  setEngineDecisionRuntime({
    broadcast: (event) => {
      if (event === Events.RUN_DECISION_NEW) published();
    },
    stepToStatus: {},
  });
  t.after(() => setEngineDecisionRuntime({ broadcast: () => {}, stepToStatus: {} }));
  const waiter = createEngineDecision(
    run.id,
    'human_gate',
    'Package ready',
    [{ id: 'abort', label: 'Abort', style: 'secondary' }],
    undefined,
    { readProgress: async () => ({ kind: 'idle' }) },
  );
  await presentation;
  const decisions = store.getRun(run.id)!.decisions;
  const open = decisions.filter((decision) => !decision.resolvedAt);
  assert.equal(open.length, 1, 'exactly one live gate decision');
  const previous = decisions.find((decision) => decision.id === 'stale-gate')!;
  assert.equal(previous.resolvedAction, 'superseded');
  assert.equal(previous.context?.supersededBy, open[0]!.id);
  resolveEngineDecision(open[0]!.id, 'abort');
  assert.equal(await waiter, 'abort');
});
