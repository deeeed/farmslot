import type {
  ResourcePostureObservedState,
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityLease,
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
 */
export interface RuntimeCapabilityRetentionView {
  /** Ownership: what the lease record says. */
  leaseLabel: string;
  /** What the provider is doing, in the shared posture vocabulary. */
  observedState: ResourcePostureObservedState;
  observedLabel: string;
  /** ISO deadline while a released provider is still warm, else undefined. */
  warmUntil?: string;
  /** Why the provider is in this state, in operator words. */
  retentionReason: string;
  cleanupFailure?: string;
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

/**
 * Derive lease-versus-provider state for one capability.
 *
 * `nowMs` is passed in rather than read from the clock so the warm deadline is
 * evaluated against the same instant the caller rendered with.
 */
export function runtimeCapabilityRetentionView(input: {
  entry: Pick<RuntimeCapabilityCatalogEntry, 'availability' | 'keepWarmMs'>;
  lease: RuntimeCapabilityLease | undefined;
  planned: boolean;
  nowMs: number;
}): RuntimeCapabilityRetentionView {
  const { entry, lease, planned, nowMs } = input;
  const leaseLabel = leaseLabelFor(lease, planned, entry);
  if (!lease) {
    return {
      leaseLabel,
      observedState: 'unknown',
      observedLabel: 'not observed',
      retentionReason:
        entry.availability.state === 'unavailable'
          ? (entry.availability.reason ?? 'the provider reports itself unavailable')
          : 'no lease has been taken on this slot',
    };
  }
  const cleanupFailure = lease.cleanupFailure;
  if (lease.state === 'error') {
    return {
      leaseLabel,
      observedState: 'unhealthy',
      observedLabel: 'unhealthy',
      retentionReason:
        cleanupFailure ?? 'the last lifecycle action failed; the provider state is not proven',
      ...(cleanupFailure ? { cleanupFailure } : {}),
    };
  }
  if (lease.state === 'acquiring' || lease.state === 'releasing') {
    return {
      leaseLabel,
      observedState: 'transitioning',
      observedLabel: 'transitioning',
      retentionReason: `a ${lease.state} action is in flight`,
      ...(cleanupFailure ? { cleanupFailure } : {}),
    };
  }
  if (lease.state === 'released') {
    const warmUntilMs = lease.keepWarmUntil ? Date.parse(lease.keepWarmUntil) : Number.NaN;
    if (Number.isFinite(warmUntilMs) && warmUntilMs > nowMs) {
      return {
        leaseLabel,
        observedState: 'running',
        observedLabel: 'running (warm)',
        warmUntil: lease.keepWarmUntil,
        retentionReason: 'the lease was released but keep-warm holds the provider open for reuse',
        ...(cleanupFailure ? { cleanupFailure } : {}),
      };
    }
    if (cleanupFailure) {
      return {
        leaseLabel,
        observedState: 'unhealthy',
        observedLabel: 'unhealthy',
        retentionReason: cleanupFailure,
        cleanupFailure,
      };
    }
    return {
      leaseLabel,
      observedState: 'stopped',
      observedLabel: 'stopped',
      retentionReason: 'the lease was released and its keep-warm window has passed',
    };
  }
  if (lease.state === 'queued') {
    return {
      leaseLabel,
      observedState: 'unknown',
      observedLabel: 'not observed',
      retentionReason: lease.pressure?.reason ?? 'the reservation is queued behind another holder',
    };
  }
  // acquired
  if (lease.health.state === 'unhealthy') {
    return {
      leaseLabel,
      observedState: 'unhealthy',
      observedLabel: 'unhealthy',
      retentionReason: lease.health.detail ?? 'the provider health check failed while acquired',
      ...(cleanupFailure ? { cleanupFailure } : {}),
    };
  }
  if (lease.health.state === 'unknown') {
    // An acquired lease with no health answer is not proof the provider is up.
    return {
      leaseLabel,
      observedState: 'unknown',
      observedLabel: 'not observed',
      retentionReason: 'the lease is held but no health check has answered yet',
      ...(cleanupFailure ? { cleanupFailure } : {}),
    };
  }
  return {
    leaseLabel,
    observedState: 'running',
    observedLabel: 'running',
    retentionReason: 'held by an active lease and passing its health check',
    ...(cleanupFailure ? { cleanupFailure } : {}),
  };
}

export type RuntimeCapabilityRecoveryAction = 'acquire' | 'restart' | 'release';

/**
 * Which recovery actions apply to a capability right now. Acquire needs an owner
 * run; restart and release need something to act on.
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
  // A warm provider still has something to stop even though its lease is gone.
  if (held || view.observedState === 'running' || view.cleanupFailure) actions.push('release');
  return actions;
}
