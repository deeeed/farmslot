import {
  isSettledBlockedRun,
  type Run,
  type RunListResult,
  TERMINAL_RUN_STATUSES,
} from '@farmslot/protocol';
import type { GatewayResourceCache, ResourceQuery } from '@farmslot/protocol/client-cache';

interface RunArchiveSelectionContext {
  cache: GatewayResourceCache;
  queries: readonly ResourceQuery<RunListResult>[];
  isCurrent(): boolean;
  archive(runId: string): Promise<unknown>;
}

/** A raced reply can stay stale while the shared cache already schedules its next read. */
function waitForCurrentQueries(context: RunArchiveSelectionContext): Promise<void> {
  const { cache, queries } = context;
  if (context.isCurrent() && queries.every((query) => cache.read(query).status === 'ready'))
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stops: Array<() => void> = [];
    let binding = true;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stop of stops) stop();
      if (error) reject(error);
      else resolve();
    };
    // This bounds one explicit batch's wait; it never schedules periodic reads.
    const timer = setTimeout(
      () => finish(new Error('Run updates are still arriving. Review the remaining selection.')),
      30_000,
    );
    const check = () => {
      if (binding || settled) return;
      if (!context.isCurrent())
        return finish(new Error('The connection changed. Review the remaining selection.'));
      const states = queries.map((query) => cache.read(query));
      const failure = states.find((state) => state.error || state.status === 'unsupported');
      if (failure)
        return finish(new Error(failure.error?.message ?? 'Current run reads are unavailable.'));
      if (states.every((state) => state.status === 'ready')) finish();
    };
    for (const query of queries) stops.push(cache.observe(query, check));
    binding = false;
    check();
  });
}

/** One explicit selection may wait for shared reads, but never cross a connection or owner. */
export async function archiveRunSelection(
  ids: readonly string[],
  context: RunArchiveSelectionContext,
): Promise<Map<string, string>> {
  const { cache, queries } = context;
  const startedReady =
    context.isCurrent() && queries.every((query) => cache.read(query).status === 'ready');
  const failed = new Map<string, string>();
  for (const id of ids) {
    try {
      if (!startedReady || !context.isCurrent())
        throw new Error('Wait for current runs before acting.');
      // Join notification-driven observations, including any follow-up read when
      // another write races the first response. Refused commands are never replayed.
      await waitForCurrentQueries(context);
      if (!context.isCurrent())
        throw new Error('The connection changed. Review the remaining selection.');
      const states = queries.map((query) => cache.read(query));
      if (states.some((state) => state.status !== 'ready'))
        throw new Error('Wait for current runs before acting.');
      let run: Run | undefined;
      for (const state of states) {
        const candidate = state.data?.runs.find((row) => row.id === id);
        if (candidate && (!run || candidate.updatedAt >= run.updatedAt)) run = candidate;
      }
      if (!run) throw new Error('The selected run changed. Review the remaining selection.');
      if (!TERMINAL_RUN_STATUSES.includes(run.status) && !isSettledBlockedRun(run)) continue;
      await context.archive(id);
    } catch (error) {
      failed.set(id, error instanceof Error ? error.message : String(error));
    }
  }
  return failed;
}
