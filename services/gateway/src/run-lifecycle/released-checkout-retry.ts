import {
  DEFAULT_BRANCH,
  isCompletionPrerequisiteFailure,
  isSlotIdleBranch,
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
 * no unfinished run naming it, no teardown or prepare in flight, and its node present, with no
 * node reconnect, on two passes in a row. The run must be `done`, its bundle must hold its task,
 * and the checkout must still be exactly the released head with a clean tree (`exactHead`), also
 * when recovery inspects it again. The idle return parks the run's commits before any reset. A
 * refusal after recovery has marked the slot is left to the existing recovery hold; this pass
 * covers refusals before that mark.
 *
 * Cost: a pass reads the fleet rows; it scans runs only when a ready unowned slot is off its
 * project's default branch, and runs Git or node commands only for a slot that qualifies (one
 * bundle read and the fenced return release itself would run).
 */
export interface ReleasedCheckoutRetryDeps {
  now: () => number;
  fleetSlots: () => Promise<SlotStatus[]>;
  /** The branches the slot idles on: its project's default branch and, for a linked worktree,
   * its tracking branch. */
  idleBranches: (slot: SlotStatus) => Promise<{ defaultBranch: string; tracking: string }>;
  readSlotRow: (slotId: string) => Promise<Readonly<Record<string, unknown>> | null>;
  /** Live and archived runs, read once per pass. */
  allRuns: () => Promise<Run[]>;
  /** Live runs, current at the moment of the call. */
  liveRuns: () => Run[];
  freshRun: (runId: string) => Promise<Run | undefined>;
  bundleCheck: (run: Run) => Promise<BundleCheck>;
  /** A terminal teardown or a prepare is running on the slot. */
  slotBusy: (slotId: string) => boolean;
  /** The slot's execution node when it is remote and not connected. */
  absentNode: (slotId: string) => Promise<string | null>;
  /** The slot's node connection (its machine and connect time; one value for a local slot), so a
   * drop and reconnect between passes is seen. */
  nodeSession: (slotId: string) => Promise<string>;
  /** The fenced return; it also clears the run's "Checkout retained" note when it succeeds. */
  returnToIdle: (run: Run) => Promise<SafeIdleSlotResult | null>;
  log: (message: string) => void;
}

export const RELEASED_CHECKOUT_RETRY_MIN_MS = 5 * 60 * 1000;
export const RELEASED_CHECKOUT_RETRY_MAX_MS = 60 * 60 * 1000;
/** Passes in a row a slot must look eligible, with its node present, before an attempt. */
export const RELEASED_CHECKOUT_STABLE_PASSES = 2;

interface SlotRetryState {
  /** The run whose checkout this state counts for; another run starts afresh. */
  runId?: string;
  streak: number;
  /** The node connection the streak was counted on. */
  session?: string;
  nextAttemptAt: number;
  backoffMs: number;
  lastReason?: string;
}

const states = new Map<string, SlotRetryState>();
/** A slot whose project config could not be read, and why, while it keeps failing. */
const configErrors = new Map<string, string>();
let passInFlight = false;

