import { useMemo } from 'react';

import type { RunGetResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { useRunStore } from '../../store/runs';

/**
 * The run Run Detail renders. run.get's answer when it has one; until then the run collections'
 * row, which the Review list already holds, so a listed run never opens on a skeleton while the
 * saved run.get hydrates or the gateway answers. The row is display data only: every action
 * still checks `runObservation` (see assertNativeRunReady), which the row never satisfies.
 */
export function useRunDetailRun(runId: string) {
  const runQuery = useMemo(
    () => (runId ? resourceQuery<RunGetResult>('run.get', { runId }) : undefined),
    [runId],
  );
  const runObservation = useResourceQuery(runQuery);
  const listedRun = useRunStore((state) => state.runs.find((candidate) => candidate.id === runId));
  return { runQuery, runObservation, run: runObservation.data?.run ?? listedRun ?? null };
}
