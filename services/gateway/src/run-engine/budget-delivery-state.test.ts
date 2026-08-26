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
const LOST: BudgetDeliveryEvent = { kind: 'accounting-unenforceable', message: 'transcript moved' };

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
