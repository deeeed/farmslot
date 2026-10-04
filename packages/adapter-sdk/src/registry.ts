import { ADAPTER_SDK_VERSION, type PlatformAdapter } from './types.js';

export interface AdapterRegistry<A extends PlatformAdapter = PlatformAdapter> {
  register(adapter: A): void;
  get(id: string): A;
  has(id: string): boolean;
  // Registration order: whatever the host registers first comes first.
  list(): string[];
}

// Throws when the adapter cannot be registered by any host: a missing id, or an
// SDK version this package does not implement.
function assertAdapterShape(adapter: PlatformAdapter): void {
  if (typeof adapter.id !== 'string' || adapter.id.trim() === '') {
    throw new Error('adapter id must be a non-empty string');
  }
  if (adapter.sdkVersion !== ADAPTER_SDK_VERSION) {
    throw new Error(
      `adapter '${adapter.id}' targets adapter SDK ${String(adapter.sdkVersion)}; this host implements ${ADAPTER_SDK_VERSION}`,
    );
  }
}

/** Type and shape-check a platform adapter where it is written. */
export function defineAdapter<A extends PlatformAdapter>(adapter: A): A {
  assertAdapterShape(adapter);
  return adapter;
}

/** A registry keyed by adapter id. Registering an id twice throws. */
export function createAdapterRegistry<
  A extends PlatformAdapter = PlatformAdapter,
>(): AdapterRegistry<A> {
  const adapters = new Map<string, A>();
  const registry: AdapterRegistry<A> = {
    register(adapter) {
      assertAdapterShape(adapter);
      if (adapters.has(adapter.id))
        throw new Error(`adapter '${adapter.id}' is already registered`);
      adapters.set(adapter.id, adapter);
    },
    get(id) {
      const adapter = adapters.get(id);
      if (!adapter)
        throw new Error(`unknown adapter '${id}' (registered: ${registry.list().join(', ')})`);
      return adapter;
    },
    has: (id) => adapters.has(id),
    list: () => [...adapters.keys()],
  };
  return registry;
}
