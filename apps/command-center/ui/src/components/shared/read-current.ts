import type { GatewayResourceCache, ResourceQuery } from '@farmslot/protocol/client-cache';

/** A write that lands during a reread leaves it stale; the next try reads past it. */
const READ_CURRENT_TRIES = 3;

/**
 * Action preflight. Run writes reread the run and decision lists at a paced rate, so held data can
 * be stale only because its reread is due. An action rereads its stale queries at once and then
 * checks that they came back current.
 */
export async function readCurrent<T>(
  cache: GatewayResourceCache,
  queries: readonly ResourceQuery<T>[],
): Promise<void> {
  for (let tries = 0; tries < READ_CURRENT_TRIES; tries++) {
    const stale = queries.filter((query) => cache.read(query).status !== 'ready');
    if (!stale.length) return;
    await Promise.all(stale.map((query) => cache.retry(query)));
  }
}
