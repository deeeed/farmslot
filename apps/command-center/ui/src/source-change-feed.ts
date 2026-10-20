import { connectSourceChangeFeed, createSourceChangeFeed } from '@farmslot/protocol';

import { gateway } from './gateway-client.js';

/** Live source status for the current gateway connection (ADR-069 Amendment 1). */
export const sourceChangeFeed = createSourceChangeFeed();

/** Wired at startup so capability negotiation and notices precede panel reads. */
export function startSourceChangeFeed(): void {
  connectSourceChangeFeed(sourceChangeFeed, gateway);
}
