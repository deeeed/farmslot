import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type BacklogItem, type BacklogStatus, Methods } from '@farmslot/protocol';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { runWorkspacePathnameForStatus } from '../../lib/legacy-run-route';
import { getResourceCache } from '../../lib/resource-cache';
import { spacing } from '../../lib/theme';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { useConnectionStore } from '../../store/connection';
import { useFilterStore } from '../../store/filters';

import { backlogPlanningQuery, currentPlanningRead } from './planning-resources';

const STATUS_ORDER: Record<BacklogStatus, number> = {
  ready: 0,
  candidate: 1,
  'needs-attention': 2,
  failed: 3,
  running: 4,
  dispatching: 5,
  queued: 6,
  done: 7,
  archived: 8,
};

export function useBacklogController() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const access = useWorkspaceRenderAccess();
  const connected = useConnectionStore(
    (state) => state.status === 'connected' && state.workspaceAccess === 'farm',
  );
  const selectedProjects = useFilterStore((state) => state.filters.projects);
  const authorityEpoch = useConnectionStore((state) => state.authorityEpoch);
  const observation = useResourceQuery(access === 'farm' ? backlogPlanningQuery : undefined);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<symbol | null>(null);
  useEffect(() => {
    pending.current = null;
    setBusyItemId(null);
    setError(null);
  }, [authorityEpoch]);
  const ready = connected && observation.status === 'ready';
  const visibleItems = useMemo(
    () =>
      (observation.data?.items ?? [])
        .filter((item) => item.status !== 'archived' && item.status !== 'done')
        .filter((item) => selectedProjects.length === 0 || selectedProjects.includes(item.project))
        .sort(
          (left, right) =>
            STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        ),
    [observation.data, selectedProjects],
  );
  const refresh = useCallback(() => {
    if (connected && observation.error) return getResourceCache()?.retry(backlogPlanningQuery);
  }, [connected, observation.error]);
  const runAction = useCallback(
    async (item: BacklogItem, action: 'ready' | 'enqueue') => {
      const ticket = Symbol();
      let current = () => true;
      try {
        const command = currentPlanningRead(backlogPlanningQuery, observation.data);
        current = command.current;
        const candidate = command.data.items.find((row) => row.id === item.id);
        if (!candidate || candidate.status !== item.status)
          throw new Error('This backlog item changed. Wait for the current row.');
        setBusyItemId(item.id);
        pending.current = ticket;
        setError(null);
        await command.client.request(
          action === 'ready' ? Methods.BACKLOG_MARK_READY : Methods.BACKLOG_ENQUEUE,
          { itemId: item.id },
        );
        // Owning writer notifications refresh all observers; never keep a second local row collection.
      } catch (actionError) {
        if (current())
          setError(actionError instanceof Error ? actionError.message : String(actionError));
      } finally {
        if (pending.current === ticket) {
          pending.current = null;
          setBusyItemId(null);
        }
      }
    },
    [observation.data],
  );
  const enqueue = useCallback(
    (item: BacklogItem) => {
      if (!ready) return;
      try {
        const authority = currentPlanningRead(backlogPlanningQuery, observation.data);
        Alert.alert('Launch this job?', `${item.sourceRef || item.title}\n${item.project}`, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Launch',
            onPress: () => {
              if (authority.current()) void runAction(item, 'enqueue');
            },
          },
        ]);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [ready, runAction, observation.data],
  );
  return {
    state: {
      bottomPadding: insets.bottom + spacing.xl,
      visibleItems,
      busyItemId,
      error,
      observation,
      connected,
      ready,
      loading: observation.status === 'loading',
    },
    actions: {
      openWorkGraphs: () => router.push('/work-graphs'),
      openQueue: () => router.push('/dispatch-queue'),
      refresh,
      enqueue,
      markReady: (item: BacklogItem) => runAction(item, 'ready'),
      openCreate: () => {
        if (ready) router.push('/backlog/create');
      },
      openItem: (id: string) => router.push({ pathname: '/backlog/[id]', params: { id } }),
      openRun: (item: BacklogItem) => {
        if (item.runId)
          router.push({
            pathname: runWorkspacePathnameForStatus(item.lastObservedRunStatus),
            params: { runId: item.runId },
          });
      },
    },
  };
}
