import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type CopilotRuntimeSession,
  type CopilotRuntimeUpdatedPayload,
  type CopilotStatusResult,
  Events,
  Methods,
} from '@farmslot/protocol';

import { useConnectionStore } from '../../store/connection';

export function useCopilotController() {
  const client = useConnectionStore((state) => state.client);
  const connectionStatus = useConnectionStore((state) => state.status);
  const [runtime, setRuntime] = useState<CopilotRuntimeSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const attempt = ++revision.current;
    if (!client || connectionStatus !== 'connected') return;
    setLoading(true);
    setError('');
    try {
      const result = await client.request<CopilotStatusResult>(Methods.COPILOT_STATUS, {}, 10_000);
      if (attempt === revision.current) setRuntime(result.session);
    } catch (cause) {
      if (attempt === revision.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (attempt === revision.current) setLoading(false);
    }
  }, [client, connectionStatus]);
  useEffect(() => {
    setRuntime(null);
    void refresh();
    return () => {
      revision.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (!client) return;
    return client.subscribe(Events.COPILOT_RUNTIME_UPDATED, (payload) => {
      setRuntime((payload as CopilotRuntimeUpdatedPayload).session);
    });
  }, [client]);
  return {
    viewModel: { runtime, loading, error, connected: connectionStatus === 'connected' },
    actions: { refresh },
  };
}
