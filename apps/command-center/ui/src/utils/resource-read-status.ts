import type { ResourceQueryError, ResourceQueryState } from '@farmslot/protocol/client-cache';

import type { ResourceQueryController } from '../components/shared/resource-query-controller.js';

/** How long reads may keep being superseded before the held data counts as saved. */
const SUPERSEDED_READ_GRACE_MS = 60_000;

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
  now = Date.now(),
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
 * Nothing held, and reads have kept failing (superseded or not) for the grace period. The cache
 * clears a cold entry's error while it rereads, so this counts from the query's first failure.
 */
export function readKeepsFailing<T>(query: ResourceQueryController<T>, now = Date.now()): boolean {
  return (
    query.state.data === undefined &&
    query.failingSince !== undefined &&
    now - query.failingSince >= SUPERSEDED_READ_GRACE_MS
  );
}

/**
 * The read failure a panel names. A superseded read already has its reread scheduled, so it is not
 * named; held data shows as saved once the grace period passes, and with nothing held the panel
 * says it was never read.
 */
export function readFailureText<T>(
  query: ResourceQueryController<T>,
  now = Date.now(),
): string | undefined {
  const error = query.state.error;
  if (error && !isSupersededRead(error)) return error.message;
  return readKeepsFailing(query, now) ? 'not read yet' : undefined;
}
