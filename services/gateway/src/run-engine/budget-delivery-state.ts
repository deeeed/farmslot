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
// question asked of the state. Events that cannot legitimately occur in the current
// phase are refused rather than applied: a switch that accepts them is not exhaustive,
// it only looks exhaustive, and that is how the previous arrangement passed review.

/** Unconfirmed deliveries stop after this many attempts that reached the composer. */
export const MAX_BUDGET_NUDGE_ATTEMPTS = 3;

/**
 * How long a warning may go undelivered before the guard gives up on the pane.
 *
 * Holding is right — a runner mid-turn never submits what is typed at it — but a long
 * tool loop is exactly the runaway the guard exists to catch. The bound applies to every
 * hold, not only a mid-turn one: a hook lapse or a busy sender means the worker is not
 * receiving anything either, and bounding only one of them left the guard polling for
 * the life of the run with nothing ever delivered.
 */
export const MAX_BUDGET_NUDGE_DEFERRAL_MS = 15 * 60_000;

export type BudgetDeliveryPhase =
  /** No ceiling crossed and accounting is healthy. */
  | 'ok'
  /** A ceiling was crossed. The worker has not been told yet. */
  | 'breach-pending'
  /** The worker has been told. */
  | 'delivered'
  /** Tried as hard as we are willing to without confirmation. */
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
  /**
   * Nothing can be measured right now. `permanent` says whether that can change: a
   * runner with no session-usage provider cannot, a transcript that failed to stat once
   * can. Only a permanent condition retires the run — leaving that judgement to the call
   * site would put it back in the unwritten convention that rotted the last arrangement.
   */
  | { kind: 'accounting-unenforceable'; message: string; permanent: boolean }
  /** Dispatch rewrote the run's runner, so an earlier verdict about it no longer binds. */
  | { kind: 'runner-changed' }
  | { kind: 'delivery-confirmed' }
  /** Text reached the composer; submission unverified. */
  | { kind: 'delivery-typed' }
  /** The send never reached the composer — mid-turn, hook lapse, foreign draft, busy. */
  | { kind: 'delivery-held'; now: number }
  /** This runner can never take a pane instruction, so waiting cannot help. */
  | { kind: 'delivery-impossible'; message: string };

export function initialBudgetDeliveryState(): BudgetDeliveryState {
  return { phase: 'ok', pendingMessage: null, operatorMessage: null, attempts: 0 };
}

/** Delivery events mean nothing unless something is owed. */
function awaitingDelivery(state: BudgetDeliveryState): boolean {
  return state.phase === 'breach-pending';
}

/**
 * Advance the guard by one observation.
 *
 * The rule the old arrangement could not express: losing the ability to measure further
 * does not unmeasure what was already measured. A breach that was established, recorded,
 * and broadcast stays owed to the worker even after the transcript moves out from under
 * us — `accounting-unenforceable` records itself for the operator and leaves
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
      // Warn-once. `unenforceable` is only reachable from a permanent condition, so a
      // measurable breach cannot follow one.
      if (state.phase !== 'ok') return state;
      return { ...state, phase: 'breach-pending', pendingMessage: event.message };

    case 'accounting-unenforceable': {
      const next = { ...state, operatorMessage: event.message };
      // Never downgrades an owed breach, and a condition that can clear does not retire
      // the run — one failed stat would otherwise disable the ceiling for good.
      if (!event.permanent || state.phase !== 'ok') return next;
      return { ...next, phase: 'unenforceable' };
    }

    case 'runner-changed':
      // A verdict reached about the previous runner says nothing about this one. Only
      // that verdict is cleared; anything owed to the worker survives.
      if (state.phase !== 'unenforceable') return state;
      return { ...state, phase: 'ok', operatorMessage: null };

    case 'delivery-confirmed':
      if (!awaitingDelivery(state)) return state;
      return { ...state, phase: 'delivered', pendingMessage: null, firstHeldAt: undefined };

    case 'delivery-typed': {
      if (!awaitingDelivery(state)) return state;
      const attempts = state.attempts + 1;
      return {
        ...state,
        attempts,
        phase: attempts >= MAX_BUDGET_NUDGE_ATTEMPTS ? 'abandoned' : state.phase,
      };
    }

    case 'delivery-held': {
      if (!awaitingDelivery(state)) return state;
      // Every hold starts the same clock, whichever detector produced it, and exceeding
      // it retires the run. A hold never types, so without this edge the phase that
      // exists to stop the guard spinning was unreachable from the case that spins.
      const firstHeldAt = state.firstHeldAt ?? event.now;
      const heldForMs = event.now - firstHeldAt;
      return {
        ...state,
        firstHeldAt,
        phase: heldForMs >= MAX_BUDGET_NUDGE_DEFERRAL_MS ? 'abandoned' : state.phase,
      };
    }

    case 'delivery-impossible':
      if (!awaitingDelivery(state)) return state;
      // Unlike a hold this will never clear, so there is nothing to wait for.
      return { ...state, phase: 'abandoned', operatorMessage: event.message };
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
