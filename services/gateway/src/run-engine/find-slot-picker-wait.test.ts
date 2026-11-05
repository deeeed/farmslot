import assert from 'node:assert/strict';
import test from 'node:test';

import { runResolveDecision } from '../methods/run.js';
import { GatewayResourceRevisions } from '../resources/revisions.js';
import { createRun, deleteRun, getRun, updateRun, updateRunStep } from '../runs/store.js';

import {
  createEngineDecision,
  hasEngineDecisionWaiter,
  resolveEngineDecision,
  setEngineDecisionRuntime,
} from './engine-decisions.js';
import { waitForSlotPickerChange } from './find-slot-step.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Expected the owned decision continuation');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function fixture(t: test.TestContext) {
  const run = createRun({
    project: 'farmslot-farm',
    flowType: 'dev',
    mode: 'autonomous',
    ticketOrPr: `F317-${Date.now()}-${Math.random()}`,
  });
  updateRun(run.id, { status: 'slot-finding' });
  updateRunStep(run.id, 'find-slot', { status: 'running', startedAt: new Date().toISOString() });
  setEngineDecisionRuntime({ broadcast: () => {}, stepToStatus: { 'find-slot': 'slot-finding' } });
  const revisions = new GatewayResourceRevisions();
  let availability = 'held';
  let reads = 0;
  const pending = () =>
    getRun(run.id)?.decisions.find((d) => d.type === 'engine_no_suitable_slot' && !d.resolvedAt);
  const decide = (onWaiting?: (decisionId: string) => void) =>
    createEngineDecision(
      run.id,
      'no_suitable_slot',
      'Owned picker',
      [
        { id: 'pick', label: 'Use Selected Slot', style: 'primary' },
        { id: 'retry', label: 'Retry Selection', style: 'secondary' },
        { id: 'abort', label: 'Abort Run', style: 'danger' },
      ],
      { kind: 'slot_picker', project: run.project, candidates: [], reason: 'no_free_slots' },
      { onWaiting },
    );
  t.after(async () => {
    const decision = pending();
    if (decision) resolveEngineDecision(decision.id, 'abort');
    revisions.dispose();
    updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  return {
    run,
    revisions,
    pending,
    decide,
    ready: () => {
      availability = 'ready';
    },
    reads: () => reads,
    read: async () => {
      reads++;
      return availability;
    },
    waiting: () => until(() => !!pending() && hasEngineDecisionWaiter(pending()!.id)),
  };
}

test('a held slot becoming ready wakes the same decision for normal reselection', async (t) => {
  const h = fixture(t);
  const result = waitForSlotPickerChange(
    h.run.id,
    0,
    new Set(['owned-slot']),
    'held',
    h.read,
    h.decide,
    h.revisions,
  );
  await h.waiting();
  const id = h.pending()!.id;
  h.ready();
  h.revisions.advance({ family: 'slot', slotId: 'owned-slot' });
  assert.equal(await result, 'retry');
  assert.equal(getRun(h.run.id)?.decisions.find((d) => d.id === id)?.resolvedAction, 'retry');
  assert.equal(getRun(h.run.id)?.requestedSlotId, null);
  assert.equal(hasEngineDecisionWaiter(id), false);
});

test('unrelated slots and unchanged observations do not retry selection', async (t) => {
  const h = fixture(t);
  const result = waitForSlotPickerChange(
    h.run.id,
    0,
    new Set(['owned-slot']),
    'held',
    h.read,
    h.decide,
    h.revisions,
  );
  await h.waiting();
  const before = h.reads();
  h.revisions.advance({ family: 'slot', slotId: 'someone-elses-slot' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.reads(), before);
  h.revisions.advance({ family: 'slot', slotId: 'owned-slot' });
  await until(() => h.reads() > before);
  assert.ok(h.pending());
  resolveEngineDecision(h.pending()!.id, 'abort');
  assert.equal(await result, 'abort');
  const after = h.reads();
  h.revisions.advance({ family: 'slot', slotId: 'owned-slot' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.reads(), after);
});

test('a release during decision creation is observed after its waiter is registered', async (t) => {
  const h = fixture(t);
  const result = waitForSlotPickerChange(
    h.run.id,
    0,
    new Set(['owned-slot']),
    'held',
    h.read,
    async (onWaiting) => {
      h.ready();
      await Promise.resolve();
      return h.decide(onWaiting);
    },
    h.revisions,
  );
  assert.equal(await result, 'retry');
});

test('a cancelled generation cannot resume after an in-flight availability read', async (t) => {
  const h = fixture(t);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const result = waitForSlotPickerChange(
    h.run.id,
    0,
    new Set(['owned-slot']),
    'held',
    async () => {
      started = true;
      await barrier;
      return 'ready';
    },
    h.decide,
    h.revisions,
  );
  await h.waiting();
  const id = h.pending()!.id;
  h.revisions.advance({ family: 'slot', slotId: 'owned-slot' });
  await until(() => started);
  updateRun(h.run.id, { status: 'cancelled' });
  resolveEngineDecision(id, 'abort');
  release();
  assert.equal(await result, 'abort');
  assert.equal(getRun(h.run.id)?.status, 'cancelled');
});

test('an empty operator pick is refused without consuming its live card', async (t) => {
  const h = fixture(t);
  const result = waitForSlotPickerChange(
    h.run.id,
    0,
    new Set(['owned-slot']),
    'held',
    h.read,
    h.decide,
    h.revisions,
  );
  await h.waiting();
  const id = h.pending()!.id;
  await assert.rejects(
    runResolveDecision({ runId: h.run.id, decisionId: id, actionId: 'pick' }, () => {}),
    /Select an eligible slot/,
  );
  assert.equal(h.pending()!.id, id);
  assert.ok(hasEngineDecisionWaiter(id));
  resolveEngineDecision(id, 'abort');
  assert.equal(await result, 'abort');
});

test('failed refresh removes its own observer and decision waiter', async (t) => {
  const h = fixture(t);
  let reads = 0;
  const result = waitForSlotPickerChange(
    h.run.id,
    0,
    new Set(['owned-slot']),
    'held',
    async () => {
      if (reads++ === 0) return 'held';
      throw new Error('Fleet read failed');
    },
    h.decide,
    h.revisions,
  );
  await h.waiting();
  const id = h.pending()!.id;
  const rejected = assert.rejects(result, /Fleet read failed/);
  h.revisions.advance({ family: 'slot', slotId: 'owned-slot' });
  await rejected;
  assert.equal(hasEngineDecisionWaiter(id), false);
});

test('an old refresh cannot abort a successor generations picker', async (t) => {
  const h = fixture(t);
  let release!: () => void;
  let reading = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = waitForSlotPickerChange(
    h.run.id,
    0,
    new Set(['owned-slot']),
    'held',
    async () => {
      reading = true;
      await barrier;
      return 'ready';
    },
    h.decide,
    h.revisions,
  );
  await h.waiting();
  const oldId = h.pending()!.id;
  h.revisions.advance({ family: 'slot', slotId: 'owned-slot' });
  await until(() => reading);
  updateRun(h.run.id, {
    engineState: { generation: 1 },
    decisions: getRun(h.run.id)!.decisions.map((d) =>
      d.id === oldId
        ? { ...d, resolvedAt: new Date().toISOString(), resolvedAction: 'superseded' }
        : d,
    ),
  });
  resolveEngineDecision(oldId, 'superseded');
  const next = createEngineDecision(
    h.run.id,
    'no_suitable_slot',
    'Successor picker',
    [{ id: 'abort', label: 'Abort', style: 'danger' }],
    { kind: 'slot_picker', project: h.run.project, candidates: [], reason: 'no_free_slots' },
    { canReplay: () => false, generation: 1 },
  );
  await h.waiting();
  const nextId = h.pending()!.id;
  assert.notEqual(nextId, oldId);
  release();
  assert.equal(await old, 'abort');
  assert.ok(hasEngineDecisionWaiter(nextId));
  resolveEngineDecision(nextId, 'abort');
  assert.equal(await next, 'abort');
});

test('cancellation notifications settle the waiter without an operator action', async (t) => {
  const h = fixture(t);
  const result = waitForSlotPickerChange(
    h.run.id,
    0,
    new Set(['owned-slot']),
    'held',
    h.read,
    h.decide,
    h.revisions,
  );
  await h.waiting();
  const id = h.pending()!.id;
  updateRun(h.run.id, { status: 'cancelled' });
  h.revisions.advance({ family: 'run', runId: h.run.id });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    hasEngineDecisionWaiter(id),
    false,
    'Cancellation must release the waiting continuation',
  );
  assert.equal(await result, 'abort');
});

test('unrelated configuration and unchanged project facts keep the same picker asleep', async (t) => {
  const h = fixture(t);
  const result = waitForSlotPickerChange(
    h.run.id,
    0,
    new Set(['owned-slot']),
    'held',
    h.read,
    h.decide,
    h.revisions,
  );
  await h.waiting();
  const id = h.pending()!.id;
  h.revisions.advance({ family: 'configuration', scope: 'farm', project: 'some-other-project' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.pending()?.id, id);
  h.revisions.advance({ family: 'configuration', scope: 'farm' });
  h.revisions.advance({ family: 'configuration', scope: 'farm', project: h.run.project });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.pending()?.id, id);
  resolveEngineDecision(id, 'abort');
  assert.equal(await result, 'abort');
});
