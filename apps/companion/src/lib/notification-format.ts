import type { MonitorViolation, MonitorViolationPayload } from '@farmslot/protocol';

export type MonitorViolationInput = MonitorViolation | MonitorViolationPayload | null | undefined;

const NON_ACTIONABLE_SLOT_IDS = new Set([
  '-',
  'n/a',
  'none',
  'null',
  'undefined',
  'unknown',
  'unknown slot',
  'slot unknown',
]);

const MONITOR_TYPE_LABELS: Record<MonitorViolation['type'], string> = {
  stuck: 'Worker finished',
  skipped: 'Monitor skipped',
  idle: 'Worker idle',
  waiting: 'Worker waiting',
  error: 'Worker error',
  budget: 'Usage budget',
};

function isActionableSlotId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized || NON_ACTIONABLE_SLOT_IDS.has(normalized)) return false;
  return !/^(?:slot\s*)?(?:unknown|undefined|null)(?:\s*slot)?$/i.test(normalized);
}

function isActionableMonitorType(value: unknown): value is MonitorViolation['type'] {
  // budget remains a protocol type for Command Center / gateway feeds, but is not
  // a Companion push notification (device recipe deferred; operator sees gateway).
  return value === 'stuck' || value === 'idle' || value === 'waiting' || value === 'error';
}

export function normalizeMonitorViolation(input: MonitorViolationInput): MonitorViolation | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = 'violation' in input ? input.violation : input;
  if (!candidate || typeof candidate !== 'object') return null;
  if (
    !isActionableSlotId(candidate.slotId) ||
    !isActionableMonitorType(candidate.type) ||
    typeof candidate.message !== 'string' ||
    !candidate.message.trim()
  ) {
    return null;
  }
  return { ...candidate, slotId: candidate.slotId.trim(), message: candidate.message.trim() };
}

export function monitorViolationDedupeKey(violation: MonitorViolation): string {
  return [violation.slotId, violation.type, violation.role ?? '', violation.contextId ?? ''].join(
    '\0',
  );
}

export function monitorViolationTitle(violation: MonitorViolation): string {
  return `${MONITOR_TYPE_LABELS[violation.type]} · ${violation.slotId}`;
}

export function monitorViolationBody(violation: MonitorViolation): string {
  const context = [violation.role, violation.contextId].filter(Boolean).join(' / ');
  return context ? `${context}: ${violation.message}` : violation.message;
}
