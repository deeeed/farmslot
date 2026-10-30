import {
  isSettledBlockedRun,
  type Run,
  type RunListResult,
  TERMINAL_RUN_STATUSES,
} from '@farmslot/protocol';
import type { GatewayResourceCache, ResourceQuery } from '@farmslot/protocol/client-cache';

import { readCurrent } from '../shared/read-current.js';

interface RunArchiveSelectionContext {
  cache: GatewayResourceCache;
  queries: readonly ResourceQuery<RunListResult>[];
  isCurrent(): boolean;
  archive(runId: string): Promise<unknown>;
}

/**
 * One explicit selection rereads the shared lists before each archive, but never crosses a
 * connection or owner.
 */
export async function archiveRunSelection(
  ids: readonly string[],
  context: RunArchiveSelectionContext,
): Promise<Map<string, string>> {
  const { cache, queries } = context;
  const failed = new Map<string, string>();
  for (const [index, id] of ids.entries()) {
    try {
      if (!context.isCurrent()) throw new Error('Wait for current runs before acting.');
      // Each archive is a run write, and run writes reread the lists at a paced rate, so the
      // next archive reads them at once, past a write that races the first reply. Refused
      // commands are never replayed.
      await readCurrent(cache, queries);
      if (!context.isCurrent())
        throw new Error('The connection changed. Review the remaining selection.');
      const states = queries.map((query) => cache.read(query));
      if (states.some((state) => state.status !== 'ready')) {
        // The lists are shared, so the rest of the selection would only repeat the same reads.
        for (const rest of ids.slice(index))
          failed.set(rest, 'Wait for current runs before acting.');
        return failed;
      }
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
