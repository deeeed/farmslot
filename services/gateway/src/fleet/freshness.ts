const FLEET_STALE_MS_DEFAULT = 5 * 60_000;

export function fleetStaleThresholdMs(): number {
  const raw = Number(process.env.FARMSLOT_FLEET_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : FLEET_STALE_MS_DEFAULT;
}

export function isFleetCheckedAtStale(checkedAt: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(checkedAt);
  return !Number.isFinite(ts) || nowMs - ts > fleetStaleThresholdMs();
}

/**
 * The monitor refreshes a snapshot this old, at half the threshold. Its 30 s loop then starts the
 * refresh by 0.5 threshold + 30 s (180 s at the default), leaving 120 s for the machine probes, whose
 * stages each run under a 5 s timeout. A fleet whose machines answer never reaches the threshold.
 */
export function isFleetRefreshDue(checkedAt: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(checkedAt);
  return !Number.isFinite(ts) || nowMs - ts > fleetStaleThresholdMs() / 2;
}

/** First clock millisecond at which the existing strict stale comparison becomes true. */
export function fleetStaleDeadline(checkedAt: string | undefined): number | undefined {
  const ts = Date.parse(checkedAt ?? '');
  return Number.isFinite(ts) ? ts + Math.floor(fleetStaleThresholdMs()) + 1 : undefined;
}
