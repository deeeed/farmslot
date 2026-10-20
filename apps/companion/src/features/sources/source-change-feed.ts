import {
  connectSourceChangeFeed,
  createSourceChangeFeed,
  type SourceChangeFeed,
} from '@farmslot/protocol';

import type { GatewayClient } from '../../lib/gateway-client';

const feeds = new WeakMap<GatewayClient, SourceChangeFeed>();

/**
 * Live source status for one gateway client (ADR-069 Amendment 1). The connection
 * store calls this when it creates the client, before resource notices or panels arrive.
 */
export function sourceChangeFeedFor(client: GatewayClient): SourceChangeFeed {
  const existing = feeds.get(client);
  if (existing) return existing;
  const feed = createSourceChangeFeed();
  feeds.set(client, feed);
  connectSourceChangeFeed(feed, client);
  return feed;
}
