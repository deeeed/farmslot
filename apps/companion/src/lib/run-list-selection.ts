import {
  type FlowType,
  productRunsFirst,
  type RunListLaneFilter,
  type RunListQuery,
  type RunListRow,
  selectRunList,
} from '@farmslot/protocol';

export interface CompanionRunListQuery extends Omit<RunListQuery, 'flow' | 'lane'> {
  flow: FlowType | '';
  lane: RunListLaneFilter | '';
  sort: 'newest' | 'oldest' | 'duration';
}

/**
 * The Runs tab list: the shared run-list selection in this screen's sort order, with product runs
 * ahead of eval runs as in Command Center.
 */
export function selectCompanionRunList(
  runs: readonly RunListRow[],
  query: CompanionRunListQuery,
): RunListRow[] {
  const result = selectRunList(runs, {
    ...query,
    flow: query.flow || undefined,
    lane: query.lane || undefined,
  });
  if (query.sort === 'oldest') {
    result.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  } else if (query.sort === 'duration') {
    result.sort((a, b) => (b.metrics?.durationMs ?? 0) - (a.metrics?.durationMs ?? 0));
  }
  return productRunsFirst(result);
}
