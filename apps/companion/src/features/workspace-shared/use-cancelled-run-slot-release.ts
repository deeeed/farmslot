import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import {
  type CancelledRunSlotHold,
  releaseCancelledRunSlot,
  type SlotReleaseResult,
} from '@farmslot/protocol';

import { currentFarmConnection } from '../../lib/connection-authority';
import { useConnectionStore } from '../../store/connection';

/** Releases a cancelled run's kept slot once the operator confirms (ADR-054, 2026-10-19). */
export function useCancelledRunSlotRelease(hold: CancelledRunSlotHold) {
  const client = useConnectionStore((state) => state.client);
  const connected = useConnectionStore((state) => state.status === 'connected');
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const release = useCallback(async () => {
    if (!client) return;
    const isCurrent = currentFarmConnection(client);
    setReleasing(true);
    setError(null);
    try {
      const refusal = await releaseCancelledRunSlot(
        (method, params, timeoutMs) => client.request<SlotReleaseResult>(method, params, timeoutMs),
        hold,
      );
      if (isCurrent()) setError(refusal);
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReleasing(false);
    }
  }, [client, hold]);

  const confirmRelease = useCallback(() => {
    Alert.alert(`${hold.releaseLabel}?`, hold.releaseConfirm, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Release', style: 'destructive', onPress: () => void release() },
    ]);
  }, [hold, release]);

  return { confirmRelease, releasing, error, disabled: !client || !connected || releasing };
}
