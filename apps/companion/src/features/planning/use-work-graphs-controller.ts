import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache } from '../../lib/resource-cache';
import { spacing } from '../../lib/theme';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { useConnectionStore } from '../../store/connection';
import { useFilterStore } from '../../store/filters';

import { workGraphsPlanningQuery } from './planning-resources';

export function useWorkGraphsController() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const access = useWorkspaceRenderAccess();
  const connected = useConnectionStore((state) => state.status === 'connected');
  const projects = useFilterStore((state) => state.filters.projects);
  const observation = useResourceQuery(access === 'farm' ? workGraphsPlanningQuery : undefined);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const graphs = useMemo(
    () =>
      (observation.data?.graphs ?? []).filter(
        ({ graph }) => projects.length === 0 || projects.includes(graph.project),
      ),
    [observation.data, projects],
  );
  const canRetry = connected && access === 'farm';
  return {
    state: {
      observation,
      graphs,
      selectedGraphId,
      canRetry,
      canRead: access === 'farm',
      bottomPadding: insets.bottom + spacing.xl,
    },
    actions: {
      back: () => (router.canGoBack() ? router.back() : router.replace('/backlog')),
      selectGraph: (id: string) => setSelectedGraphId((current) => (current === id ? null : id)),
      retry: () => (canRetry ? getResourceCache()?.retry(workGraphsPlanningQuery) : undefined),
    },
  };
}
