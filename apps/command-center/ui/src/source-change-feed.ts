import { createSourceChangeFeed, Events } from '@farmslot/protocol';

import { gateway } from './gateway-client.js';

/** Live source status for the current gateway connection (ADR-069 Amendment 1). */
export const sourceChangeFeed = createSourceChangeFeed();

/** Wired at startup so the connection's `hello` is seen before any panel mounts. */
export function connectSourceChangeFeed(): void {
  for (const event of [Events.HELLO, Events.FLEET_UPDATED])
    gateway.subscribe(event, (payload) => sourceChangeFeed.receive(event, payload));
  gateway.onConnectionChange((state) => {
    if (state !== 'connected') sourceChangeFeed.disconnected();
  });
}
