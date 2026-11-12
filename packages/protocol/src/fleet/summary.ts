import type { FleetSummary, SlotStatus } from '../contracts/slots.js';

/**
 * Compute fleet summary counts from a slots array.
 * Lives in protocol so both gateway and client share one implementation.
 * The gateway previously held this as a private function in fleet/state.ts.
 */
export function computeSummary(slots: SlotStatus[]): FleetSummary {
  const summary: FleetSummary = {
    total: slots.length,
    ready: 0,
    busy: 0,
    held: 0,
    manual: 0,
    disabled: 0,
    blocked: 0,
    warmCount: 0,
  };
  for (const s of slots) {
    switch (s.lifecycle) {
      case 'ready': {
        const healthy = s.health.ssh !== 'FAIL' && s.health.devserver !== 'FAIL';
        if (healthy) summary.ready++;
        else summary.blocked++;
        if (s.warm) summary.warmCount++;
        break;
      }
      case 'busy':
        summary.busy++;
        break;
      case 'held':
        summary.held++;
        break;
      case 'manual':
        summary.manual++;
        break;
      case 'disabled':
        summary.disabled++;
        break;
    }
  }
  return summary;
}
