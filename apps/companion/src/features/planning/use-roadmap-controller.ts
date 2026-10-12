import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  isUnscopedGlobalRoadmapItem,
  Methods,
  type RoadmapDeliveryFilter,
  type RoadmapDeliveryProjection,
  type RoadmapDeliverySummary,
  roadmapDeliveryView,
  type RoadmapGetResult,
  type RoadmapItem,
  type RoadmapItemStage,
  type RoadmapListResult,
} from '@farmslot/protocol';

import { spacing } from '../../lib/theme';
import { useConnectionStore } from '../../store/connection';
import { useFilterStore } from '../../store/filters';

export type StageFilter = 'all' | RoadmapItemStage;

export function useRoadmapController() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((state) => state.client);
  const connectionStatus = useConnectionStore((state) => state.status);
  const selectedProjects = useFilterStore((state) => state.filters.projects);
  const [items, setItems] = useState<RoadmapItem[]>([]);
  const [delivery, setDelivery] = useState<RoadmapDeliverySummary[]>([]);
  const [stage, setStage] = useState<StageFilter>('all');
  const [deliveryFilter, setDeliveryFilter] = useState<RoadmapDeliveryFilter>('all');
  const [deliveredExpanded, setDeliveredExpanded] = useState(false);
  const [deliveredDetails, setDeliveredDetails] = useState<RoadmapDeliveryProjection[]>([]);
  const [deliveredLoading, setDeliveredLoading] = useState(false);
  const [deliveredError, setDeliveredError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client || connectionStatus !== 'connected') {
      setError('Connect to the gateway to load the roadmap.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.request<RoadmapListResult>(Methods.ROADMAP_LIST, {
        includeArchived: true,
      });
      setItems(result.items);
      setDelivery(result.delivery ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, connectionStatus]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

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

  useEffect(() => {
    let current = true;
    setDeliveredDetails([]);
    setDeliveredError(null);
    setDeliveredLoading(false);
    if (!deliveredExpanded) return;
    if (!client || connectionStatus !== 'connected') {
      setDeliveredError('Connect to the gateway to load delivered PR links.');
      return;
    }
    setDeliveredLoading(true);
    void Promise.all(
      deliveryView.delivered.map((item) =>
        client.request<RoadmapGetResult>(Methods.ROADMAP_GET, { itemId: item.id }),
      ),
    ).then(
      (results) => {
        if (!current) return;
        setDeliveredDetails(
          results.flatMap((result) => (result.delivery ? [result.delivery] : [])),
        );
        setDeliveredLoading(false);
      },
      (loadError: unknown) => {
        if (!current) return;
        setDeliveredError(loadError instanceof Error ? loadError.message : String(loadError));
        setDeliveredLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [client, connectionStatus, deliveredExpanded, deliveryView]);

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
      error,
      loading,
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
