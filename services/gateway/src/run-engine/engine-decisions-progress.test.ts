import assert from 'node:assert/strict';
import test from 'node:test';

import { Events, type Run } from '@farmslot/protocol';

import type { RunProgressObservation } from '../runners/run-progress.js';

await import('../runtime/mock-pty.test-support.js');
const store = await import('../runs/store.js');
const progressReader = await import('../runners/run-progress.js');
const { makeRun } = await import('./test-fixtures.js');

function createObservedRun(t: { after(callback: () => Promise<void>): void }): Run {
  const run = store.createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'PROGRESS-FENCE' });
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
