import type { ConnectionHealthState } from '../lib/connection-liveness';
import { usePersistentFlag } from '../lib/held-connection';

export interface BannerContent {
  title: string;
  tone: 'healthy' | 'connecting' | 'syncError' | 'disconnected';
}

/** The banner is the one place a screen hears about the gateway, in a few words. */
export const OUTAGE_BANNER: BannerContent = { title: 'Gateway offline', tone: 'disconnected' };

export function resolveBannerContent(
  healthStatus: ConnectionHealthState,
  lastSyncError: string | null,
  runsSyncMessage: string | null,
  gatewayCompatibilityHint: string | null,
  gatewayUrl: string,
): BannerContent {
  if (healthStatus === 'disconnected') return OUTAGE_BANNER;
  if (healthStatus === 'connecting') return { title: 'Connecting…', tone: 'connecting' };
  if (healthStatus === 'socket-up-not-proven')
    return { title: 'Gateway not answering', tone: 'connecting' };
  if (healthStatus === 'degraded') return { title: 'Gateway not answering', tone: 'syncError' };
  if (runsSyncMessage) return { title: runsSyncMessage, tone: 'connecting' };
  if (lastSyncError) return { title: 'Sync failed', tone: 'syncError' };
  if (gatewayCompatibilityHint) return { title: 'Gateway outdated', tone: 'syncError' };
  return { title: `Healthy · ${gatewayUrl}`, tone: 'healthy' };
}

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
