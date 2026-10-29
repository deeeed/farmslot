import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache } from '../../lib/resource-cache';
import { spacing } from '../../lib/theme';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { useConnectionStore } from '../../store/connection';
import { useFilterStore } from '../../store/filters';

import { dispatchQueuePlanningQuery } from './planning-resources';

export function useDispatchQueueController() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const access = useWorkspaceRenderAccess();
  const connected = useConnectionStore((state) => state.status === 'connected');
  const projects = useFilterStore((state) => state.filters.projects);
  const observation = useResourceQuery(access === 'farm' ? dispatchQueuePlanningQuery : undefined);
  const items = useMemo(
    () =>
      (observation.data?.items ?? []).filter(
        (item) => projects.length === 0 || projects.includes(item.project),
      ),
    [observation.data, projects],
  );
  const canRetry = connected && access === 'farm';
  return {
    state: {
      observation,
      items,
      canRetry,
      canRead: access === 'farm',
      bottomPadding: insets.bottom + spacing.xl,
    },
    actions: {
      back: () => (router.canGoBack() ? router.back() : router.replace('/backlog')),
      retry: () => (canRetry ? getResourceCache()?.retry(dispatchQueuePlanningQuery) : undefined),
    },
  };
}
