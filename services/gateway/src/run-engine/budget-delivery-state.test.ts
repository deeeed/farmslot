import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceBudgetDelivery,
  budgetDeliveryDecision,
  type BudgetDeliveryEvent,
  type BudgetDeliveryState,
  budgetGuardSettled,
  initialBudgetDeliveryState,
  MAX_BUDGET_NUDGE_ATTEMPTS,
  MAX_BUDGET_NUDGE_DEFERRAL_MS,
} from './budget-delivery-state.js';

function run(events: BudgetDeliveryEvent[]): BudgetDeliveryState {
  return events.reduce(advanceBudgetDelivery, initialBudgetDeliveryState());
}

const BREACH: BudgetDeliveryEvent = { kind: 'usage-breached', message: 'over 8M' };
const LOST: BudgetDeliveryEvent = {
  kind: 'accounting-unenforceable',
  message: 'transcript moved',
  permanent: true,
};
const BLIP: BudgetDeliveryEvent = {
  kind: 'accounting-unenforceable',
  message: 'stat failed once',
  permanent: false,
};

test('losing the ability to measure does not unmeasure an established breach', () => {
  // The defect this machine exists to prevent: a measured, broadcast breach had its
  // message overwritten by the accounting-status text and was never delivered.
  const state = run([BREACH, LOST, LOST, LOST]);
  assert.equal(state.phase, 'breach-pending');
  assert.equal(state.pendingMessage, 'over 8M');
  assert.equal(state.operatorMessage, 'transcript moved');
  const decision = budgetDeliveryDecision(state, { runnerMidTurn: false, now: 0 });
  assert.deepEqual(decision, { deliver: true, message: 'over 8M' });
});

test('an unmeasurable run owes the worker nothing', () => {
  const state = run([LOST]);
  assert.equal(state.phase, 'unenforceable');
  assert.equal(state.pendingMessage, null);
  assert.equal(budgetDeliveryDecision(state, { runnerMidTurn: false, now: 0 }).deliver, false);
  assert.equal(budgetGuardSettled(state), true);
});

test('a breach is raised once, however many polls observe it', () => {
  const state = run([BREACH, { kind: 'usage-breached', message: 'over 8M again' }]);
  assert.equal(state.pendingMessage, 'over 8M', 'the first message stands');
});

test('delivery ends the obligation and stops the guard', () => {
  const state = run([BREACH, { kind: 'delivery-held', now: 1000 }, { kind: 'delivery-confirmed' }]);
  assert.equal(state.phase, 'delivered');
  assert.equal(state.pendingMessage, null);
  assert.equal(state.firstHeldAt, undefined, 'a later warning must not inherit this clock');
  assert.equal(budgetGuardSettled(state), true);
});

test('unconfirmed deliveries are bounded', () => {
  let state = run([BREACH]);
  for (let i = 0; i < MAX_BUDGET_NUDGE_ATTEMPTS; i++) {
    assert.equal(
      budgetDeliveryDecision(state, { runnerMidTurn: false, now: 0 }).deliver,
      true,
      `attempt ${i + 1} should still be allowed`,
    );
    state = advanceBudgetDelivery(state, { kind: 'delivery-typed' });
  }
  assert.equal(state.phase, 'abandoned');
  assert.equal(budgetDeliveryDecision(state, { runnerMidTurn: false, now: 0 }).deliver, false);
  assert.equal(budgetGuardSettled(state), true, 'the guard stops rather than polling forever');
});

test('a hold from any detector starts the same clock, and the wait is bounded', () => {
  // Two busy detectors used to disagree about which holds counted, so a hold raised by
  // the other one waited forever.
  const state = run([BREACH, { kind: 'delivery-held', now: 1_000 }]);
  assert.equal(state.firstHeldAt, 1_000);
  assert.equal(
    budgetDeliveryDecision(state, {
      runnerMidTurn: true,
      now: 1_000 + MAX_BUDGET_NUDGE_DEFERRAL_MS - 1,
    }).deliver,
    false,
  );
  assert.equal(
    budgetDeliveryDecision(state, {
      runnerMidTurn: true,
      now: 1_000 + MAX_BUDGET_NUDGE_DEFERRAL_MS,
    }).deliver,
    true,
    'a runaway that never yields a turn boundary must still be told',
  );
});

