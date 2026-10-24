import { type BacklogListResult, Methods, type RoadmapListResult } from '@farmslot/protocol';
import { type ResourceQuery, resourceQuery } from '@farmslot/protocol/client-cache';

import { currentFarmConnection } from '../../lib/connection-authority';
import { getResourceCache, getResourceWorkspaceKey } from '../../lib/resource-cache';
import { useConnectionStore } from '../../store/connection';

export const backlogPlanningQuery = resourceQuery<BacklogListResult>(Methods.BACKLOG_LIST, {
  includeArchived: true,
});
export const roadmapPlanningQuery = resourceQuery<RoadmapListResult>(Methods.ROADMAP_LIST, {
  includeArchived: true,
});

/** Commands capture current authority and data; a rendered saved row cannot authorize a write. */
export function currentPlanningRead<T>(query: ResourceQuery<T>, expected: T | undefined) {
  const { client } = useConnectionStore.getState();
  const cache = getResourceCache();
  const owner = getResourceWorkspaceKey();
  const state = cache?.read(query);
  if (
    !client ||
    !cache ||
    state?.status !== 'ready' ||
    state.data === undefined ||
    state.data !== expected
  )
    throw new Error('Wait for current planning data before acting.');
  const connected = currentFarmConnection(client, useConnectionStore.getState);
  const current = () =>
    connected() && cache === getResourceCache() && owner === getResourceWorkspaceKey();
  if (!current()) throw new Error('Connect to the current planning workspace before acting.');
  return { client, cache, data: state.data, current };
}
