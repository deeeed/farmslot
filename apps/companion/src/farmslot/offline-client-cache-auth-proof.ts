import { type CredentialIssueResult, Methods, type SourcesStatusResult } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  createResourceCacheTransport,
  resourceQuery,
} from '@farmslot/protocol/client-cache';

import { GatewayClient } from '../lib/gateway-client';

/** Revoke a disposable credential through the real gateway; keep its secret inside native memory. */
export async function proveOfflineCacheCredentialRefusal(
  admin: GatewayClient,
  gatewayUrl: string,
  mode: 'credential-refusal' | 'offline-sign-out' = 'credential-refusal',
) {
  const principalId = admin.authenticatedPrincipal?.id;
  if (!__DEV__ || !principalId) throw new Error('Use a signed-in isolated development stack');
  const issued = await admin.request<CredentialIssueResult>(Methods.CREDENTIAL_ISSUE, {
    principalId,
    displayName: 'Offline cache refusal proof',
  });
  const client = new GatewayClient(gatewayUrl, { token: issued.secret });
  const store = createMemoryResourceStore();
  const query = resourceQuery<SourcesStatusResult>('sources.status');
  const cache = createGatewayResourceCache({
    store,
    transport: createResourceCacheTransport(client, () => ({
      id: client.connectionGeneration,
      connected: client.connectionState === 'connected',
      gatewayUrl,
      authentication: client.authenticatedConnection,
    })),
  });
  let revoked = false;
  const stop = cache.observe(query, () => {});
  async function until(condition: () => boolean) {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }
  try {
    client.connect();
    if (!(await until(() => cache.read(query).status === 'ready')))
      throw new Error('Disposable native cache did not complete its initial read');
    if (mode === 'offline-sign-out') {
      client.disconnect();
      if (store.deleted)
        throw new Error('A transport disconnect deleted the store before sign-out');
      await client.clearAccountSession();
      client.disconnect();
    } else {
      await admin.request(Methods.CREDENTIAL_REVOKE, { credentialId: issued.credential.id });
      revoked = true;
      client.reconnect();
    }
    await until(() => store.deleted);
    return {
      result:
        store.deleted &&
        cache.read(query).data === undefined &&
        client.resourceConnectionReason ===
          (mode === 'offline-sign-out' ? 'sign-out' : 'credential-refused')
          ? 'PASS'
          : 'FAIL',
      storeDeleted: store.deleted,
      reason: client.resourceConnectionReason ?? 'missing',
    };
  } finally {
    stop();
    await cache.dispose();
    client.disconnect();
    if (!revoked)
      await admin.request(Methods.CREDENTIAL_REVOKE, { credentialId: issued.credential.id });
  }
}
