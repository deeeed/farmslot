import { createSourceChangeFeed, Events, type SourceChangeFeed } from '@farmslot/protocol';

import type { GatewayClient } from '../../lib/gateway-client';

const feeds = new WeakMap<GatewayClient, SourceChangeFeed>();

/**
 * Live source status for one gateway client (ADR-069 Amendment 1). The connection
 * store calls this when it creates the client, so `hello` is seen before panels mount.
 */
export function sourceChangeFeedFor(client: GatewayClient): SourceChangeFeed {
  const existing = feeds.get(client);
  if (existing) return existing;
  const feed = createSourceChangeFeed();
  feeds.set(client, feed);
  for (const event of [Events.HELLO, Events.FLEET_UPDATED])
    client.subscribe(event, (payload) => feed.receive(event, payload));
  client.onConnectionChange((state) => {
    if (state !== 'connected') feed.disconnected();
  });
  return feed;
}
