import { useEffect, useRef } from 'react';

import { connectedRefresh } from '../lib/connected-refresh';

import { useConnectedTransport } from './useConnectedTransport';

/**
 * Run `refresh` when the gateway connects: fresh for each new target (a new `refresh`),
 * and again on every reconnect with the current data kept. `refresh` must be stable
 * (useCallback) and change only when its target does.
 */
export function useConnectedRefresh(
  refresh: (reason: string, reset: boolean) => unknown,
  enabled = true,
): void {
  const connection = useConnectedTransport();
  const lastTarget = useRef<typeof refresh | null>(null);
  useEffect(() => {
    const next = enabled ? connectedRefresh(lastTarget.current, refresh, connection) : null;
    if (!next) return;
    lastTarget.current = refresh;
    void refresh(next.reason, next.reset);
  }, [connection, enabled, refresh]);
}
