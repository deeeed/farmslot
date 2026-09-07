import type {
  HostPressureAdmissionMode,
  RuntimeCapabilityAcquireConflict,
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityPressureAdvisory,
} from '@farmslot/protocol';

export interface RuntimeCapabilityPressureSnapshot {
  severity: 'ok' | 'warn' | 'critical';
  reason?: string;
  machine?: string;
  retryAfterMs?: number;
  unavailableReason?: string;
}

export interface RuntimeCapabilityAdmissionOptions {
  /**
   * The project's (or the gateway override's) host-pressure policy. `off` is
   * the DEFAULT and never refuses: the conflict still comes back so the caller
   * can carry it as an advisory, marked `enforced: false`.
   */
  mode: HostPressureAdmissionMode;
  /** Caller's own request to queue rather than be refused. `queue` mode forces it. */
  queueOnPressure: boolean;
}

/**
 * Medium- and high-cost resources stop or queue at critical pressure ONLY when
 * the project opts in (`refuse`/`queue`). Low-cost capabilities remain
 * admissible in every mode. This returns policy only and never cancels or
 * mutates another run.
 *
 * Machine UNAVAILABILITY is not part of the opt-in gate: an offline machine or
 * one with no health metrics cannot host a provider at all, so that refusal
 * stands whatever the pressure mode says.
 */
export function evaluateRuntimeCapabilityAdmission(
  entry: RuntimeCapabilityCatalogEntry,
  pressure: RuntimeCapabilityPressureSnapshot,
  options: RuntimeCapabilityAdmissionOptions,
): RuntimeCapabilityAcquireConflict | RuntimeCapabilityPressureAdvisory | null {
  if (pressure.unavailableReason) {
    return {
      kind: 'unavailable',
      capabilityId: entry.id,
      reason: pressure.unavailableReason,
    };
  }
  if (pressure.severity !== 'critical' || entry.cost.class === 'low') return null;
  if (options.mode === 'off') {
    // A DIFFERENT type, not a conflict with a flag: nothing downstream that
    // handles refusals can be handed this by accident, because it is not a
    // member of RuntimeCapabilityAcquireConflict at all. It also carries when
    // it was read, since it outlives that read pinned to the lease.
    return {
      kind: 'host-pressure-advisory',
      severity: 'critical',
      reason:
        pressure.reason ??
        `${entry.cost.class}-cost capability acquired under critical host pressure`,
      ...(pressure.machine ? { machine: pressure.machine } : {}),
      observedAt: new Date().toISOString(),
    };
  }
  return {
    kind: 'host-pressure',
    severity: 'critical',
    reason:
      pressure.reason ?? `${entry.cost.class}-cost capability blocked by critical host pressure`,
    ...(pressure.machine ? { machine: pressure.machine } : {}),
    queued: options.mode === 'queue' || options.queueOnPressure,
    ...(pressure.retryAfterMs ? { retryAfterMs: pressure.retryAfterMs } : {}),
  };
}
