import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type BacklogSpecGetResult, Methods } from '@farmslot/protocol';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { currentFarmConnection } from '../../lib/connection-authority';
import { runWorkspacePathnameForStatus } from '../../lib/legacy-run-route';
import { getResourceCache } from '../../lib/resource-cache';
import { readErrorMessage } from '../../lib/resource-read-status';
import { spacing } from '../../lib/theme';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { useConnectionStore } from '../../store/connection';
import { heldConnectionCurrent } from '../../store/held-connection';

import { backlogPlanningQuery } from './planning-resources';

interface SpecPreview {
  itemId: string;
  path: string;
  authorityEpoch: number;
  result: BacklogSpecGetResult | null;
  error: string | null;
}

export function useBacklogDetailController(itemId: string | undefined) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const client = useConnectionStore((state) => state.client);
  const connected = useConnectionStore(
    (state) => state.status === 'connected' && state.workspaceAccess === 'farm',
  );
  const authorityEpoch = useConnectionStore((state) => state.authorityEpoch);
  const access = useWorkspaceRenderAccess();
  const observation = useResourceQuery(access === 'farm' ? backlogPlanningQuery : undefined);
  const item = observation.data?.items.find((candidate) => candidate.id === itemId) ?? null;
  const [preview, setPreview] = useState<SpecPreview | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const [specRetry, setSpecRetry] = useState(0);
  const specPath = item?.specPath;
  const matching =
    preview !== null &&
    preview.itemId === itemId &&
    preview.path === specPath &&
    preview.authorityEpoch === authorityEpoch;
  const spec = matching ? preview.result : null;
  const specError = matching ? preview.error : null;
  const retryBacklog = Boolean(
    observation.error || (itemId && observation.status === 'ready' && !item),
  );
  const error = !itemId
    ? 'Backlog item id is required.'
    : (readErrorMessage(observation, heldConnectionCurrent()) ??
      specError ??
      (observation.status === 'ready' && !item ? `Backlog item ${itemId} was not found.` : null));
  useEffect(() => {
    setSpecOpen(false);
  }, [itemId, authorityEpoch]);
  useEffect(() => {
    if (!client || !connected || !itemId || !specPath) return;
    let active = true;
    const current = currentFarmConnection(client, useConnectionStore.getState);
    // Spec content remains an explicit nonpersisted preview until the content-cache slice.
    void client.request<BacklogSpecGetResult>(Methods.BACKLOG_SPEC_GET, { itemId }).then(
      (result) => {
        if (active && current())
          setPreview({ itemId, path: specPath, authorityEpoch, result, error: null });
      },
      (failure: unknown) => {
        if (!active || !current()) return;
        setPreview((previous) => ({
          itemId,
          path: specPath,
          authorityEpoch,
          result:
            previous?.itemId === itemId &&
            previous.path === specPath &&
            previous.authorityEpoch === authorityEpoch
              ? previous.result
              : null,
          error: failure instanceof Error ? failure.message : String(failure),
        }));
      },
    );
    return () => {
      active = false;
    };
  }, [client, connected, itemId, specPath, authorityEpoch, specRetry]);
  const refresh = useCallback(async () => {
    if (!connected) return;
    if (retryBacklog) await getResourceCache()?.retry(backlogPlanningQuery);
    if (specError) setSpecRetry((value) => value + 1);
  }, [connected, retryBacklog, specError]);
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
