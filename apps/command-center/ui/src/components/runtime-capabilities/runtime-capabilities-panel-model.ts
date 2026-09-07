import {
  observedStateForLease,
  type ResourcePostureObservedState,
  type RunResourceWaitPhase,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityClaimScope,
  type RuntimeCapabilityClaimWaiter,
  type RuntimeCapabilityLease,
  type RuntimeCapabilityStopWarmResult,
} from '@farmslot/protocol';

const PROVIDER_HOLDER_STATES = new Set<RuntimeCapabilityLease['state']>([
  'acquiring',
  'acquired',
  'releasing',
]);

export function projectRuntimeCapabilityLeases(leases: RuntimeCapabilityLease[]): {
  providerHolder: RuntimeCapabilityLease | undefined;
  queuedReservations: RuntimeCapabilityLease[];
} {
  let providerHolder: RuntimeCapabilityLease | undefined;
  const queuedReservations: RuntimeCapabilityLease[] = [];
  for (const lease of leases) {
    if (PROVIDER_HOLDER_STATES.has(lease.state)) providerHolder = lease;
    else if (lease.state === 'queued') queuedReservations.push(lease);
  }
  return { providerHolder, queuedReservations };
}

/**
 * Lease state and provider state are two different facts (ADR-054). A released
 * lease whose `keepWarmUntil` is still in the future leaves a live provider
 * behind, and the panel used to label exactly that case "Released", which reads
 * as "nothing is running".
 *
 * The provider verdict itself is never decided here: `observedStateForLease` in
 * the protocol is the one derivation the Gateway and every client share. This
 * module only turns that verdict into operator-facing words.
 */
export interface RuntimeCapabilityRetentionView {
  /** Ownership: what the lease record says. */
  leaseLabel: string;
  /** What the provider is doing, as the shared derivation reports it. */
  observedState: ResourcePostureObservedState;
  observedLabel: string;
  /** ISO deadline while a released provider is still within its warm window. */
  warmUntil?: string;
  /** Why the provider is in this state, in operator words. */
  retentionReason: string;
  cleanupFailure?: string;
  /** True while a released lease is still inside its keep-warm window. */
  warmWindowOpen: boolean;
}

function leaseLabelFor(
  lease: RuntimeCapabilityLease | undefined,
  planned: boolean,
  entry: Pick<RuntimeCapabilityCatalogEntry, 'availability'>,
): string {
  if (!lease) {
    if (planned) return 'Planned';
    return entry.availability.state === 'unavailable' ? 'Unavailable' : 'Available';
  }
  if (lease.state === 'acquired') return 'Acquired';
  return `${lease.state.charAt(0).toUpperCase()}${lease.state.slice(1)}`;
}

const OBSERVED_LABELS: Record<ResourcePostureObservedState, string> = {
  running: 'running',
  stopped: 'stopped',
  unhealthy: 'unhealthy',
  transitioning: 'transitioning',
  unknown: 'not observed',
};

/**
 * Why the provider is in the state the Gateway reports. Explanation only — the
 * state itself is never recomputed here.
 */
function retentionReasonFor(input: {
  entry: Pick<RuntimeCapabilityCatalogEntry, 'availability'>;
  lease: RuntimeCapabilityLease | undefined;
  observed: ResourcePostureObservedState;
  warmWindowOpen: boolean;
}): string {
  const { entry, lease, observed, warmWindowOpen } = input;
  if (!lease) {
    return entry.availability.state === 'unavailable'
      ? (entry.availability.reason ?? 'the provider reports itself unavailable')
      : 'no lease has been taken on this slot';
  }
  if (lease.cleanupFailure) return lease.cleanupFailure;
  if (lease.state === 'error') {
    return 'the last lifecycle action failed; the provider state is not proven';
  }
  if (lease.state === 'acquiring' && lease.wait?.kind === 'scoped-claim') {
    // A RESERVATION, not a boot. The queue drain handed this run the claim and
    // no provider action has run for it — "an acquiring action is in flight"
    // described a device that is starting, which is the one thing this is not.
    return `'${lease.wait.claimId}' is reserved for this run at ${lease.wait.scope} scope; its provider has not started yet`;
  }
  if (lease.state === 'acquiring' || lease.state === 'releasing') {
    return `a ${lease.state} action is in flight`;
  }
  if (lease.state === 'queued') {
    // A scoped claim names the run that actually holds it, which is usually on
    // another slot — and this panel is slot-filtered, so nothing else on the
    // row could tell an operator where to look.
    if (lease.wait?.kind === 'scoped-claim') {
      return `queued behind '${lease.wait.claimId}' at ${lease.wait.scope} scope, held by ${lease.wait.blockingOwner.runId}`;
    }
    return lease.pressure?.reason ?? 'the reservation is queued behind another holder';
  }
  if (lease.state === 'released') {
    if (warmWindowOpen) {
      return 'the lease was released but keep-warm holds the provider open for reuse';
    }
    if (lease.keepWarmUntil) {
      // The Gateway reports `unknown` here on purpose: the warm deadline is a
      // schedule, and the sweeper may not have run yet.
      return 'the keep-warm deadline has passed; the Gateway has not yet confirmed the provider stopped';
    }
    return 'the lease was released with no keep-warm window';
  }
  if (observed === 'unhealthy') {
    return lease.health.detail ?? 'the provider health check failed while acquired';
  }
  if (observed === 'running') return 'held by an active lease and passing its health check';
  return 'the lease is held but no health check has answered yet';
}

