import { isSupersededRead, SUPERSEDED_READ_GRACE_MS } from '@farmslot/protocol/client-cache';

import type { ResourceQueryController } from '../components/shared/resource-query-controller.js';

export { heldDataIsSaved, isSupersededRead } from '@farmslot/protocol/client-cache';

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
