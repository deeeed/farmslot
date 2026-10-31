import { usePersistentFlag } from '../lib/held-connection';

/**
 * Which connection banner shows. Routine states (connecting, proving the socket, downloading
 * runs) never do. An outage shows once the held connection lapses: its clock runs from the drop
 * through every reconnect attempt, so a gateway that stays unreachable is reported even while
 * the client cycles between connecting and disconnected. A failing sync, or a socket that never
 * proves itself, shows once it has persisted past the same grace.
 */
export function useVisibleConnectionBanner<Banner extends { tone: string }>(
  banner: Banner | null,
  { held, stuck, outage }: { held: boolean; stuck: boolean; outage: Banner },
): Banner | null {
  const stuckPersisting = usePersistentFlag(stuck);
  if (!held) return banner?.tone === 'disconnected' ? banner : outage;
  return stuck && stuckPersisting ? banner : null;
}
