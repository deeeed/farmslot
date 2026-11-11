import { useMemo } from 'react';

import type { RunGetResult } from '@farmslot/protocol';
import { canActOn, readRefused, resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { heldDataUsable } from '../../lib/resource-read-status';
import { useHeldConnection } from '../../store/held-connection';
import { useRunStore } from '../../store/runs';

/**
 * The two things Run Detail needs separated:
 * - `row`: the run-list row for header, status, pipeline and anything a RunListRow has. Present
 *   as soon as the run appears in the list, regardless of whether run.get has loaded. Never
 *   null while the run is listed and not refused.
 * - `run`: the detail from run.get only, never a list row. Null while run.get has not yet
 *   returned data (loading or refused). Set as soon as data exists — including stale cached
 *   data — so detail-only fields (prPackage, artifactManifest, full decision payloads) are
 *   available even offline. Use `runActionable` to guard write actions; use `fromList` to
 *   know whether the row is a more up-to-date source for status/header display.
 *
 * The old `fromList` flag is preserved for callers that need to know the detail is not yet held.
 * The brief: "Where a screen needs a detail-only field to render correctly, it waits for the
 * detail." Nothing already on screen disappears; the row keeps the header live.
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
  return {
    runQuery,
    runObservation,
    runActionable,
    listObservation,
    fromList,
    row,
    run: direct ?? null,
  };
}
