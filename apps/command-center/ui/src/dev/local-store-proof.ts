import {
  browserResourceStoreDiagnostics,
  createBrowserSqliteResourceStore,
} from '@farmslot/local-store/browser';
import {
  type ResourceStore,
  type ResourceStoreScope,
  runResourceStoreConformance,
} from '@farmslot/protocol/client-cache';

interface DevelopmentImportMeta extends ImportMeta {
  env: { DEV: boolean };
}

const scope: ResourceStoreScope = {
  gatewayUrl: 'ws://local-store-proof.invalid/',
  principalId: 'storage-proof',
  principalGeneration: 0,
};
let store: ResourceStore | undefined;
const queryId = 'local-store-reload-proof';

/** Exercises the production storage adapter without changing panel data or authentication. */
export async function localStoreProof(
  action: 'conformance' | 'seed' | 'read' | 'delete' | 'late-write',
) {
  if (!(import.meta as DevelopmentImportMeta).env.DEV)
    throw new Error('The resource store proof is development-only');
  if (action === 'conformance') {
    const passed = await runResourceStoreConformance((nextScope) =>
      createBrowserSqliteResourceStore({ scope: nextScope, databaseName: '/conformance.sqlite' }),
    );
    return {
      checks: passed.length,
      diagnostics: await browserResourceStoreDiagnostics('/conformance.sqlite'),
    };
  }
  store ??= await createBrowserSqliteResourceStore({ scope });
  if (action === 'seed') {
    const data = { marker: crypto.randomUUID() };
    await store.putQuery({
      id: queryId,
      data,
      observedAt: Date.now(),
      bytes: JSON.stringify(data).length,
    });
  } else if (action === 'delete') {
    await store.deleteAll();
  }
  if (action === 'delete' || action === 'late-write') {
    // An already deleted handle must not repopulate the database with a late result.
    await store.putQuery({
      id: queryId,
      data: { marker: 'late-write' },
      observedAt: Date.now(),
      bytes: 23,
    });
  }
  return {
    persistent: store.persistent,
    deleted: store.deleted,
    entry: await store.getQuery(queryId),
  };
}
