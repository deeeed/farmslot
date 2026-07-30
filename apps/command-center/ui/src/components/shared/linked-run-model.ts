import type { BacklogItem, Run } from '@farmslot/protocol';
import { isTerminalRunStatus } from '@farmslot/protocol';

export function linkedRunForBacklogItem(runs: Run[], item: BacklogItem): Run | undefined {
  const explicitMatches = runs.filter(
    (run) => run.backlogItemId === item.id || (item.runId && run.id === item.runId),
  );
  // run.create can intentionally start an item outside the backlog dispatcher.
  // Keep that planning row honest by projecting an exact project + source-ref
  // match when no durable backlog link exists. Explicit linkage always wins.
  const matches =
    explicitMatches.length > 0
      ? explicitMatches
      : runs.filter((run) => run.project === item.project && run.ticketOrPr === item.sourceRef);
  const newestFirst = [...matches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return newestFirst.find((run) => !isTerminalRunStatus(run.status)) ?? newestFirst[0];
}

export function activeLinkedRunForBacklogItem(runs: Run[], item: BacklogItem): Run | undefined {
  const run = linkedRunForBacklogItem(runs, item);
  return run && !isTerminalRunStatus(run.status) ? run : undefined;
}
