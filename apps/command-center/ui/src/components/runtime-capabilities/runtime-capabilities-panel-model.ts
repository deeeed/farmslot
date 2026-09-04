import {
  observedStateForLease,
  type ResourcePostureObservedState,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityLease,
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
  if (lease.state === 'acquiring' || lease.state === 'releasing') {
    return `a ${lease.state} action is in flight`;
  }
  if (lease.state === 'queued') {
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
 * `release` is offered only for a lease the Gateway will actually act on. The
 * release RPC skips leases that are already released, so offering "Stop" for a
 * warm provider would report success while the process kept running. Stopping a
 * warm provider needs a capability-scoped Gateway call that does not exist yet.
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
  if (held || view.cleanupFailure) actions.push('release');
  return actions;
}

/**
 * A warm provider the panel cannot stop, and why. Rendered so the missing
 * control is explained instead of silently absent.
 */
export function runtimeCapabilityWarmStopUnavailable(
  view: RuntimeCapabilityRetentionView,
): string | null {
  if (!view.warmWindowOpen) return null;
  return 'This provider is warm: its lease is released but the process stays up for reuse. Stopping it from here is not available yet; it stops at its keep-warm deadline or when the run reaches terminal cleanup.';
}
