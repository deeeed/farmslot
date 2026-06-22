const DEFAULT_GATEWAY_TIMEOUT_MS = 30_000;
const DEFAULT_SLOT_PREPARE_TIMEOUT_MS = 30 * 60_000;
const SLOT_PREPARE_TIMEOUT_GRACE_MS = 5_000;

function parsePositiveTimeout(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveSlotPrepareGatewayTimeoutMs(globalTimeout: unknown): number {
  const baseTimeout = parsePositiveTimeout(globalTimeout) ?? DEFAULT_GATEWAY_TIMEOUT_MS;
  return Math.max(baseTimeout, DEFAULT_SLOT_PREPARE_TIMEOUT_MS + SLOT_PREPARE_TIMEOUT_GRACE_MS);
}
