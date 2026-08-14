import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type BacklogItem,
  type BacklogListResult,
  type BacklogSpecGetResult,
  Methods,
} from '@farmslot/protocol';

import { runWorkspacePathnameForStatus } from '../../lib/legacy-run-route';
import { spacing } from '../../lib/theme';
import { useConnectionStore } from '../../store/connection';

export function useBacklogDetailController(itemId: string | undefined) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const client = useConnectionStore((state) => state.client);
  const connectionStatus = useConnectionStore((state) => state.status);
  const [item, setItem] = useState<BacklogItem | null>(null);
  const [spec, setSpec] = useState<BacklogSpecGetResult | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!itemId) {
      setError('Backlog item id is required.');
      return;
    }
    if (!client || connectionStatus !== 'connected') {
      setError('Connect to the gateway to load backlog work.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.request<BacklogListResult>(Methods.BACKLOG_LIST, {
        includeArchived: true,
      });
      const found = result.items.find((candidate) => candidate.id === itemId);
      if (!found) throw new Error(`Backlog item ${itemId} was not found.`);
      setItem(found);
      if (!found.specPath) {
        setSpec(null);
        return;
      }
      try {
        setSpec(await client.request<BacklogSpecGetResult>(Methods.BACKLOG_SPEC_GET, { itemId }));
      } catch (specError) {
        setSpec(null);
        setError(specError instanceof Error ? specError.message : String(specError));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, connectionStatus, itemId]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  return {
    state: {
      bottomPadding: insets.bottom + spacing.xxxl,
      error,
      item,
      loading,
      spec,
      specOpen,
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