/**
 * Lease-versus-provider view for one capability.
 *
 * `nowMs` is passed in rather than read from the clock so the warm window is
 * evaluated against the same instant the caller rendered with.
 */
export function runtimeCapabilityRetentionView(input: {
  entry: Pick<RuntimeCapabilityCatalogEntry, 'availability' | 'keepWarmMs'>;
  lease: RuntimeCapabilityLease | undefined;
  planned: boolean;
  nowMs: number;
}): RuntimeCapabilityRetentionView {
  const { entry, lease, planned, nowMs } = input;
  // The Gateway's derivation, not ours.
  const observedState = observedStateForLease(lease, nowMs);
  const warmWindowOpen = Boolean(
    lease?.state === 'released' && lease.keepWarmUntil && Date.parse(lease.keepWarmUntil) > nowMs,
  );
  const cleanupFailure = lease?.cleanupFailure;
  return {
    leaseLabel: leaseLabelFor(lease, planned, entry),
    observedState,
    observedLabel:
      warmWindowOpen && observedState === 'running'
        ? 'running (warm)'
        : OBSERVED_LABELS[observedState],
    ...(warmWindowOpen && lease?.keepWarmUntil ? { warmUntil: lease.keepWarmUntil } : {}),
    retentionReason: retentionReasonFor({ entry, lease, observed: observedState, warmWindowOpen }),
    ...(cleanupFailure ? { cleanupFailure } : {}),
    warmWindowOpen,
  };
}

export type RuntimeCapabilityRecoveryAction = 'acquire' | 'restart' | 'release';

/**
 * Which recovery actions this panel can honestly perform right now.
 *
 * A warm provider offers Stop again: `runtime.capability.stopWarm` acts on
 * exactly the released-but-live lease that `runtime.capability.release` skips.
 * The two go to different RPCs, so the caller must pick by `warmWindowOpen`.
 *
 * Acquire stays available even when the provider's observed state is `unknown`.
 * The registry health-checks any lease still carrying a keep-warm deadline,
 * expired or not, and either adopts that provider or cleans it up before
 * acquiring fresh — so deciding here would only withhold a safe action.
 */
export function runtimeCapabilityRecoveryActions(input: {
  view: RuntimeCapabilityRetentionView;
  lease: RuntimeCapabilityLease | undefined;
  hasOwnerRunId: boolean;
  available: boolean;
}): RuntimeCapabilityRecoveryAction[] {
  const { view, lease, hasOwnerRunId, available } = input;
  const actions: RuntimeCapabilityRecoveryAction[] = [];
  const held = Boolean(lease && lease.state !== 'released' && lease.state !== 'queued');
  if (!held && hasOwnerRunId && available) actions.push('acquire');
  if (held && hasOwnerRunId) actions.push('restart');
  // Warm counts: it is a live process, just one no lease owns any more.
  if (held || view.warmWindowOpen || view.cleanupFailure) actions.push('release');
  return actions;
}

/**
 * Whether Stop on this row must go through `runtime.capability.stopWarm` rather
 * than `runtime.capability.release`. Release filters released leases and returns
 * success without touching the process, so a warm row sent there reports a stop
 * that never happened.
 */
export function runtimeCapabilityStopUsesWarmPath(
  view: RuntimeCapabilityRetentionView,
  lease: RuntimeCapabilityLease | undefined,
): boolean {
  const held = Boolean(lease && lease.state !== 'released' && lease.state !== 'queued');
  return !held && view.warmWindowOpen;
}