/** For tests: forget per-slot retry state. */
export function resetReleasedCheckoutRetryState(): void {
  states.clear();
  configErrors.clear();
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

/** A pinned run that ended before it claimed the slot never held its checkout. */
function neverClaimed(run: Run): boolean {
  const findSlot = run.steps.find((step) => step.name === 'find-slot');
  return !!findSlot && findSlot.status !== 'done' && !run.releasedCheckout;
}

/** The finished run whose released checkout this slot holds, or null when there is none. */
export function releasedCheckoutOwner(slot: SlotStatus, runs: readonly Run[]): Run | null {
  const onSlot = runs.filter(
    (run) => run.slotId === slot.slot || run.releasedCheckout?.slotId === slot.slot,
  );
  // Any unfinished run naming the slot (a pin included) owns its next use.
  if (onSlot.some((run) => !isTerminalRunStatus(run.status))) return null;
  const newest = onSlot
    .filter((run) => !neverClaimed(run))
    .reduce<Run | null>(
      (best, run) => (!best || createdAt(run) > createdAt(best) ? run : best),
      null,
    );
  if (
    !newest ||
    newest.status !== 'done' ||
    newest.completionPolicy !== 'artifact-only' ||
    !parksBranchCommits(newest) ||
    newest.project !== slot.project ||
    newest.releasedCheckout?.slotId !== slot.slot ||
    newest.releasedCheckout.branch !== slot.branch
  )
    return null;
  // A refused completion on the same branch still needs this checkout.
  if (
    onSlot.some(
      (run) =>
        run.id !== newest.id && run.branch === slot.branch && isCompletionPrerequisiteFailure(run),
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

function stateFor(slotId: string, runId?: string): SlotRetryState {
  let state = states.get(slotId);
  if (!state || (runId && state.runId && state.runId !== runId)) {
    state = { streak: 0, nextAttemptAt: 0, backoffMs: 0 };
    states.set(slotId, state);
  }
  if (runId) state.runId = runId;
  return state;
}

/** One pass. Overlapping calls are dropped; each slot's failure stays its own. */
export async function retryReleasedCheckoutIdleReturns(
  deps: ReleasedCheckoutRetryDeps,
): Promise<void> {
  if (passInFlight) return;
  passInFlight = true;
  try {
    const now = deps.now();
    const candidates: SlotStatus[] = [];
    const ready = (await deps.fleetSlots()).filter(unownedReady);
    // A slot claimed or gone since starts afresh: the same error on its return is logged again.
    const readyIds = new Set(ready.map((slot) => slot.slot));
    for (const slotId of [...configErrors.keys()])
      if (!readyIds.has(slotId)) configErrors.delete(slotId);
    for (const slot of ready) {
      let idle: { defaultBranch: string; tracking: string };
      try {
        idle = await deps.idleBranches(slot);
      } catch (error) {
        // An unreadable project config is this slot's problem, not the pass's: logged once
        // while it keeps failing.
        const reason = errorText(error);
        if (configErrors.get(slot.slot) !== reason)
          deps.log(`[slot.release] ${slot.slot}: released checkout not checked: ${reason}`);
        configErrors.set(slot.slot, reason);
        continue;
      }
      configErrors.delete(slot.slot);
      if (!isSlotIdleBranch(slot.branch, idle.tracking, idle.defaultBranch, !!slot.linkedWorktree))
        candidates.push(slot);
    }
    const candidateIds = new Set(candidates.map((slot) => slot.slot));
    // A slot that drops out (claimed, refreshed, back on its idle branch) starts afresh next time.
    for (const slotId of [...states.keys()]) if (!candidateIds.has(slotId)) states.delete(slotId);
    if (candidates.length === 0) return;
    // One run scan per pass, indexed by slot.
    const bySlot = new Map<string, Run[]>();
    for (const run of await deps.allRuns())
      for (const slotId of new Set([run.slotId, run.releasedCheckout?.slotId]))
        if (slotId && candidateIds.has(slotId))
          bySlot.set(slotId, [...(bySlot.get(slotId) ?? []), run]);
    for (const slot of candidates) {
      try {
        await retrySlot(deps, slot, bySlot.get(slot.slot) ?? [], now);
      } catch (error) {
        noteOnce(deps, slot.slot, stateFor(slot.slot), errorText(error));
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
  if (!owner) {
    states.delete(slot.slot);
    return;
  }
  const state = stateFor(slot.slot, owner.id);
  // Keep the back-off through a busy or absent pass; only the streak starts over.
  if (deps.slotBusy(slot.slot) || (await deps.absentNode(slot.slot))) {
    state.streak = 0;
    return;
  }
  // The node must stay connected across passes: a reconnect in between starts over too.
  const session = await deps.nodeSession(slot.slot);
  if (state.session !== session) state.streak = 0;
  state.session = session;
  state.streak += 1;
  if (state.streak < RELEASED_CHECKOUT_STABLE_PASSES || now < state.nextAttemptAt) return;
  // Throttle before any bundle or network work; a throw from here on is this attempt's refusal.
  backOff(state, now);
  let refusal: string | null;
  try {
    refusal = await attempt(deps, slot, owner, runs);
  } catch (error) {
    refusal = errorText(error);
  }
  if (refusal === null) {
    states.delete(slot.slot);
    deps.log(
      `[slot.release] ${slot.slot}: returned run ${owner.id.slice(0, 8)}'s released checkout to idle`,
    );
    return;
  }
  noteOnce(deps, slot.slot, state, refusal);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The attempt itself: null when the slot is back at idle, otherwise why not. */
async function attempt(
  deps: ReleasedCheckoutRetryDeps,
  slot: SlotStatus,
  owner: Run,
  passRuns: readonly Run[],
): Promise<string | null> {
  const bundle = await deps.bundleCheck(owner);
  if (!bundle.confirmed)
    return `run ${owner.id.slice(0, 8)}'s bundle is not confirmed (${bundle.reason})`;
  // Re-read the slot and every live run just before acting: a pin may have arrived meanwhile.
  const row = await deps.readSlotRow(slot.slot);
  const fresh = await deps.freshRun(owner.id);
  const live = deps
    .liveRuns()
    .filter((run) => run.slotId === slot.slot || run.releasedCheckout?.slotId === slot.slot);
  const liveIds = new Set(live.map((run) => run.id));
  const current = [...live, ...passRuns.filter((run) => !liveIds.has(run.id))].map((run) =>
    fresh && run.id === fresh.id ? fresh : run,
  );
  if (
    !row ||
    row.current_run_id ||
    row.cleanup_run_id ||
    row.handoff_run_id ||
    row.workspace_recovery ||
    row.lifecycle !== 'ready' ||
    row.phase === 'releasing' ||
    (typeof row.branch === 'string' && row.branch !== slot.branch)
  )
    return 'the slot changed before the attempt';
  if (!fresh || releasedCheckoutOwner(slot, current)?.id !== fresh.id)
    return 'the run no longer qualifies';
  if (deps.slotBusy(slot.slot)) return 'a teardown or prepare started on the slot';
  const result = await deps.returnToIdle(fresh);
  if (result?.kind === 'ready') return null;
  return result?.reason ?? 'the run no longer qualifies';
}

/** Production wiring: the same fenced idle return release uses, strict about the recorded head. */
export async function defaultReleasedCheckoutRetryDeps(
  absentNode: ReleasedCheckoutRetryDeps['absentNode'],
): Promise<ReleasedCheckoutRetryDeps> {
  const [
    { loadFleetStatus },
    core,
    config,
    store,
    scrub,
    teardown,
    prepareGuards,
    machines,
    tracking,
    safeIdle,
  ] = await Promise.all([
    import('../fleet/state.js'),
    import('../core/state.js'),
    import('../core/index.js'),
    import('../runs/store.js'),
    import('../methods/slot/temp-scrub.js'),
    import('../run-engine/terminal-teardown-registry.js'),
    import('../core/native-worker-exclusion.js'),
    import('../fleet/machine-registry.js'),
    import('../methods/slot/slot-tracking.js'),
    import('./safe-idle-slot.js'),
  ]);
  return {
    now: () => Date.now(),
    fleetSlots: async () => (await loadFleetStatus()).slots,
    idleBranches: async (slot) => {
      const project = await config.loadProjectVars(slot.project);
      const defaultBranch =
        config.getProjectField(project.projectJson, 'default_branch') || DEFAULT_BRANCH;
      if (!slot.linkedWorktree) return { defaultBranch, tracking: defaultBranch };
      const vars = await config.loadSlotVars(slot.slot);
      return {
        defaultBranch,
        tracking: tracking.resolveSlotTrackingBranchFromProject(
          project.projectJson,
          vars,
          project,
          true,
        ),
      };
    },
    readSlotRow: (slotId) => core.readSlotRow(slotId),
    allRuns: () => store.getAllRunsWithArchived(),
    liveRuns: () => store.getAllRuns(),
    freshRun: (runId) => store.getRunWithArchived(runId),
    bundleCheck: (run) => scrub.taskBundleCheck(run),
    slotBusy: (slotId) =>
      teardown.isTerminalTeardownInFlight(slotId) || prepareGuards.activePrepareSlots.has(slotId),
    absentNode,
    nodeSession: async (slotId) => {
      const { machine } = await config.loadSlotVars(slotId);
      return `${machine}@${machines.getNode(machine)?.connectedAt ?? 'local'}`;
    },
    returnToIdle: async (run) => {
      const { broadcastEvent } = await import('../server.js');
      return safeIdle.returnReleasedCheckoutToIdle(run, broadcastEvent, { exactHead: true });
    },
    log: (message) => console.log(message),
  };
}
