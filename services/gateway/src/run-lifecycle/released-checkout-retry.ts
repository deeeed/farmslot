import {
  isCompletionPrerequisiteFailure,
  isHeldForResultDecision,
  isTerminalRunStatus,
  type Run,
  type SlotStatus,
} from '@farmslot/protocol';

import type { BundleCheck } from '../methods/slot/temp-scrub.js';

import type { SafeIdleSlotResult } from './safe-idle-slot.js';
import { parksBranchCommits } from './validation-run-commits.js';

/**
 * Release returns a finished artifact-only run's checkout to idle once (lifecycle-control). When
 * that attempt is refused (a stale working row, an unconfirmed node closeout), the slot stays
 * released but on the run branch, and the next run's preflight refuses it. This pass retries the
 * same fenced idle return later, for that case only.
 *
 * It acts only on a slot that is ready, unowned and on the branch its newest run released, with
 * no unfinished run naming it, no teardown or prepare in flight, and its node present on two
 * passes in a row. The run must be `done`, its bundle must hold its task, and the checkout must
 * still be exactly the released head with a clean tree (`exactHead`). The idle return parks the
 * run's commits before any reset. A refusal after recovery has marked the slot is left to the
 * existing recovery hold; this pass covers refusals before that mark.
 */
export interface ReleasedCheckoutRetryDeps {
  now: () => number;
  fleetSlots: () => Promise<SlotStatus[]>;
  readSlotRow: (slotId: string) => Promise<Readonly<Record<string, unknown>> | null>;
  allRuns: () => Promise<Run[]>;
  freshRun: (runId: string) => Promise<Run | undefined>;
  bundleCheck: (run: Run) => Promise<BundleCheck>;
  /** A terminal teardown or a prepare is running on the slot. */
  slotBusy: (slotId: string) => boolean;
  /** The slot's execution node when it is remote and not connected. */
  absentNode: (slotId: string) => Promise<string | null>;
  returnToIdle: (run: Run) => Promise<SafeIdleSlotResult | null>;
  /** Clear the run's "Checkout retained" note after the slot returned to idle. */
  clearRetainedNote: (run: Run) => Promise<void>;
  log: (message: string) => void;
}

export const RELEASED_CHECKOUT_RETRY_MIN_MS = 5 * 60 * 1000;
export const RELEASED_CHECKOUT_RETRY_MAX_MS = 60 * 60 * 1000;
/** Passes in a row a slot must look eligible, with its node present, before an attempt. */
export const RELEASED_CHECKOUT_STABLE_PASSES = 2;

interface SlotRetryState {
  streak: number;
  nextAttemptAt: number;
  backoffMs: number;
  lastReason?: string;
}

const states = new Map<string, SlotRetryState>();
let passInFlight = false;

/** For tests: forget per-slot retry state. */
export function resetReleasedCheckoutRetryState(): void {
  states.clear();
  passInFlight = false;
}

function unownedReady(slot: SlotStatus): boolean {
  return (
    slot.enabled &&
    !slot.missingFromPool &&
    slot.lifecycle === 'ready' &&
    !slot.currentRunId &&
    !slot.cleanupRunId &&
    !slot.handoffRunId &&
    slot.health.ssh !== 'FAIL' &&
    typeof slot.branch === 'string' &&
    slot.branch !== '' &&
    slot.branch !== '-'
  );
}

function createdAt(run: Run): number {
  return Date.parse(run.createdAt ?? '') || 0;
}

/** The run whose released checkout this slot holds, or why there is none. */
export function releasedCheckoutOwner(slot: SlotStatus, runs: readonly Run[]): Run | null {
  const onSlot = runs.filter(
    (run) => run.slotId === slot.slot || run.releasedCheckout?.slotId === slot.slot,
  );
  // Any unfinished run naming the slot (a pin included) owns its next use.
  if (onSlot.some((run) => !isTerminalRunStatus(run.status))) return null;
  const newest = onSlot.reduce<Run | null>(
    (best, run) => (!best || createdAt(run) > createdAt(best) ? run : best),
    null,
  );
  if (!newest) return null;
  if (
    newest.status !== 'done' ||
    newest.completionPolicy !== 'artifact-only' ||
    !parksBranchCommits(newest) ||
    newest.project !== slot.project ||
    newest.releasedCheckout?.slotId !== slot.slot ||
    newest.releasedCheckout.branch !== slot.branch ||
    isCompletionPrerequisiteFailure(newest) ||
    isHeldForResultDecision(newest)
  )
    return null;
  // A held result on the same branch still needs this checkout.
  if (
    onSlot.some(
      (run) =>
        run.id !== newest.id &&
        run.branch === slot.branch &&
        (isCompletionPrerequisiteFailure(run) || isHeldForResultDecision(run)),
    )
  )
    return null;
  return newest;
}

function backOff(state: SlotRetryState, now: number): void {
  state.backoffMs = Math.min(
    RELEASED_CHECKOUT_RETRY_MAX_MS,
    Math.max(RELEASED_CHECKOUT_RETRY_MIN_MS, state.backoffMs * 2),
  );
  state.nextAttemptAt = now + state.backoffMs;
}