test('a hold does not restart the clock, so attempts cannot extend the bound', () => {
  const state = run([
    BREACH,
    { kind: 'delivery-held', now: 1_000 },
    { kind: 'delivery-typed' },
    { kind: 'delivery-held', now: 9_000 },
  ]);
  assert.equal(state.firstHeldAt, 1_000);
  assert.equal(state.attempts, 1);
});

test('an idle runner is never made to wait', () => {
  const state = run([BREACH, { kind: 'delivery-held', now: 1_000 }]);
  assert.equal(budgetDeliveryDecision(state, { runnerMidTurn: false, now: 1_100 }).deliver, true);
});

test('usage within budget leaves every phase untouched', () => {
  for (const events of [[], [BREACH], [LOST], [BREACH, { kind: 'delivery-confirmed' as const }]]) {
    const before = run(events);
    assert.deepEqual(advanceBudgetDelivery(before, { kind: 'usage-within-budget' }), before);
  }
});

test('a condition that can clear does not retire the run', () => {
  // One failed stat used to latch `unenforceable` for the life of the run, so a genuine
  // breach afterwards was never even sampled — the round-7 defect in mirror image.
  const state = run([BLIP]);
  assert.equal(state.phase, 'ok');
  assert.equal(state.operatorMessage, 'stat failed once');
  assert.equal(budgetGuardSettled(state), false);

  const breached = advanceBudgetDelivery(state, BREACH);
  assert.equal(breached.phase, 'breach-pending');
  assert.equal(budgetDeliveryDecision(breached, { runnerMidTurn: false, now: 0 }).deliver, true);
});

test('a runner change clears a verdict reached about the previous runner', () => {
  // Dispatch rewrites metrics.runner mid-run, so a verdict from a stale id must not
  // disable the ceiling for the rest of the run.
  const state = run([LOST, { kind: 'runner-changed' }]);
  assert.equal(state.phase, 'ok');
  assert.equal(budgetGuardSettled(state), false);
});

test('a runner change never discards something owed to the worker', () => {
  const state = run([BREACH, { kind: 'runner-changed' }]);
  assert.equal(state.phase, 'breach-pending');
  assert.equal(state.pendingMessage, 'over 8M');
});

test('a hold that outlasts the bound retires the run', () => {
  // A hold never types, so `abandoned` was unreachable from the very case it exists to
  // stop: the guard polled forever and the worker was never told.
  const state = run([
    BREACH,
    { kind: 'delivery-held', now: 1_000 },
    { kind: 'delivery-held', now: 1_000 + MAX_BUDGET_NUDGE_DEFERRAL_MS },
  ]);
  assert.equal(state.phase, 'abandoned');
  assert.equal(budgetGuardSettled(state), true);
});

test('a runner that can never take a pane instruction is retired, not waited on', () => {
  const state = run([BREACH, { kind: 'delivery-impossible', message: 'no tmux nudges' }]);
  assert.equal(state.phase, 'abandoned');
  assert.equal(state.operatorMessage, 'no tmux nudges');
  assert.equal(budgetGuardSettled(state), true);
});

test('delivery events are refused in phases where nothing is owed', () => {
  for (const base of [run([]), run([LOST]), run([BREACH, { kind: 'delivery-confirmed' }])]) {
    for (const event of [
      { kind: 'delivery-confirmed' as const },
      { kind: 'delivery-typed' as const },
      { kind: 'delivery-held' as const, now: 5_000 },
      { kind: 'delivery-impossible' as const, message: 'x' },
    ]) {
      assert.deepEqual(
        advanceBudgetDelivery(base, event),
        base,
        `${event.kind} must not apply in phase ${base.phase}`,
      );
    }
  }
});
