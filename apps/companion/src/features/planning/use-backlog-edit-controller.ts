import { useCallback } from 'react';

import type { BacklogItem } from '@farmslot/protocol';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache } from '../../lib/resource-cache';
import { readErrorMessage } from '../../lib/resource-read-status';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { heldConnectionCurrent } from '../../store/held-connection';

import { backlogPlanningQuery } from './planning-resources';

export type BacklogEditState =
  | { status: 'loading'; item: null; error: null }
  | { status: 'error'; item: null; error: string }
  | { status: 'ready'; item: BacklogItem; error: null };

export function useBacklogEditController(itemId: string | undefined) {
  const access = useWorkspaceRenderAccess();
  const observation = useResourceQuery(access === 'farm' ? backlogPlanningQuery : undefined);
  const refresh = useCallback(() => getResourceCache()?.retry(backlogPlanningQuery), []);
  const item = observation.data?.items.find((candidate) => candidate.id === itemId);
  const error = !itemId
    ? 'Backlog item id is required.'
    : (readErrorMessage(observation, heldConnectionCurrent()) ??
      (observation.status === 'ready' && !item ? `Backlog item ${itemId} was not found.` : null));
  const state: BacklogEditState = item
    ? { status: 'ready', item, error: null }
    : error
      ? { status: 'error', item: null, error }
      : { status: 'loading', item: null, error: null };
  return { state, actions: { refresh } };
}