function noteOnce(
  deps: ReleasedCheckoutRetryDeps,
  slotId: string,
  state: SlotRetryState,
  reason: string,
): void {
  if (state.lastReason === reason) return;
  state.lastReason = reason;
  deps.log(`[slot.release] ${slotId}: released checkout not returned to idle yet: ${reason}`);
}

/** One pass. Overlapping calls are dropped; each slot's failure stays its own. */
export async function retryReleasedCheckoutIdleReturns(
  deps: ReleasedCheckoutRetryDeps,
): Promise<void> {
  if (passInFlight) return;
  passInFlight = true;
  try {
    const now = deps.now();
    const candidates = (await deps.fleetSlots()).filter(unownedReady);
    const candidateIds = new Set(candidates.map((slot) => slot.slot));
    for (const slotId of [...states.keys()]) if (!candidateIds.has(slotId)) states.delete(slotId);
    if (candidates.length === 0) return;
    // One run scan per pass, and only when a slot could qualify.
    const runs = await deps.allRuns();
    for (const slot of candidates) {
      try {
        await retrySlot(deps, slot, runs, now);
      } catch (error) {
        const state = states.get(slot.slot);
        if (state) {
          backOff(state, now);
          noteOnce(deps, slot.slot, state, error instanceof Error ? error.message : String(error));
        }
      }
    }
  } finally {
    passInFlight = false;
  }
}

async function retrySlot(
  deps: ReleasedCheckoutRetryDeps,
  slot: SlotStatus,
  runs: readonly Run[],
  now: number,
): Promise<void> {
  const owner = releasedCheckoutOwner(slot, runs);
  if (!owner || deps.slotBusy(slot.slot) || (await deps.absentNode(slot.slot))) {
    states.delete(slot.slot);
    return;
  }
  const state = states.get(slot.slot) ?? { streak: 0, nextAttemptAt: 0, backoffMs: 0 };
  states.set(slot.slot, state);
  state.streak += 1;
  if (state.streak < RELEASED_CHECKOUT_STABLE_PASSES || now < state.nextAttemptAt) return;
  // Throttle before any bundle or network work.
  backOff(state, now);
  const bundle = await deps.bundleCheck(owner);
  if (!bundle.confirmed) {
    noteOnce(
      deps,
      slot.slot,
      state,
      `run ${owner.id.slice(0, 8)}'s bundle is not confirmed (${bundle.reason})`,
    );
    return;
  }
  // Re-read both sides just before acting.
  const row = await deps.readSlotRow(slot.slot);
  const fresh = await deps.freshRun(owner.id);
  if (
    !row ||
    row.current_run_id ||
    row.cleanup_run_id ||
    row.handoff_run_id ||
    row.workspace_recovery ||
    row.lifecycle !== 'ready' ||
    row.phase === 'releasing' ||
    !fresh ||
    !releasedCheckoutOwner(
      slot,
      runs.map((run) => (run.id === fresh.id ? fresh : run)),
    ) ||
    deps.slotBusy(slot.slot)
  )
    return;
  const result = await deps.returnToIdle(fresh);
  if (result?.kind === 'ready') {
    states.delete(slot.slot);
    await deps.clearRetainedNote(fresh);
    deps.log(
      `[slot.release] ${slot.slot}: returned run ${fresh.id.slice(0, 8)}'s released checkout to idle`,
    );
    return;
  }
  noteOnce(deps, slot.slot, state, result?.reason ?? 'the run no longer qualifies');
}

/** Production wiring: the same fenced idle return release uses, strict about the recorded head. */
export async function defaultReleasedCheckoutRetryDeps(
  absentNode: ReleasedCheckoutRetryDeps['absentNode'],
): Promise<ReleasedCheckoutRetryDeps> {
  const [{ loadFleetStatus }, core, store, scrub, teardown, prepareGuards, safeIdle, slotTeardown] =
    await Promise.all([
      import('../fleet/state.js'),
      import('../core/state.js'),
      import('../runs/store.js'),
      import('../methods/slot/temp-scrub.js'),
      import('../run-engine/terminal-teardown-registry.js'),
      import('../core/native-worker-exclusion.js'),
      import('./safe-idle-slot.js'),
      import('./slot-teardown.js'),
    ]);
  return {
    now: () => Date.now(),
    fleetSlots: async () => (await loadFleetStatus()).slots,
    readSlotRow: (slotId) => core.readSlotRow(slotId),
    allRuns: () => store.getAllRunsWithArchived(),
    freshRun: (runId) => store.getRunWithArchived(runId),
    bundleCheck: (run) => scrub.taskBundleCheck(run),
    slotBusy: (slotId) =>
      teardown.isTerminalTeardownInFlight(slotId) || prepareGuards.activePrepareSlots.has(slotId),
    absentNode,
    returnToIdle: async (run) => {
      const { broadcastEvent } = await import('../server.js');
      return safeIdle.returnReleasedCheckoutToIdle(run, broadcastEvent, { exactHead: true });
    },
    clearRetainedNote: async (run) => {
      // Live runs only: an archived run's note stays as history.
      if (store.getRun(run.id)) await slotTeardown.recordSlotTeardownSkipped(run, null);
    },
    log: (message) => console.log(message),
  };
}
