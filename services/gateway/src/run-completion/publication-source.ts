import { isGateParkInFlightOrFreed, type Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { readSlotRow } from '../core/state.js';

export interface PublicationSource {
  headSha: string;
  branch: string;
  slotEpoch: number;
}

interface PublicationSourceReaders {
  slot: typeof readSlotRow;
  git: (run: Run) => Promise<{ headSha: string; branch: string }>;
}

/** Source authority requires both the slot lease and its actual checkout. */
export async function capturePublicationSource(
  run: Run,
  overrides: Partial<PublicationSourceReaders> = {},
): Promise<PublicationSource> {
  if (!run.slotId || !run.branch || isGateParkInFlightOrFreed(run))
    throw new Error('Publication source requires the owned unparked slot and branch');
  const readers: PublicationSourceReaders = {
    slot: readSlotRow,
    git: async (current) => {
      const result = await execOnSlot(
        await loadSlotVars(current.slotId!),
        'git rev-parse --abbrev-ref HEAD && git rev-parse HEAD',
        { timeout: 10_000 },
      );
      if (result.exitCode !== 0) throw new Error('Publication source checkout is unavailable');
      const [branch, headSha] = result.stdout.trim().split('\n');
      if (!branch || !headSha || !/^[a-f0-9]{40}$/i.test(headSha))
        throw new Error('Publication source checkout identity is unavailable');
      return { branch, headSha };
    },
    ...overrides,
  };
  const before = await readers.slot(run.slotId);
  if (before?.current_run_id !== run.id || typeof before.slot_epoch !== 'number')
    throw new Error('Publication source slot is no longer owned by this run');
  const git = await readers.git(run);
  const after = await readers.slot(run.slotId);
  if (
    after?.current_run_id !== run.id ||
    after.slot_epoch !== before.slot_epoch ||
    git.branch !== run.branch
  )
    throw new Error('Publication source slot ownership or branch changed');
  return { ...git, slotEpoch: before.slot_epoch };
}
