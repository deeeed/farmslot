import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  isUnscopedGlobalRoadmapItem,
  Methods,
  type RoadmapDeliveryFilter,
  type RoadmapDeliverySummary,
  roadmapDeliveryView,
  type RoadmapGetResult,
  type RoadmapItem,
  type RoadmapItemStage,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQueries, useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache } from '../../lib/resource-cache';
import { spacing } from '../../lib/theme';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { useConnectionStore } from '../../store/connection';
import { useFilterStore } from '../../store/filters';

import { roadmapPlanningQuery } from './planning-resources';

export type StageFilter = 'all' | RoadmapItemStage;
const EMPTY_ITEMS: RoadmapItem[] = [];
const EMPTY_DELIVERY: RoadmapDeliverySummary[] = [];

export function useRoadmapController() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const access = useWorkspaceRenderAccess();
  const connected = useConnectionStore(
    (state) => state.status === 'connected' && state.workspaceAccess === 'farm',
  );
  const observation = useResourceQuery(access === 'farm' ? roadmapPlanningQuery : undefined);
  const selectedProjects = useFilterStore((state) => state.filters.projects);
  const items = observation.data?.items ?? EMPTY_ITEMS;
  const delivery = observation.data?.delivery ?? EMPTY_DELIVERY;
  const [stage, setStage] = useState<StageFilter>('all');
  const [deliveryFilter, setDeliveryFilter] = useState<RoadmapDeliveryFilter>('all');
  const [deliveredExpanded, setDeliveredExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const refresh = useCallback(() => {
    if (connected && observation.error) return getResourceCache()?.retry(roadmapPlanningQuery);
  }, [connected, observation.error]);

  const visibleItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items
      .filter(
        (item) =>
          selectedProjects.length === 0 ||
          selectedProjects.includes(item.project) ||
          item.targetProjects?.some((project) => selectedProjects.includes(project)) ||
          isUnscopedGlobalRoadmapItem(item),
      )
      .filter((item) => stage === 'all' || item.stage === stage)
      .filter(
        (item) =>
          !query ||
          item.title.toLowerCase().includes(query) ||
          item.id.toLowerCase().includes(query) ||
          item.tags?.some((tag) => tag.toLowerCase().includes(query)),
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [items, search, selectedProjects, stage]);

  const deliveryView = useMemo(
    () => roadmapDeliveryView(visibleItems, delivery, deliveryFilter),
    [visibleItems, delivery, deliveryFilter],
  );

  const deliveredQueries = useMemo(
    () =>
      deliveredExpanded && access === 'farm'
        ? deliveryView.delivered.map((item) =>
            resourceQuery<RoadmapGetResult>(Methods.ROADMAP_GET, { itemId: item.id }),
          )
        : [],
    [access, deliveredExpanded, deliveryView.delivered],
  );
  const deliveredObservations = useResourceQueries(deliveredQueries);
  const deliveredDetails = deliveredObservations.flatMap((result) =>
    result.data?.delivery ? [result.data.delivery] : [],
  );
  const deliveredLoading = deliveredObservations.some((result) => result.status === 'loading');
  const deliveredError =
    deliveredObservations.find((result) => result.error)?.error?.message ?? null;

  return {
    state: {
      bottomPadding: insets.bottom + spacing.xl,
      delivery,
      deliveryView,
      deliveryFilter,
      deliveredExpanded,
      deliveredDetails,
      deliveredLoading,
      deliveredError,
      observation,
      connected,
      error: observation.error?.message ?? null,
      loading: observation.status === 'loading',
      search,
      stage,
      visibleItems,
    },
    actions: {
      openItem: (itemId: string) =>
        router.push({ pathname: '/roadmap/[id]', params: { id: itemId } }),
      refresh,
      openPr: (url: string) => Linking.openURL(url),
      setDeliveredExpanded,
      setDeliveryFilter: (filter: RoadmapDeliveryFilter) => {
        setDeliveryFilter(filter);
        if (filter === 'delivered') setDeliveredExpanded(true);
      },
      setSearch,
      setStage,
    },
  };
}
