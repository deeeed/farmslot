import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Methods, type RoadmapGetResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache } from '../../lib/resource-cache';
import { spacing } from '../../lib/theme';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';

import { roadmapPlanningQuery } from './planning-resources';

export function useRoadmapDetailController(itemId: string | undefined) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const access = useWorkspaceRenderAccess();
  const query = useMemo(
    () =>
      access === 'farm' && itemId
        ? resourceQuery<RoadmapGetResult>(Methods.ROADMAP_GET, { itemId })
        : undefined,
    [access, itemId],
  );
  const detail = useResourceQuery(query);
  const collection = useResourceQuery(access === 'farm' ? roadmapPlanningQuery : undefined);
  const savedItem = collection.data?.items.find((item) => item.id === itemId);
  const result = detail.data ?? (savedItem ? { item: savedItem } : null);
  const observation = detail.data ? detail : collection;
  const [documentOpen, setDocumentOpen] = useState(false);
  const refresh = useCallback(
    () => (query ? getResourceCache()?.retry(query) : undefined),
    [query],
  );
  const error = !itemId
    ? 'Roadmap item id is required.'
    : (detail.error?.message ??
      collection.error?.message ??
      (collection.status === 'ready' && !result ? `Roadmap item ${itemId} was not found.` : null));
  return {
    state: {
      bottomPadding: insets.bottom + spacing.xxxl,
      documentOpen,
      error,
      result,
      observation,
    },
    actions: {
      closeDocument: () => setDocumentOpen(false),
      openBacklogItem: (backlogItemId: string) =>
        router.push({ pathname: '/backlog/[id]', params: { id: backlogItemId } }),
      openDocument: () => setDocumentOpen(true),
      openPr: (url: string) => Linking.openURL(url),
      refresh,
    },
  };
}
