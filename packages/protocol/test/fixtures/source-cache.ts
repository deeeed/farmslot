import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  type ResourceStore,
} from '../../src/client-cache/index.js';
import { Methods } from '../../src/rpc/registry.js';
import { createSourceCommandClient, type SourceRpcRequest } from '../../src/sources/client.js';
import type { ResourceChangedPayload } from '../../src/transport/events.js';

/** Stamped reads and connection/event delivery around a test's domain request handler. */
export function sourceCacheFixture(
  request: SourceRpcRequest,
  store: ResourceStore = createMemoryResourceStore(),
) {
  const connections = new Set<(connection: ResourceCacheConnection) => void>();
  const changes = new Set<(change: ResourceChangedPayload) => void>();
  let revision = 0;
  let epoch = 'source-test';
  let reads = 0;
  let commands = 0;
  let connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: {
      gatewayUrl: 'ws://source-test.invalid/',
      principalId: 'admin',
      principalGeneration: 0,
    },
    authority: { roles: [{ role: 'admin', scope: { kind: 'global' } }], workspaceAccess: 'farm' },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      resourceChanges: { version: 1, epoch, versionLists: false },
    },
  };
  const transport: ResourceCacheTransport = {
    getConnection: () => connection,
    onConnectionChange(listener) {
      connections.add(listener);
      return () => {
        connections.delete(listener);
      };
    },
    onResourceChanged(listener) {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    async request<T>(method, params, signal) {
      reads++;
      const resourceState = {
        epoch,
        dependencies: [{ key: { family: 'sources' as const, scope: 'farm' as const }, revision }],
      };
      const data = await request<T>(method, params);
      if (signal.aborted) throw Object.assign(new Error('Read cancelled'), { code: 'CANCELLED' });
      return { data, resourceState };
    },
    resynchronize() {
      setConnected(false);
      setConnected(true);
    },
  };
  function setConnected(connected: boolean) {
    connection = { ...connection, id: Number(connection.id) + 1, connected };
    for (const listener of connections) listener(connection);
  }
  const cache = createGatewayResourceCache({ transport, store });
  const client = createSourceCommandClient(
    async <T>(method: string, params: unknown): Promise<T> => {
      if (method !== Methods.SOURCES_STATUS) commands++;
      return request<T>(method, params);
    },
    () => cache,
  );
  return {
    cache,
    client,
    store,
    get reads() {
      return reads;
    },
    get commands() {
      return commands;
    },
    connection: () => connection,
    disconnect() {
      setConnected(false);
    },
    reconnect(nextEpoch = epoch) {
      epoch = nextEpoch;
      connection = {
        ...connection,
        capabilities: {
          ...connection.capabilities!,
          resourceChanges: { version: 1, epoch, versionLists: false },
        },
      };
      setConnected(true);
    },
    unsupported() {
      connection = { ...connection, capabilities: undefined };
      setConnected(true);
    },
    publish(nextRevision = revision + 1) {
      revision = Math.max(revision, nextRevision);
      const payload: ResourceChangedPayload = {
        version: 1,
        epoch,
        changes: [
          { key: { family: 'sources', scope: 'farm' }, revision: nextRevision, kind: 'updated' },
        ],
      };
      for (const listener of changes) listener(payload);
    },
  };
}
