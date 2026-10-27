import {
  createMemoryResourceStore,
  type ResourceStore,
  type ResourceStoreScope,
  resourceStoreScopeId,
} from '@farmslot/protocol/client-cache';

import { ResourceStoreWorkerClient } from './worker-client.js';
import type {
  BrowserStoreDiagnostics,
  StoreWorkerPort,
  StoreWorkerResponse,
} from './worker-protocol.js';

export * from './drafts.js';

export interface BrowserResourceStoreOptions {
  scope: ResourceStoreScope;
  databaseName?: string;
  schemaVersion?: number;
  onNotice?: (notice: string) => void;
}

interface MemoryScope {
  scopeId: string;
  clear(): Promise<void>;
}
interface Owner {
  client: ResourceStoreWorkerClient;
  close(): void;
}

const memoryScopes = new Set<MemoryScope>();
let channel: BroadcastChannel | undefined;
let owner: Owner | undefined;
let opening: Promise<Owner | undefined> | undefined;
let fallbackReason: string | undefined;

function surfaceError(error: unknown): void {
  // Cross-tab deletion already sealed local handles. An I/O failure must still remain visible.
  queueMicrotask(() => {
    throw error;
  });
}

function deletionChannel(): BroadcastChannel | undefined {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel('farmslot-resource-store-v1');
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || Reflect.get(message, 'type') !== 'delete-scope')
      return;
    const scopeId = Reflect.get(message, 'scopeId');
    if (typeof scopeId !== 'string') return;
    for (const scope of memoryScopes)
      if (scope.scopeId === scopeId) void scope.clear().catch(surfaceError);
    if (owner) void owner.client.deleteScope(scopeId).catch(surfaceError);
  };
  return channel;
}

function broadcastDeletion(scopeId: string): void {
  for (const scope of memoryScopes)
    if (scope.scopeId === scopeId) void scope.clear().catch(surfaceError);
  deletionChannel()?.postMessage({ type: 'delete-scope', scopeId });
}

function memoryStore(scope: ResourceStoreScope): ResourceStore {
  const memory = createMemoryResourceStore();
  const registration: MemoryScope = {
    scopeId: resourceStoreScopeId(scope),
    clear: () => memory.deleteAll(),
  };
  memoryScopes.add(registration);
  deletionChannel();
  return {
    ...memory,
    get deleted() {
      return memory.deleted;
    },
    deleteAll() {
      if (memory.deleted) return Promise.resolve();
      const deletion = memory.deleteAll();
      broadcastDeletion(registration.scopeId);
      return deletion;
    },
    async close() {
      memoryScopes.delete(registration);
      await memory.close();
    },
  };
}

async function afterFirstPaint(): Promise<void> {
  if (performance.getEntriesByType('paint').length) return;
  await new Promise<void>((resolve) => {
    const observer = new PerformanceObserver((entries) => {
      if (!entries.getEntries().length) return;
      observer.disconnect();
      resolve();
    });
    observer.observe({ type: 'paint', buffered: true });
  });
}

async function acquireOwner(): Promise<Owner | undefined> {
  if (opening) return opening;
  if (!globalThis.isSecureContext || !navigator.storage?.getDirectory || !navigator.locks) {
    fallbackReason = 'Persistent storage requires a secure page with local storage support.';
    return undefined;
  }
  await afterFirstPaint();
  if (opening) return opening;
  // The granted lock remains held until the worker closes; a second tab never opens OPFS.
  opening = new Promise<Owner | undefined>((resolve, reject) => {
    let granted: Owner | undefined;
    void navigator.locks
      .request('farmslot-resource-store-owner-v1', { ifAvailable: true }, (lock) => {
        if (!lock) {
          fallbackReason = 'Another tab owns persistent offline storage.';
          resolve(undefined);
          return;
        }
        let release!: () => void;
        const held = new Promise<void>((done) => {
          release = done;
        });
        performance.mark('farmslot-resource-worker-start');
        const worker = new Worker(new URL('./browser-worker.ts', import.meta.url), {
          type: 'module',
          name: 'farmslot-resource-store',
        });
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          worker.terminate();
          release();
          if (owner === granted) owner = undefined;
          opening = undefined;
        };
        const port: StoreWorkerPort = {
          postMessage: (request) => worker.postMessage(request),
          onMessage(listener) {
            const receive = (event: MessageEvent<StoreWorkerResponse>) => listener(event.data);
            worker.addEventListener('message', receive);
            return () => worker.removeEventListener('message', receive);
          },
          onError(listener) {
            const fail = (event: ErrorEvent) =>
              listener(event.error instanceof Error ? event.error : new Error(event.message));
            worker.addEventListener('error', fail);
            return () => worker.removeEventListener('error', fail);
          },
          terminate: stop,
        };
        const client = new ResourceStoreWorkerClient(port, broadcastDeletion);
        granted = {
          client,
          close: () => {
            client.close();
            stop();
          },
        };
        owner = granted;
        deletionChannel();
        resolve(granted);
        return held;
      })
      .catch((error: unknown) => {
        if (granted) {
          granted.close();
          surfaceError(error);
        } else {
          opening = undefined;
          reject(error);
        }
      });
  });
  return opening;
}

/** One owner tab uses the worker; all fallback stores still participate in scoped deletion. */
export async function createBrowserSqliteResourceStore(
  options: BrowserResourceStoreOptions,
): Promise<ResourceStore> {
  try {
    const acquired = await acquireOwner();
    if (acquired)
      return await acquired.client.open(options.scope, options.databaseName, options.schemaVersion);
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error);
    owner?.close();
  }
  options.onNotice?.('Offline data will not survive a restart in this tab.');
  return memoryStore(options.scope);
}

export async function browserResourceStoreDiagnostics(
  databaseName?: string,
): Promise<BrowserStoreDiagnostics | { storage: 'memory'; reason?: string }> {
  return owner
    ? owner.client.diagnostics(databaseName)
    : { storage: 'memory', reason: fallbackReason };
}

export function closeBrowserResourceStores(): void {
  owner?.close();
}
