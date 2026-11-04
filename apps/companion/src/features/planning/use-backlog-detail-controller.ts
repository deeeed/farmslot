import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type BacklogSpecGetResult, Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useViewToggle } from '../../components/view-state';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import { runWorkspacePathnameForStatus } from '../../lib/legacy-run-route';
import { getResourceCache } from '../../lib/resource-cache';
import { readErrorMessage } from '../../lib/resource-read-status';
import { spacing } from '../../lib/theme';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { useConnectionStore } from '../../store/connection';
import { heldConnectionCurrent } from '../../store/held-connection';

import { backlogPlanningQuery } from './planning-resources';

export function useBacklogDetailController(itemId: string | undefined) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const connected = useConnectionStore(
    (state) => state.status === 'connected' && state.workspaceAccess === 'farm',
  );
  const access = useWorkspaceRenderAccess();
  const observation = useResourceQuery(access === 'farm' ? backlogPlanningQuery : undefined);
  const item = observation.data?.items.find((candidate) => candidate.id === itemId) ?? null;
  const [specOpen, setSpecOpen] = useViewToggle('backlog-spec');
  const specPath = item?.specPath;
  const specQuery = useMemo(
    () =>
      itemId && specPath
        ? resourceQuery<BacklogSpecGetResult>(Methods.BACKLOG_SPEC_GET, { itemId })
        : undefined,
    [itemId, specPath],
  );
  const specObservation = useResourceQuery(specQuery);
  const spec =
    specObservation.data && specObservation.data.itemId === itemId ? specObservation.data : null;
  const specError = readErrorMessage(specObservation, heldConnectionCurrent());
  const retryBacklog = Boolean(
    observation.error || (itemId && observation.status === 'ready' && !item),
  );
  const error = !itemId
    ? 'Backlog item id is required.'
    : (readErrorMessage(observation, heldConnectionCurrent()) ??
      specError ??
      (observation.status === 'ready' && !item ? `Backlog item ${itemId} was not found.` : null));
  const refresh = useCallback(async () => {
    const cache = getResourceCache();
    if (retryBacklog) await cache?.retry(backlogPlanningQuery);
    if (specQuery) await cache?.retry(specQuery);
  }, [retryBacklog, specQuery]);
  return {
    state: {
      bottomPadding: insets.bottom + spacing.xxxl,
      error,
      item,
      loading: observation.status === 'loading',
      spec,
      specOpen,
      observation,
      connected,
      canRetry: retryBacklog || Boolean(specError),
      ready: connected && observation.status === 'ready',
    },
    actions: {
      closeSpec: () => setSpecOpen(false),
      openEdit: (id: string) => router.push({ pathname: '/backlog/edit/[id]', params: { id } }),
      openRun: (runId: string) =>
        router.push({
          pathname: runWorkspacePathnameForStatus(item?.lastObservedRunStatus),
          params: { runId },
        }),
      openSpec: () => setSpecOpen(true),
      refresh,
    },
  };
}
