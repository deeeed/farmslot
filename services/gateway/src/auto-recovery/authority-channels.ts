import type { IntelligenceActionProposedType } from '@farmslot/protocol';
export const ALLOWED_RECOVERY_ACTIONS: readonly IntelligenceActionProposedType[] = [
  'run.replayStep',
  'slot.reset',
  'slot.cleanupProcesses',
  'slot.fixtureRefresh',
  'tmux.send',
];
export function validateProposedAction(
  raw: unknown,
): { ok: true; type: IntelligenceActionProposedType } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, reason: 'proposedAction must be an object' };
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string')
    return { ok: false, reason: 'proposedAction.type must be a string' };
  if (!(ALLOWED_RECOVERY_ACTIONS as readonly string[]).includes(type))
    return { ok: false, reason: `proposedAction.type not allowed: ${type}` };
  return { ok: true, type: type as IntelligenceActionProposedType };
}
