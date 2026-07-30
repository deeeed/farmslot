import type { BacklogItem, Run } from '@farmslot/protocol';
import { isTerminalRunStatus } from '@farmslot/protocol';

export interface BacklogRunProjectionOptions {
  /** Activity tables may surface legacy out-of-band dispatches by exact ref. */
  allowSourceRefInference?: boolean;
}

function selectLinkedRun(matches: Run[]): Run | undefined {
  const newestFirst = [...matches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return newestFirst.find((run) => !isTerminalRunStatus(run.status)) ?? newestFirst[0];
}

export function linkedRunsForBacklogItems(
  runs: Run[],
  items: readonly BacklogItem[],
  options: BacklogRunProjectionOptions = {},
): Map<string, Run> {
  const byBacklogId = new Map<string, Run[]>();
  const byRunId = new Map(runs.map((run) => [run.id, run]));
  const bySource = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.backlogItemId) {
      const matches = byBacklogId.get(run.backlogItemId) ?? [];
      matches.push(run);
      byBacklogId.set(run.backlogItemId, matches);
    }
    if (options.allowSourceRefInference) {
      const key = `${run.project}\0${run.ticketOrPr}`;
      const matches = bySource.get(key) ?? [];
      matches.push(run);
      bySource.set(key, matches);
    }
  }

  const projection = new Map<string, Run>();
  for (const item of items) {
    const explicitMatches = [...(byBacklogId.get(item.id) ?? [])];
    const legacy = item.runId ? byRunId.get(item.runId) : undefined;
    if (legacy && !explicitMatches.some((run) => run.id === legacy.id))
      explicitMatches.push(legacy);
    const matches =
      explicitMatches.length > 0 || !options.allowSourceRefInference
        ? explicitMatches
        : (bySource.get(`${item.project}\0${item.sourceRef}`) ?? []);
    const selected = selectLinkedRun(matches);
    if (selected) projection.set(item.id, selected);
  }
  return projection;
}

export function linkedRunForBacklogItem(
  runs: Run[],
  item: BacklogItem,
  options: BacklogRunProjectionOptions = {},
): Run | undefined {
  // run.create can intentionally start an item outside the backlog dispatcher.
  // Only activity projections opt into exact project + source-ref inference;
  // detail/history consumers remain anchored to durable linkage.
  return linkedRunsForBacklogItems(runs, [item], options).get(item.id);
}

export function activeLinkedRunForBacklogItem(
  runs: Run[],
  item: BacklogItem,
  options: BacklogRunProjectionOptions = {},
): Run | undefined {
  const run = linkedRunForBacklogItem(runs, item, options);
  return run && !isTerminalRunStatus(run.status) ? run : undefined;
}
