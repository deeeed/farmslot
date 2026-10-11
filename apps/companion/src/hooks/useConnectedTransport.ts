import { useConnectionStore } from '../store/connection';

/**
 * The generation of the connected gateway transport, null while it is not
 * connected. Requests pause while the app is backgrounded and broadcasts sent
 * while disconnected never replay, so a screen holding its own copy of gateway
 * state re-reads it whenever this changes to a new number.
 */
export function useConnectedTransport(): number | null {
  return useConnectionStore((s) =>
    s.status === 'connected' ? (s.client?.connectionGeneration ?? null) : null,
  );
}
