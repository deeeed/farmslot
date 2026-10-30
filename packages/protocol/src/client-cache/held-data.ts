import type { ResourceQueryError, ResourceQueryState } from './types.js';

/** How long reads may keep being superseded before the held data counts as saved. */
export const SUPERSEDED_READ_GRACE_MS = 60_000;

/**
 * The gateway refuses a read whose source changed while it ran. It has already published that
 * change, so the next read is scheduled: the held data is outdated, not unreadable.
 */
export function isSupersededRead(error: ResourceQueryError | undefined): boolean {
  return error?.code === 'RESOURCE_OBSERVATION_CHANGED';
}

/**
 * Held data stays saved while disconnected, after a failed read, or while the gateway's own source
 * check is not current. A reread in flight also marks it stale, but only for that read, so a notice
 * shown then would come and go with every change. A superseded read counts once it keeps happening.
 */
export function heldDataIsSaved(
  state: ResourceQueryState<unknown>,
  connected: boolean,
  now: number,
): boolean {
  return (
    state.status === 'stale' &&
    state.data !== undefined &&
    (!connected ||
      (state.error !== undefined &&
        (!isSupersededRead(state.error) ||
          now - (state.observedAt ?? 0) >= SUPERSEDED_READ_GRACE_MS)) ||
      (state.sourceObservation !== undefined && state.sourceObservation.status !== 'ready'))
  );
}

/**
 * Held data an action may start from: current, or stale only while its paced reread is due. The
 * action rereads it first (readCurrent); saved data never qualifies.
 */
export function canActOn(
  state: ResourceQueryState<unknown>,
  connected: boolean,
  now: number,
): boolean {
  return (
    connected &&
    state.data !== undefined &&
    (state.status === 'ready' ||
      (state.status === 'stale' && !heldDataIsSaved(state, connected, now)))
  );
}
