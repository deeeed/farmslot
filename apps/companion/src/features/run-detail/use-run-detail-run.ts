import { useMemo } from 'react';

import type { RunGetResult } from '@farmslot/protocol';
import { readRefused, resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { useRunStore } from '../../store/runs';

/**
 * The run Run Detail renders: run.get's answer or the run collections' row for that id,
 * whichever was updated later. The row, which the Review list already holds, stands in while
 * run.get loads or fails on the network, so a listed run never opens on a skeleton; a refusal
 * such as RUN_NOT_FOUND drops it. A row is display data only. run.list leaves large detail out
 * (`runHasTrimmedDetail`), and run actions check run.get's own run (`assertNativeRunReady`),
 * which a row never is. `listObservation` dates the row while it is on screen.
 */
export function useRunDetailRun(runId: string) {
  const runQuery = useMemo(
    () => (runId ? resourceQuery<RunGetResult>('run.get', { runId }) : undefined),
    [runId],
  );
  const runObservation = useResourceQuery(runQuery);
  const listedRun = useRunStore((state) => state.runs.find((candidate) => candidate.id === runId));
  const listObservation = useRunStore((state) => state.observation);
  const direct = runObservation.data?.run;
  const row = readRefused(runObservation.error) ? undefined : listedRun;
  const fromList = Boolean(
    row && (!direct || Date.parse(row.updatedAt) > Date.parse(direct.updatedAt)),
  );
  return {
    runQuery,
    runObservation,
    listObservation,
    fromList,
    run: (fromList ? row : direct) ?? null,
  };
}
