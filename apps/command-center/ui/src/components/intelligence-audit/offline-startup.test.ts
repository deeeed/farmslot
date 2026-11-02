import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { LitElement } from 'lit';

import { type IntelligenceActionsSummary, Methods } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../../../../../packages/protocol/src/client-cache/conformance.js';

mock.module('./assessment-panel.js', { namedExports: {} });
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      connectionState: 'disconnected',
      onConnectionChange: () => () => undefined,
    },
  },
});
mock.module('../../state.js', {
  namedExports: {
    getState: () => ({ violations: [] }),
    subscribe: () => () => undefined,
  },
});
let current: ReturnType<typeof createGatewayResourceCache> | undefined;
mock.module('../../resource-cache.js', { namedExports: { getResourceCache: () => current } });
Object.assign(globalThis, {
  window: { addEventListener() {}, removeEventListener() {}, location: { hash: '' } },
  location: { hash: '' },
});
const { IntelligenceAuditPanel } = await import('./intelligence-audit-panel.js');
const { IntelligenceIncidentsPanel } = await import('./intelligence-incidents-panel.js');

for (const Panel of [IntelligenceAuditPanel, IntelligenceIncidentsPanel]) {
  test(`${Panel.name} loads saved summaries when first mounted offline`, async () => {
    const scope = {
      gatewayUrl: 'ws://offline.invalid',
      principalId: 'owner',
      principalGeneration: 0,
    };
    const authority = { roles: [], workspaceAccess: 'farm' as const };
    const store = createMemoryResourceStore();
    await store.setMetadata({ scope, authority });
    const query = resourceQuery(Methods.INTELLIGENCE_ACTIONS_SUMMARY, { limit: 100 });
    const summary: IntelligenceActionsSummary = {
      total: 7,
      byActor: {},
      byOutcome: {},
      records: [],
      metadata: { parseFailures: 0, shapeDriftFailures: 0 },
    };
    await store.putQuery({ id: query.id, data: { summary }, bytes: 150, observedAt: 123 });
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.connection.authority = authority;
    current = createGatewayResourceCache({ transport, store });
    const mounted = mock.method(LitElement.prototype, 'connectedCallback', () => undefined);
    const unmounted = mock.method(LitElement.prototype, 'disconnectedCallback', () => undefined);
    const panel = new Panel();
    const load = panel.load.bind(panel);
    let initialLoad: Promise<void> | undefined;
    const loading = mock.method(panel, 'load', () => {
      initialLoad = load();
      return initialLoad;
    });
    try {
      panel.connectedCallback();
      assert.ok(initialLoad, 'mounting offline must start the real saved read');
      await initialLoad;
      assert.deepEqual(Reflect.get(panel, 'summary'), summary);
      assert.equal(Reflect.get(panel, 'loading'), false);
      assert.equal(transport.requestCount, 0);
    } finally {
      panel.disconnectedCallback();
      mounted.mock.restore();
      unmounted.mock.restore();
      loading.mock.restore();
      await current.dispose();
      current = undefined;
    }
  });
}

test('a mounted Intelligence panel replaces saved summary after the online refresh', async () => {
  const scope = {
    gatewayUrl: 'ws://intelligence.invalid',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority });
  const query = resourceQuery(Methods.INTELLIGENCE_ACTIONS_SUMMARY, { limit: 100 });
  const summary: IntelligenceActionsSummary = {
    total: 7,
    byActor: {},
    byOutcome: {},
    records: [],
    metadata: { parseFailures: 0, shapeDriftFailures: 0 },
  };
  await store.putQuery({ id: query.id, data: { summary }, bytes: 150, observedAt: 123 });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  transport.setConnection({ connected: true, id: 1 });
  current = createGatewayResourceCache({ transport, store });
  const panel = new IntelligenceIncidentsPanel();
  try {
    const refreshed = panel.load();
    const pending = await transport.nextRead();
    const deadline = Date.now() + 1000;
    while (Reflect.get(panel, 'summary')?.total !== 7) {
      assert(Date.now() < deadline, 'saved summary did not paint before the pending reply');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(Reflect.get(panel, 'summary').total, 7);
    assert.equal(Reflect.get(panel, 'loading'), false);
    pending.resolve({ summary: { ...summary, total: 8 } });
    await refreshed;
    assert.equal(Reflect.get(panel, 'summary').total, 8);
  } finally {
    await current.dispose();
    current = undefined;
  }
});
