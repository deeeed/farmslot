// budget-delivery-state.ts — The soft-budget guard's delivery state machine.
//
// The guard used to carry its delivery decision across a warn-once latch, an attempt
// counter, a deferral clock, an unsupported-runner latch, an integrity flag, and a
// reassignable message variable. Every defect found in review of that arrangement had
// one shape: a state was established, then another silently replaced it — a measured
// breach overwritten by an accounting-status message, a clock started by only one of two
// busy detectors. Those interactions could no longer be checked by reading.
//
// So the states and the events between them are written down here, in one exhaustive
// transition, with no I/O. What a poll observes becomes an event; what to do next is a
// question asked of the state.

/** Unconfirmed deliveries stop after this many attempts that reached the composer. */
export const MAX_BUDGET_NUDGE_ATTEMPTS = 3;

/**
 * How long a warning may wait for a turn boundary before it is sent regardless.
 *
 * Holding is right — a runner mid-turn never submits what is typed at it — but a long
 * tool loop is exactly the runaway the guard exists to catch, so the wait is bounded.
 */
export const MAX_BUDGET_NUDGE_DEFERRAL_MS = 15 * 60_000;

export type BudgetDeliveryPhase =
  /** No ceiling crossed and accounting is healthy. */
  | 'ok'
  /** A ceiling was crossed. The worker has not been told yet. */
  | 'breach-pending'
  /** The worker has been told. */
  | 'delivered'
  /** Told as often as we are willing to try without confirmation. */
  | 'abandoned'
  /** Nothing can be measured, so nothing can be claimed. Operator-facing only. */
  | 'unenforceable';

export interface BudgetDeliveryState {
  phase: BudgetDeliveryPhase;
  /** The worker-facing text owed, if any. Only ever set for `breach-pending`. */
  pendingMessage: string | null;
  /** Operator-facing status, independent of anything owed to the worker. */
  operatorMessage: string | null;
  /** Deliveries that reached the composer without confirmation. */
  attempts: number;
  /** When the first hold happened, so waiting can be bounded. */
  firstHeldAt?: number;
}

export type BudgetDeliveryEvent =
  | { kind: 'usage-within-budget' }
  | { kind: 'usage-breached'; message: string }
  /** The runner cannot be measured at all, or accounting integrity was lost. */
  | { kind: 'accounting-unenforceable'; message: string }
  | { kind: 'delivery-confirmed' }
  /** Text reached the composer; submission unverified. */
  | { kind: 'delivery-typed' }
  /** The send never reached the composer — mid-turn, hook lapse, foreign draft, busy. */
  | { kind: 'delivery-held'; now: number };

export function initialBudgetDeliveryState(): BudgetDeliveryState {
  return { phase: 'ok', pendingMessage: null, operatorMessage: null, attempts: 0 };
}

/**
 * Advance the guard by one observation.
 *
 * The rule that the old arrangement could not express: losing the ability to measure
 * further does not unmeasure what was already measured. A breach that was established,
 * recorded, and broadcast stays owed to the worker even after the transcript moves out
 * from under us — `accounting-unenforceable` records itself for the operator and leaves
 * `breach-pending` intact.
 */
export function advanceBudgetDelivery(
  state: BudgetDeliveryState,
  event: BudgetDeliveryEvent,
): BudgetDeliveryState {
  switch (event.kind) {
    case 'usage-within-budget':
      return state;

    case 'usage-breached':
      // Warn-once: a breach already owed or already told is not re-raised.
      if (state.phase !== 'ok') return state;
      return { ...state, phase: 'breach-pending', pendingMessage: event.message };

    case 'accounting-unenforceable':
      // Never downgrades an owed breach — only records why nothing further can be said.
      if (state.phase === 'breach-pending') {
        return { ...state, operatorMessage: event.message };
      }
      if (state.phase !== 'ok') return { ...state, operatorMessage: event.message };
      return { ...state, phase: 'unenforceable', operatorMessage: event.message };

    case 'delivery-confirmed':
      return { ...state, phase: 'delivered', pendingMessage: null, firstHeldAt: undefined };

    case 'delivery-typed': {
      const attempts = state.attempts + 1;
      return {
        ...state,
        attempts,
        phase: attempts >= MAX_BUDGET_NUDGE_ATTEMPTS ? 'abandoned' : state.phase,
      };
    }

    case 'delivery-held':
      // Every hold starts the clock, whichever detector produced it. Two detectors used
      // to disagree about this, and a hold the other one raised waited forever.
      return { ...state, firstHeldAt: state.firstHeldAt ?? event.now };
  }
}

/** Whether the guard still owes the worker something and may act on it now. */
export function budgetDeliveryDecision(
  state: BudgetDeliveryState,
  opts: { runnerMidTurn: boolean; now: number },
): { deliver: false } | { deliver: true; message: string } {
  if (state.phase !== 'breach-pending' || state.pendingMessage === null) return { deliver: false };
  if (state.attempts >= MAX_BUDGET_NUDGE_ATTEMPTS) return { deliver: false };
  if (opts.runnerMidTurn) {
    const heldForMs = state.firstHeldAt ? opts.now - state.firstHeldAt : 0;
    if (heldForMs < MAX_BUDGET_NUDGE_DEFERRAL_MS) return { deliver: false };
  }
  return { deliver: true, message: state.pendingMessage };
}

/** Whether anything further can be learned by sampling this run's usage. */
export function budgetGuardSettled(state: BudgetDeliveryState): boolean {
  return (
    state.phase === 'delivered' || state.phase === 'abandoned' || state.phase === 'unenforceable'
  );
}
