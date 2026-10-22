const FLEET_STALE_MS_DEFAULT = 5 * 60_000;

export function fleetStaleThresholdMs(): number {
  const raw = Number(process.env.FARMSLOT_FLEET_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : FLEET_STALE_MS_DEFAULT;
}

export function isFleetCheckedAtStale(checkedAt: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(checkedAt);
  return !Number.isFinite(ts) || nowMs - ts > fleetStaleThresholdMs();
}

/** First clock millisecond at which the existing strict stale comparison becomes true. */
export function fleetStaleDeadline(checkedAt: string | undefined): number | undefined {
  const ts = Date.parse(checkedAt ?? '');
  return Number.isFinite(ts) ? ts + Math.floor(fleetStaleThresholdMs()) + 1 : undefined;
}