/** How the panel should present one `runtime.capability.stopWarm` result. */
export interface RuntimeCapabilityStopWarmView {
  /** Inline note for the row, or null when the outcome speaks for itself. */
  note: string | null;
  tone: 'info' | 'error';
  /** Keep Stop available for another attempt. */
  keepStopAction: boolean;
  /** What the Gateway observed. Never `stopped` unless it really stopped. */
  observedState: ResourcePostureObservedState;
}

/**
 * Turn a stopWarm result into what the row should show.
 *
 * `deferred` is a refusal, not a failure: something still needs the provider, so
 * it is reported in the Gateway's own words with the control left in place. The
 * one thing this must never do is present a stop that did not happen, so an
 * outcome of `stopped` that did not come back with an observed `stopped` is
 * surfaced as a discrepancy rather than trusted.
 */
export function stopWarmOutcomeView(
  result: RuntimeCapabilityStopWarmResult,
): RuntimeCapabilityStopWarmView {
  const observedState = result.observedState;
  if (result.outcome === 'stopped') {
    if (observedState !== 'stopped') {
      return {
        note: `The Gateway reported the provider stopped but observed it '${observedState}'. Treat it as still running.`,
        tone: 'error',
        keepStopAction: true,
        observedState,
      };
    }
    return {
      note: result.effects.length ? `Stopped. ${result.effects.join('; ')}` : 'Stopped.',
      tone: 'info',
      keepStopAction: false,
      observedState,
    };
  }
  if (result.outcome === 'deferred') {
    return {
      note:
        result.reason ??
        'The Gateway kept this provider: something that is still running depends on it.',
      tone: 'info',
      keepStopAction: true,
      observedState,
    };
  }
  if (result.outcome === 'not-warm') {
    return {
      note: result.reason ?? 'Nothing was keeping this capability warm on this slot.',
      tone: 'info',
      keepStopAction: false,
      observedState,
    };
  }
  return {
    note:
      result.cleanupFailure ?? result.reason ?? 'Cleanup failed; the provider state is unknown.',
    tone: 'error',
    keepStopAction: true,
    observedState,
  };
}

/** This slot's place in a scoped claim's queue, for one capability row. */
export interface RuntimeCapabilityQueueView {
  claimId: string;
  scope: RuntimeCapabilityClaimScope;
  blockingRunId: string;
  /** `granted` once the claim is reserved for this slot's run. */
  phase: RunResourceWaitPhase;
  /** 1-based place, absent when granted or when the Gateway sent no queue. */
  position?: number;
  /** Waiters on this claim across every slot in scope. */
  total?: number;
  summary: string;
}

/**
 * Where this slot's queued lease sits in the claim's fleet-wide queue.
 *
 * Position and total come from `claimWaiters`, which the Gateway derives across
 * every slot. They are deliberately not counted from `leases`: that list is
 * slot-filtered, so counting it would report "position 1 of 1" to every waiter
 * in a three-deep queue.
 */
export function runtimeCapabilityQueueView(input: {
  lease: RuntimeCapabilityLease | undefined;
  claimWaiters: readonly RuntimeCapabilityClaimWaiter[] | undefined;
}): RuntimeCapabilityQueueView | undefined {
  const state = input.lease?.state;
  // Both states that carry a wait record. `acquiring` with one is the
  // RESERVATION the drain made: the claim is this slot's, and a reservation that
  // never turns into a running provider is a fleet device nobody can use — so
  // it has to appear here rather than disappear from the queue view entirely.
  const wait = state === 'queued' || state === 'acquiring' ? input.lease?.wait : undefined;
  if (!wait || wait.kind !== 'scoped-claim') return undefined;
  if (state === 'acquiring') {
    return {
      claimId: wait.claimId,
      scope: wait.scope,
      blockingRunId: wait.blockingOwner.runId,
      phase: 'granted',
      summary: `granted '${wait.claimId}' at ${wait.scope} scope · waiting for its provider to start`,
    };
  }
  const forClaim = (input.claimWaiters ?? []).filter((waiter) => waiter.claimId === wait.claimId);
  const mine = forClaim.find((waiter) => waiter.leaseId === input.lease!.id);
  const place = mine ? `position ${mine.position} of ${forClaim.length}` : 'queued';
  return {
    claimId: wait.claimId,
    scope: wait.scope,
    blockingRunId: wait.blockingOwner.runId,
    phase: 'queued',
    ...(mine ? { position: mine.position, total: forClaim.length } : {}),
    summary: `${place} for '${wait.claimId}' at ${wait.scope} scope · held by ${wait.blockingOwner.runId}`,
  };
}
