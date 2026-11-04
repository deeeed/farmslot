import type { Run } from '@farmslot/protocol';

export function requestedRunSlotId(run: Run): string | null {
  // Older placement records also contain scheduler picks, so they cannot establish intent.
  return run.requestedSlotId ?? null;
}
