import { isDeepStrictEqual } from 'node:util';

import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { readSlotField } from '../core/state.js';
import { publicationStatusForRun } from '../run-completion/publication-status.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';
import { currentSessionPrincipal } from '../security/work-originator.js';
import { refreshWrittenTaskTicket } from '../tasks/writer.js';

import { fetchTicketData } from './ticket-data.js';

/** Caller holds the publication transition and has confirmed that the worker is idle. */
export async function refreshRunTicket(run: Run): Promise<Run> {
  const principal = currentSessionPrincipal();
  if (principal?.subject.type !== 'person')
    throw new Error('Ticket refresh requires an authenticated person');
  if (run.acceptanceRegistration)
    throw new Error(
      'PR-completion acceptance uses operator instructions; ticket refresh cannot replace it',
    );
  const generation = run.engineState?.generation ?? 0;
  const { slotId, taskFile, project, ticketOrPr } = run;
  const owns = async () => {
    const current = getRun(run.id);
    return Boolean(
      current &&
      !isTerminalRunStatus(current.status) &&
      current.status !== 'paused' &&
      !current.prNumber &&
      publicationStatusForRun(current) === 'not_published' &&
      (current.engineState?.generation ?? 0) === generation &&
      current.slotId === slotId &&
      current.taskFile === taskFile &&
      current.project === project &&
      current.ticketOrPr === ticketOrPr &&
      (!slotId || (await readSlotField(slotId, 'current_run_id')) === run.id),
    );
  };
  if (!(await owns()))
    throw new Error('Ticket refresh requires an unpublished run with its task owner');
  let refresh = run.ticketRefreshes?.at(-1);
  // Finish the same admitted snapshot after an interrupted task write, even if the source changed again.
  if (!refresh || refresh.appliedAt) {
    const ticketData = await fetchTicketData(run);
    if (!ticketData || ticketData.source === 'manual')
      throw new Error('Ticket refresh could not load the ticket source');
    if (!(await owns())) throw new Error('Ticket refresh lost its task owner');
    if (isDeepStrictEqual(ticketData, run.ticketData)) return run;
    refresh = {
      principalId: principal.id,
      ...(principal.generation !== undefined ? { principalGeneration: principal.generation } : {}),
      requestedAt: new Date().toISOString(),
      previousCriteria: [...(run.ticketData?.acceptanceCriteria ?? [])],
      criteria: [...ticketData.acceptanceCriteria],
    };
    run = updateRun(run.id, {
      ticketData,
      ticketRefreshes: [...(run.ticketRefreshes ?? []), refresh],
    });
    await persistRunNow(run, 'person ticket refresh admitted');
  }
  await refreshWrittenTaskTicket(run, run.ticketData!, refresh.previousCriteria, owns);
  if (!(await owns())) throw new Error('Ticket refresh lost its task owner');
  const current = getRun(run.id)!;
  run = updateRun(run.id, {
    ticketRefreshes: current.ticketRefreshes!.map((entry) =>
      entry === refresh ? { ...entry, appliedAt: new Date().toISOString() } : entry,
    ),
  });
  await persistRunNow(run, 'person ticket refresh applied');
  return run;
}
