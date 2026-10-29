import type { FixtureClient } from './transport.js';

export function requestThrough(client: FixtureClient, method: string, params: unknown) {
  return client.request(method, params);
}

export const aliasThrough = requestThrough;

export function indirectRequest(client: FixtureClient, method: string, params: unknown) {
  return aliasThrough(client, method, params);
}

export function requestRecord(
  client: FixtureClient,
  { method, params }: { method: string; params: unknown },
) {
  return client.request(method, params);
}
