import type {
  RuntimeCapabilityAcquireConflict,
  RuntimeCapabilityCatalogEntry,
} from '@farmslot/protocol';

export interface RuntimeCapabilityPressureSnapshot {
  severity: 'ok' | 'warn' | 'critical';
  reason?: string;
  machine?: string;
  retryAfterMs?: number;
  unavailableReason?: string;
}

/**
 * Medium- and high-cost resources stop or queue at critical pressure according
 * to queueOnPressure. Low-cost capabilities remain admissible. This returns
 * policy only and never cancels or mutates another run.
 */
export function evaluateRuntimeCapabilityAdmission(
  entry: RuntimeCapabilityCatalogEntry,
  pressure: RuntimeCapabilityPressureSnapshot,
  queueOnPressure: boolean,
): RuntimeCapabilityAcquireConflict | null {
  if (pressure.unavailableReason) {
    return {
      kind: 'unavailable',
      capabilityId: entry.id,
      reason: pressure.unavailableReason,
    };
  }
  if (pressure.severity !== 'critical' || entry.cost.class === 'low') return null;
  return {
    kind: 'host-pressure',
    severity: 'critical',
    reason:
      pressure.reason ?? `${entry.cost.class}-cost capability blocked by critical host pressure`,
    ...(pressure.machine ? { machine: pressure.machine } : {}),
    queued: queueOnPressure,
    ...(pressure.retryAfterMs ? { retryAfterMs: pressure.retryAfterMs } : {}),
  };
}
