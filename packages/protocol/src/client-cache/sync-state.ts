import type { ResourceQueryState } from './types.js';

export type ResourceSyncState =
  | { status: 'synced' }
  | { status: 'syncing' }
  | { status: 'cached'; observedAt?: number };

/** A socket alone never makes held data current. Every observed read must be verified. */
export function resourceSyncState(
  reads: readonly ResourceQueryState[],
  connected: boolean,
): ResourceSyncState {
  const cached = reads.filter(
    (read) =>
      read.data !== undefined &&
      (!connected ||
        read.error !== undefined ||
        (read.sourceObservation !== undefined && read.sourceObservation.status !== 'ready')),
  );
  if (cached.length) {
    const ages = cached.map((read) => read.sourceObservation?.observedAt ?? read.observedAt);
    const observedAt = ages.every((age): age is number => age !== undefined)
      ? Math.min(...ages)
      : undefined;
    return { status: 'cached', observedAt };
  }
  return {
    status:
      connected &&
      reads.length > 0 &&
      reads.every((read) => read.status === 'ready' && read.data !== undefined)
        ? 'synced'
        : 'syncing',
  };
}

export function resourceSyncLabel(state: ResourceSyncState): string {
  if (state.status === 'synced') return 'Synced';
  if (state.status === 'syncing') return 'Syncing';
  return state.observedAt === undefined
    ? 'Cached data · time unknown'
    : `Cached from ${new Date(state.observedAt).toLocaleString()}`;
}
