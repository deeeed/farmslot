import {
  Methods,
  type Run,
  type RunOutput,
  type RunRefreshMirrorResult,
  type SlotStatus,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { transferBoundRequestOptions } from '../../gateway-request-timeout.js';

export const RUN_MIRROR_REFRESH_TITLE = "Pull this run's latest files from its slot";

/**
 * Copies a run's files from its slot into the gateway artifact mirror again. The request stays
 * open while the copy reports progress: a large changed package outlasts any fixed window.
 */
export function refreshRunMirror(runId: string): Promise<RunRefreshMirrorResult> {
  return gateway.request<RunRefreshMirrorResult>(
    Methods.RUN_REFRESH_MIRROR,
    { runId },
    transferBoundRequestOptions(runId),
  );
}

function taskFolder(taskFile: string | null | undefined): string | undefined {
  return (
    taskFile
      ?.replace(/\/TASK\.md$/, '')
      .split('/')
      .pop() || undefined
  );
}

/**
 * Why there is nothing left to pull, or null while the slot still holds the run's task. A release
 * deletes the task and copies nothing back (F313), so the last sync is what the gateway keeps.
 * An unknown slot is left to the gateway to answer.
 */
export function runMirrorRefreshUnavailableReason(
  run: Pick<Run, 'id' | 'slotId' | 'taskFile'> & {
    output?: Pick<RunOutput, 'capturedAt' | 'captureError'>;
  },
  slots: readonly Pick<SlotStatus, 'slot' | 'lifecycle' | 'phase' | 'currentRunId' | 'taskFile'>[],
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): string | null {
  const slot = slots.find((entry) => entry.slot === run.slotId);
  if (!slot) return null;
  const occupied =
    (slot.lifecycle === 'busy' || slot.lifecycle === 'held') && slot.phase !== 'releasing';
  const task = taskFolder(run.taskFile);
  const holdsTask =
    slot.currentRunId === run.id ||
    (!slot.currentRunId && task !== undefined && taskFolder(slot.taskFile) === task);
  if (occupied && holdsTask) return null;
  if (!run.output?.capturedAt) return 'Slot released; no files were synced';
  // A failed sync also stamps capturedAt, over the files of the last good one.
  const at = formatTime(run.output.capturedAt);
  return run.output.captureError
    ? `Slot released; the last sync, at ${at}, failed`
    : `Slot released; files were synced at ${at}`;
}
