import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Methods, type RoadmapGetResult } from '@farmslot/protocol';

import { spacing } from '../../lib/theme';
import { useConnectionStore } from '../../store/connection';

export function useRoadmapDetailController(itemId: string | undefined) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const client = useConnectionStore((state) => state.client);
  const connectionStatus = useConnectionStore((state) => state.status);
  const [result, setResult] = useState<RoadmapGetResult | null>(null);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!itemId) {
      setError('Roadmap item id is required.');
      return;
    }
    if (!client || connectionStatus !== 'connected') {
      setError('Connect to the gateway to load roadmap work.');
      return;
    }
    setError(null);
    try {
      setResult(await client.request<RoadmapGetResult>(Methods.ROADMAP_GET, { itemId }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [client, connectionStatus, itemId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    state: { bottomPadding: insets.bottom + spacing.xxxl, documentOpen, error, result },
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
