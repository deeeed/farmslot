import { useCallback, useEffect, useState } from 'react';

import { type BacklogItem, type BacklogListResult, Methods } from '@farmslot/protocol';

import { useConnectionStore } from '../../store/connection';

export type BacklogEditState =
  | { status: 'loading'; item: null; error: null }
  | { status: 'error'; item: null; error: string }
  | { status: 'ready'; item: BacklogItem; error: null };

export function useBacklogEditController(itemId: string | undefined) {
  const client = useConnectionStore((state) => state.client);
  const connectionStatus = useConnectionStore((state) => state.status);
  const [state, setState] = useState<BacklogEditState>({
    status: 'loading',
    item: null,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!itemId) {
      setState({ status: 'error', item: null, error: 'Backlog item id is required.' });
      return;
    }
    if (!client || connectionStatus !== 'connected') {
      setState({
        status: 'error',
        item: null,
        error: 'Connect to the gateway to edit backlog work.',
      });
      return;
    }
    setState({ status: 'loading', item: null, error: null });
    try {
      const result = await client.request<BacklogListResult>(Methods.BACKLOG_LIST, {
        includeArchived: true,
      });
      const item = result.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error(`Backlog item ${itemId} was not found.`);
      setState({ status: 'ready', item, error: null });
    } catch (error) {
      setState({
        status: 'error',
        item: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [client, connectionStatus, itemId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, actions: { refresh } };
}
