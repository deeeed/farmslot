import { useMemo } from 'react';

import type { RunGetResult } from '@farmslot/protocol';
import { canActOn, readRefused, resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { useHeldConnection } from '../../store/held-connection';
import { useRunStore } from '../../store/runs';

/**
 * The run Run Detail renders: run.get's answer, or the run collections' row for that id while
 * run.get can't be acted on (loading, failed, or saved data offline). The row, which the Review
 * list already holds, stands in so a listed run never opens on a skeleton. Over a saved run.get
 * it shows only when it was updated later. A current run.get is never replaced: a run write
 * marks it stale and rereads it, and run.list can land first. A refusal such as RUN_NOT_FOUND
 * drops the row.
 *
 * A row is display data only. run.list leaves large detail out (`runHasTrimmedDetail`), and run
 * actions check run.get's own run (`assertNativeRunReady`), which a row never is; `runActionable`
 * says when run.get's run is the one on screen. `listObservation` dates the row while it shows.
 */
export function useRunDetailRun(runId: string) {
  const runQuery = useMemo(
    () => (runId ? resourceQuery<RunGetResult>('run.get', { runId }) : undefined),
    [runId],
  );
  const runObservation = useResourceQuery(runQuery);
  const connected = useHeldConnection();
  const listedRun = useRunStore((state) => state.runs.find((candidate) => candidate.id === runId));
  const listObservation = useRunStore((state) => state.observation);
  const direct = runObservation.data?.run;
  const runActionable = canActOn(runObservation, connected);
  const row = readRefused(runObservation.error) ? undefined : listedRun;
  const fromList = Boolean(
    row && !runActionable && (!direct || Date.parse(row.updatedAt) > Date.parse(direct.updatedAt)),
  );
  return {
    runQuery,
    runObservation,
    runActionable,
    listObservation,
    fromList,
    run: (fromList ? row : direct) ?? null,
  };
}
