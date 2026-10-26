import { Methods } from '@farmslot/protocol';

import type { FixtureClient } from './transport.js';

export class SourceLikeClient {
  constructor(
    private readonly request: FixtureClient['request'],
    private readonly resourceCache?: () => unknown,
  ) {}

  status() {
    if (this.resourceCache) {
      const cache = this.resourceCache();
      if (!cache) throw new Error('Wait for the current cache owner');
      return cache;
    }
    return this.request(Methods.SOURCES_STATUS, {});
  }
}

export function createSourceLikeClient(
  request: FixtureClient['request'],
  resourceCache?: () => unknown,
) {
  return new SourceLikeClient(request, resourceCache);
}

export function commandRequest(remove: boolean): { method: string; params: unknown } {
  if (remove) return { method: Methods.DISPATCH_QUEUE_REMOVE, params: { itemId: 'fixture' } };
  return { method: Methods.BACKLOG_DEQUEUE, params: { itemId: 'fixture' } };
}
