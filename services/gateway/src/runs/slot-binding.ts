import { resolveRunSlotId, type Run } from '@farmslot/protocol';

import { getRun, updateRun } from './store.js';

/** Restore top-level slotId from find-slot / agent context when replay left it null. */
export function ensureRunSlotBinding(runId: string): Run {
  const current = getRun(runId);
  if (!current) throw new Error(`Run not found: ${runId}`);
  if (current.slotId?.trim()) return current;

  const resolved = resolveRunSlotId(current);
  if (!resolved) return current;

  console.log(
    `[run] restored slotId ${resolved} on ${runId.slice(0, 8)} from run binding metadata`,
  );
  return updateRun(runId, { slotId: resolved });
}
