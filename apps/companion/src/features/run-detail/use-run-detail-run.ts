import { useMemo } from 'react';

import type { RunGetResult } from '@farmslot/protocol';
import { canActOn, readRefused, resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { heldDataUsable } from '../../lib/resource-read-status';
import { useHeldConnection } from '../../store/held-connection';
import { useRunStore } from '../../store/runs';

import { heldDetailWithNewerRow } from './run-detail-reads';

/**
 * What Run Detail screens read for one run:
 * - `row`: the run.list row, present while the run is listed and its run.get was not refused.
 * - `run`: run.get's run, never a list row; null until run.get has data (loading, or nothing
 *   saved). When the row is newer than a held run.get (`fromList`), `run` is the held detail
 *   with the row's own fields laid over it (`heldDetailWithNewerRow`): the header shows the
 *   row's status, and the detail parts keep the held data until the reread lands, so nothing
 *   already on screen goes empty. A run.list row alone never stands in: it lacks the detail
 *   these screens render, so they show their loading state until run.get answers.
 *
 * Display and actions use different rules. `runActionable` (`canActOn`) says when actions may
 * run, which a failed reread already stops, and run actions check run.get's own run
 * (`assertNativeRunReady`), which an overlaid run is not. A failed reread stays quiet only while
 * the last good read is under 60 s old (`heldDataUsable`); after that a newer row's facts show.
 * A refusal such as RUN_NOT_FOUND drops the row. `listObservation` dates the row.
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
  const now = Date.now();
  const runActionable = canActOn(runObservation, connected, now);
  const directShown = heldDataUsable(runObservation, connected, now);
  const row = (readRefused(runObservation.error) ? undefined : listedRun) ?? null;
  const fromList = Boolean(
    row && !directShown && (!direct || Date.parse(row.updatedAt) > Date.parse(direct.updatedAt)),
  );
  const run = useMemo(
    () => (direct && row && fromList ? heldDetailWithNewerRow(direct, row) : (direct ?? null)),
    [direct, row, fromList],
  );
  return { runQuery, runObservation, runActionable, listObservation, fromList, row, run };
}
