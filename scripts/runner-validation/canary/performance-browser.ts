import {
  closeBrowserResourceStores,
  createBrowserSqliteResourceStore,
} from '../../../packages/local-store/src/browser.js';
import {
  createGatewayResourceCache,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  resourceQuery,
  type ResourceReadResult,
} from '../../../packages/protocol/src/client-cache/index.js';
import {
  measureClientRequest,
  PerformanceRecorder,
  utf8ByteLength,
} from '../../../packages/protocol/src/performance/index.js';

async function rpc<T>(method: string, params: unknown): Promise<{ data: T; bytes: number }> {
  const response = await fetch('/performance-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  return { data: JSON.parse(text), bytes: utf8ByteLength(text) };
}
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
async function run(): Promise<void> {
  const snapshots = [];
  for (const side of ['command-center', 'companion'] as const) {
    const metrics = new PerformanceRecorder(side);
    const scope = {
      gatewayUrl: location.origin,
      principalId: 'performance-browser',
      principalGeneration: 0,
    };
    const authority = { roles: [], workspaceAccess: 'farm' as const };
    let storageNotice = '';
    const store = await createBrowserSqliteResourceStore({
      scope,
      onNotice: (notice) => {
        storageNotice = notice;
      },
    });
    if (!store.persistent)
      throw new Error('Nightly cached paint requires persistent SQLite: ' + storageNotice);
    await store.setMetadata({ scope, authority });
    const queries = Array.from({ length: 20 }, (_, i) =>
      resourceQuery<{ run: { id: string } }>('run.get', { runId: `perf-run-${i}` }),
    );
    for (const query of queries) {
      const { data } = await rpc<{ run: { id: string } }>(query.method, query.params);
      await store.putQuery({
        id: query.id,
        data,
        observedAt: Date.now(),
        bytes: utf8ByteLength(JSON.stringify(data)),
      });
    }
    let connected = false;
    let connectionListener: ((connection: ResourceCacheConnection) => void) | undefined;
    const transport: ResourceCacheTransport = {
      getConnection: () => ({
        id: 1,
        connected,
        foreground: true,
        authMode: 'token',
        scope,
        authority,
      }),
      onConnectionChange: (listener) => {
        connectionListener = listener;
        return () => {
          connectionListener = undefined;
        };
      },
      onResourceChanged: () => () => {},
      resynchronize: () => {},
      async request<T>(method, params, _signal, actionClass): Promise<ResourceReadResult<T>> {
        const data = await measureClientRequest(
          metrics,
          method,
          actionClass ?? 'background-refresh',
          async (received) => {
            const response = await rpc<T>(method, params);
            received(response.bytes);
            return response.data;
          },
        );
        return { data };
      },
    };
    await store.close();
    const target = document.querySelector('#cache-result')!;
    for (const [index, query] of queries.entries()) {
      connected = false;
      const cache = createGatewayResourceCache({
        transport,
        performance: metrics,
        openStore: () => createBrowserSqliteResourceStore({ scope }),
      });
      const subscriptions: Array<() => void> = [];
      try {
        subscriptions.push(
          cache.observe(query, (state) => {
            if (state.data) target.textContent = state.data.run.id;
          }),
        );
        const stored = await cache.readStored!(query, false);
        if (stored.data?.run.id !== `perf-run-${index}`)
          throw new Error('Stored identity mismatch');
        await frame();
        subscriptions.push(
          cache.observe(query, (state) => {
            if (state.data) target.textContent = state.data.run.id;
          }),
        );
        await frame();
        connected = true;
        connectionListener?.(transport.getConnection());
        const refreshed = await cache.retry(query);
        if (refreshed.data?.run.id !== `perf-run-${index}`)
          throw new Error('Refresh identity mismatch');
      } finally {
        for (const stop of subscriptions) stop();
        await cache.dispose();
      }
    }
    snapshots.push(metrics.snapshot());
    for (let report = metrics.beginReport(); report; report = metrics.beginReport()) {
      const { data } = await rpc<{ accepted: boolean }>('gateway.performance.report', report);
      if (!data.accepted) throw new Error('Client report refused');
      metrics.acknowledge(report.sequence);
    }
  }
  await closeBrowserResourceStores();
  const response = await fetch('/performance-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshots }),
  });
  if (!response.ok) throw new Error('Could not save browser result');
}
void run().catch(async (error: unknown) => {
  document.body.textContent = String(error);
  await fetch('/performance-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: String(error) }),
  });
});
