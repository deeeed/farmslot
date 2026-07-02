import type { SlotStatus } from '@farmslot/protocol';

/**
 * Slots in orchestration phases (preparing, dispatching, review-gate, …) are
 * intentionally busy with agent=idle — no tmux worker yet. Idle/stuck monitor
 * violations apply only when the slot is in the live worker monitor phase.
 */
export function isWorkerMonitorPhase(slot: Pick<SlotStatus, 'lifecycle' | 'phase'>): boolean {
  return slot.lifecycle === 'busy' && slot.phase === 'working';
}
