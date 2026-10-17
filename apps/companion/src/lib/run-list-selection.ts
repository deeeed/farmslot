import {
  type FlowType,
  type Run,
  type RunLane,
  type RunListQuery,
  selectRunList,
} from '@farmslot/protocol';

export interface CompanionRunListQuery extends Omit<RunListQuery, 'flow' | 'lane'> {
  flow: FlowType | '';
  lane: RunLane | '';
  sort: 'newest' | 'oldest' | 'duration';
}

/** The Runs tab list: the shared run-list selection in this screen's sort order. */
export function selectCompanionRunList(runs: readonly Run[], query: CompanionRunListQuery): Run[] {
  const result = selectRunList(runs, {
    ...query,
    flow: query.flow || undefined,
    lane: query.lane || undefined,
  });
  if (query.sort === 'oldest') {
    return result.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }
  if (query.sort === 'duration') {
    return result.sort((a, b) => (b.metrics?.durationMs ?? 0) - (a.metrics?.durationMs ?? 0));
  }
  return result;
}
