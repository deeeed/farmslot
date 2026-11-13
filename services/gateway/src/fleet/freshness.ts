import { FLEET_STALE_MS_DEFAULT } from '@farmslot/protocol';

export function fleetStaleThresholdMs(): number {
  const raw = Number(process.env.FARMSLOT_FLEET_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : FLEET_STALE_MS_DEFAULT;
}

export function isFleetCheckedAtStale(checkedAt: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(checkedAt);
  return !Number.isFinite(ts) || nowMs - ts > fleetStaleThresholdMs();
}

/**
 * The snapshot age at which the monitor starts a refresh: half the threshold. A fleet whose
 * refresh completes within the other half, less one monitor turn, never shows stale; a slower one
 * still crosses the threshold.
 */
export function fleetRefreshDueAgeMs(): number {
  return fleetStaleThresholdMs() / 2;
}

export function isFleetRefreshDue(checkedAt: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(checkedAt);
  return !Number.isFinite(ts) || nowMs - ts > fleetRefreshDueAgeMs();
}

/** First clock millisecond at which the existing strict stale comparison becomes true. */
export function fleetStaleDeadline(checkedAt: string | undefined): number | undefined {
  const ts = Date.parse(checkedAt ?? '');
  return Number.isFinite(ts) ? ts + Math.floor(fleetStaleThresholdMs()) + 1 : undefined;
}
