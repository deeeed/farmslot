import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

const store = await import('../runs/store.js');
let persistFailure: Error | undefined;
let persistGate: Promise<void> | undefined;
let enteredPersist = () => {};
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    persistRunNow: async (...args: Parameters<typeof store.persistRunNow>) => {
      enteredPersist();
      await persistGate;
      if (persistFailure) throw persistFailure;
      await store.persistRunNow(...args);
    },
  },
});
const modulePath = './orchestrator.js?durable-boundary';
const { recordReviewFixDeliveryBoundary }: typeof import('./orchestrator.js') = await import(
  modulePath
);
const { rewriteStatusFile } = await import('../core/state.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');

async function fixture(t: TestContext) {
  persistFailure = undefined;
  persistGate = undefined;
  enteredPersist = () => {};
  const run = store.createRun({
    flowType: 'dev',
    project: 'durable-fix',
    ticketOrPr: 'PROJ-217',
    slotId: 'durable-fixture',
  });
  const context: AgentContext = {
    id: 'review-fix',
    role: 'review-fix',
    label: 'Review fix',
    status: 'working',
    runId: run.id,
    slotId: 'durable-fixture',
    runner: 'claude',
    model: 'sonnet',
    taskFile: 'tasks/case/REVIEW-FIX.md',
    signalFile: 'tasks/case/REVIEW-FIX-SIGNAL.json',
    attemptStartedAt: '2026-10-29T19:01:00Z',
  };
  store.updateRun(run.id, {
    status: 'reviewing',
    engineState: { generation: 1 },
    agentContexts: [context],
  });
  await rewriteStatusFile((state) => ({
    ...state,
    slots: [
      ...(state?.slots ?? []).filter((slot) => slot.slot !== context.slotId),
      { slot: context.slotId, current_run_id: run.id },
    ],
  }));
  await store.persistRunNow(store.getRun(run.id)!, 'initial fixture');
  t.after(async () => {
    persistFailure = undefined;
    persistGate = undefined;
    enteredPersist = () => {};
    await rewriteStatusFile((state) => ({
      ...state,
      slots: (state?.slots ?? []).filter((slot) => slot.slot !== context.slotId),
    }));
    await deleteTestRunIfPresent(run.id);
  });
  return { run, context };
}

function deferredPersistence() {
  let entered!: () => void;
  let release!: () => void;
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  persistGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  enteredPersist = entered;
  return { observed, release };
}

test('the production review boundary waits for a disk flush and durably clears untouched input', async (t) => {
  const f = await fixture(t);
  const gate = deferredPersistence();
  const pending = recordReviewFixDeliveryBoundary(f.run.id, f.context, '2026-10-29T19:01:01Z', 1);
  try {
    assert.equal(
      await Promise.race([gate.observed.then(() => 'flushing'), pending.then(() => 'returned')]),
      'flushing',
      'memory and slot mirroring cannot acknowledge durability',
    );
  } finally {
    gate.release();
    await pending;
  }
  const file = path.join(store.runsDirectory(), `${f.run.id}.json`);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(
    saved.agentContexts.find((context: AgentContext) => context.id === 'review-fix')
      .promptDeliveryStartedAt,
    '2026-10-29T19:01:01Z',
  );
  persistGate = undefined;
  await recordReviewFixDeliveryBoundary(f.run.id, f.context, undefined, 1);
  const cleared = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(
    cleared.agentContexts.find((context: AgentContext) => context.id === 'review-fix')
      .promptDeliveryStartedAt,
    undefined,
  );
});

test('a review boundary persistence failure rejects before input is permitted', async (t) => {
  const f = await fixture(t);
  persistFailure = new Error('owned disk failure');
  await assert.rejects(
    recordReviewFixDeliveryBoundary(f.run.id, f.context, '2026-10-29T19:01:01Z', 1),
    /owned disk failure/,
  );
});

test('a review generation replaced during persistence cannot authorize old input', async (t) => {
  const f = await fixture(t);
  const gate = deferredPersistence();
  const pending = recordReviewFixDeliveryBoundary(f.run.id, f.context, '2026-10-29T19:01:01Z', 1);
  const rejected = assert.rejects(pending, /changed before delivery/);
  try {
    assert.equal(
      await Promise.race([gate.observed.then(() => 'flushing'), pending.then(() => 'returned')]),
      'flushing',
    );
    store.updateRun(f.run.id, { engineState: { generation: 2 } });
  } finally {
    gate.release();
    await rejected;
  }
});
