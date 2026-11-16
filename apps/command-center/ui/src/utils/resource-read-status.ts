import {
  isSupersededRead,
  type ResourceQueryState,
  SUPERSEDED_READ_GRACE_MS,
} from '@farmslot/protocol/client-cache';

import type { ResourceQueryController } from '../components/shared/resource-query-controller.js';

export { heldDataIsSaved, isSupersededRead } from '@farmslot/protocol/client-cache';

// UNAVAILABLE is also used for real watch failures. Only these producer admission
// and replacement messages are absence; unknown failures must stay visible.
const pendingObservationMessages = new Set([
  'The local file watches are still arming.',
  'The remote progress watch is not armed.',
  'The progress source owner is not observing this file.',
  'The file observation is no longer active.',
  'The file producer disconnected or was replaced.',
  'The progress producer disconnected, lost authority or was replaced.',
  'Native workspace node disconnected',
  'Workspace node disconnected',
  'Run no longer owns this slot workspace',
  'Workspace identity is no longer current',
  'Workspace source replaced while arming',
]);

/** Observation availability is not a failed read of the underlying file. */
export function isExpectedReadAbsence(
  state: Pick<ResourceQueryState, 'status' | 'error'>,
): boolean {
  const error = state.error;
  if (!error) return state.status === 'unsupported';
  return (
    ['RESOURCE_OBSERVATION_UNSUPPORTED', 'PROGRESS_OWNER_CHANGED'].includes(error.code) ||
    (error.code === 'RESOURCE_OBSERVATION_UNAVAILABLE' &&
      pendingObservationMessages.has(error.message))
  );
}

/**
 * Nothing held, and reads have kept failing (superseded or not) for the grace period. The cache
 * clears a cold entry's error while it rereads, so this counts from the query's first failure.
 */
export function readKeepsFailing<T>(
  query: Pick<ResourceQueryController<T>, 'state' | 'failingSince'>,
  now = Date.now(),
): boolean {
  return (
    !isExpectedReadAbsence(query.state) &&
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
  query: Pick<ResourceQueryController<T>, 'state' | 'failingSince'>,
  now = Date.now(),
): string | undefined {
  if (isExpectedReadAbsence(query.state)) return undefined;
  const error = query.state.error;
  if (error && !isSupersededRead(error)) return error.message;
  return readKeepsFailing(query, now) ? 'not read yet' : undefined;
}
