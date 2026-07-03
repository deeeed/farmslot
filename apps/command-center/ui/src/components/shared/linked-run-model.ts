import type { BacklogItem, Run } from '@farmslot/protocol';
import { isTerminalRunStatus } from '@farmslot/protocol';

export function linkedRunForBacklogItem(runs: Run[], item: BacklogItem): Run | undefined {
  const matches = runs.filter(
    (run) => run.backlogItemId === item.id || (item.runId && run.id === item.runId),
  );
  const newestFirst = [...matches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return newestFirst.find((run) => !isTerminalRunStatus(run.status)) ?? newestFirst[0];
}
