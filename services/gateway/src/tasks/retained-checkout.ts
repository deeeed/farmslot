import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isRecord, type Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { slotFileExists, slotReadFile, slotRealpath } from '../core/slot-io.js';
import { readRetainedTaskReceipt } from '../run-completion/restore-task-artifacts.js';

/** Admission only. Prepare still verifies the complete retained task and tooling. */
export async function assertRetainedTaskCheckout(
  run: Run,
  slot: SlotVars,
  workerTaskDir: string,
): Promise<void> {
  const raw = await readRetainedTaskReceipt(run);
  // Legacy and pending tasks have no producer-owned execution receipt.
  if (raw === null) return;
  const receipt: unknown = JSON.parse(raw);
  if (!isRecord(receipt) || typeof receipt.pin !== 'string')
    throw new Error(`Run ${run.id} has an invalid task execution receipt.`);
  const authority: unknown = JSON.parse(
    await slotReadFile(slot, path.posix.join(receipt.pin, 'provenance.json')),
  );
  if (
    !isRecord(authority) ||
    typeof authority.taskDir !== 'string' ||
    !isDeepStrictEqual(authority.receipt, receipt)
  )
    throw new Error(`Run ${run.id} task receipt differs from its producer-owned pin.`);

  // The task may have been cleaned. Resolve its nearest surviving ancestor so
  // checkout symlinks still compare against the producer's recorded real path.
  let ancestor = workerTaskDir;
  const missing: string[] = [];
  while (!(await slotFileExists(slot, ancestor))) {
    const parent = path.posix.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve task checkout ${workerTaskDir}`);
    missing.unshift(path.posix.basename(ancestor));
    ancestor = parent;
  }
  const target = path.posix.join(await slotRealpath(slot, ancestor), ...missing);
  if (authority.taskDir !== target)
    throw new Error(
      `Run ${run.id} has an initialized task bound to ${authority.taskDir}; it can only be re-activated on that checkout.`,
    );
}
