// backlog/standing-rerun.ts — a multi-PR item's next enqueue archives the item's own failed runs first.

import { runArchive } from '../methods/run/admin.js';
import { listRuns } from '../runs/store.js';

import { getBacklogItemSnapshot } from './store.js';

type Emit = (event: string, payload: unknown) => void;

/**
 * ADR-044 Amendment 2. A failed, unarchived run keeps its ticket (run.create refuses a second
 * run) and its slot (the fleet refresh re-holds it, so the dispatcher finds no slot). A multi-PR
 * item such as the standing nightly could therefore not start again after a failed run. When
 * such an item is enqueued for its next run, archive its failed runs on the ticket first through
 * the supported archive path (slot-release guards, history kept) and return their ids for the
 * new run's record. A live run or another item's run on the ticket archives nothing: the next
 * run then waits or is refused as before.
 */
export async function archiveFailedRunsBeforeEnqueue(
  itemId: string,
  emit: Emit,
): Promise<string[]> {
  const item = getBacklogItemSnapshot(itemId);
  if (!item?.multiPr || item.status !== 'ready' || item.queuedQueueItemId || item.runId) return [];
  // Active list runs: live ones, and failed ones not yet archived. A done run blocks nothing.
  const onTicket = listRuns({ active: true }).runs.filter(
    (run) => run.ticketOrPr === item.sourceRef && run.project === item.project,
  );
  if (!onTicket.every((run) => run.backlogItemId === item.id && run.status === 'failed')) return [];
  for (const run of onTicket) await runArchive({ runId: run.id }, emit);
  if (onTicket.length > 0)
    console.log(
      `[backlog] ${item.sourceRef}: archived failed run(s) ${onTicket.map((run) => run.id.slice(0, 8)).join(', ')} before its next run`,
    );
  return onTicket.map((run) => run.id);
}
