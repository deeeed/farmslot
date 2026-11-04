import type { Run } from '@farmslot/protocol';

export function requestedRunSlotId(run: Run): string | null {
  if (run.requestedSlotId !== undefined) return run.requestedSlotId;
  if (run.dispatchRequest) return run.dispatchRequest.slotId ?? null;
  const step = run.steps.find((candidate) => candidate.name === 'find-slot');
  const requested = step?.inputs?.requestedSlotId;
  if (typeof requested === 'string' && requested) return requested;
  const selected = step?.outputs?.selectedSlot;
  if (typeof selected === 'string') {
    return step?.outputs?.selectionMethod === 'user-specified' ||
      step?.outputs?.selectionMethod === 'human-override'
      ? selected
      : null;
  }
  // Before selection, slotId itself was the request on older runs.
  return step?.inputs ? null : run.slotId;
}
