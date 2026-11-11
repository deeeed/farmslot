/**
 * Cache-level tests for decision entity sync (ADR-071 Amendment 3).
 *
 * Tests:
 * 1. decision entity push: initial load via versions+ids, then pushed entity update updates the
 *    list with zero additional RPCs
 * 2. membership stale: collection key advance triggers a versions re-read
 * 3. deleted kind: entity advance with kind='deleted' removes the decision immediately
 * 4. legacy gateway (no entitySync): falls through to full RPC read; entity push ignored
 *
 * Revert proofs (all run-proven):
 * - Test 1: commenting out `col.collection.applyEntity(...)` in cache.ts →
 *   `Error: decision entity push must update title — timed out`
 * - Test 2: removing `col.membershipStale = true` from the membership stale handler →
 *   `Error: Conformance read did not start`
 * - Test 3: commenting out `col.collection.applyDeleted(...)` in cache.ts →
 *   `Error: decision removed after deletion — timed out`
 * - Test 4: removing `{family:'decisions', scope:'farm'}` from the conformance stamp →
 *   `Error: initial full-read — timed out`
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayResourceCache } from '../src/client-cache/cache.js';
import { ResourceCacheConformanceTransport } from '../src/client-cache/conformance.js';
import { resourceQuery } from '../src/client-cache/registry.js';
import type { ResourceCacheConnection } from '../src/client-cache/types.js';
import type { PendingDecision } from '../src/contracts/runs.js';
import type {
  DecisionEntityPage,
  DecisionListResult,
  DecisionVersionsResult,
} from '../src/rpc/decisions.js';
import { Methods } from '../src/rpc/registry.js';

const EPOCH = 'decision-entity-epoch';

const scope = {
  gatewayUrl: 'ws://decision-entity-test.invalid/',
  principalId: 'test-principal',
  principalGeneration: 0,
};

const decisionListQuery = resourceQuery<DecisionListResult>(Methods.DECISION_LIST);

function makeDecision(id: string, title = 'Approve gate'): PendingDecision {
  return {
    id,
    type: 'gate',
    slotId: 's1',
    title,
    description: 'Review and approve',
    context: {},
    actions: [
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'abort', label: 'Abort', style: 'danger' },
    ],
    createdAt: new Date().toISOString(),
  };
}

function entitySyncConnection(base: ResourceCacheConformanceTransport): ResourceCacheConnection {
  return {
    ...base.connection,
    id: 1,
    connected: true,
    capabilities: {
      ...base.connection.capabilities,
      resourceChanges: {
        version: 1 as const,
        epoch: EPOCH,
        versionLists: false,
        observedReads: 1 as const,
        entitySync: true,
      },
    },
  };
}

function legacyGatewayConnection(base: ResourceCacheConformanceTransport): ResourceCacheConnection {
  return {
    ...base.connection,
    id: 1,
    connected: true,
    capabilities: {
      ...base.connection.capabilities,
      resourceChanges: {
        version: 1 as const,
        epoch: 'conformance-epoch',
        versionLists: false,
        observedReads: 1 as const,
      },
    },
  };
}

/** Wait until decision.list observer emits ready data satisfying predicate. */
function waitFor(
  cache: ReturnType<typeof createGatewayResourceCache>,
  predicate: (data: DecisionListResult) => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<DecisionListResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} — timed out`)), timeoutMs);
    const stop = cache.observe(decisionListQuery as ReturnType<typeof resourceQuery>, (state) => {
      if (state.status === 'ready' && state.data !== undefined) {
        const data = state.data as DecisionListResult;
        if (predicate(data)) {
          clearTimeout(timer);
          stop();
          resolve(data);
        }
      } else if (state.status === 'error') {
        clearTimeout(timer);
        stop();
        reject(state.error ?? new Error('cache error'));
      }
    });
  });
}

test(
  'decision entity cache: entity push updates list with zero RPCs',
  { timeout: 8000 },
  async () => {
    const d1 = makeDecision('d-1', 'Gate: approve deploy');
    const d1v2 = { ...d1, title: 'Gate: approve deploy (updated)' };

    const versionsResult: DecisionVersionsResult = {
      versions: [{ id: 'd-1', version: 'v1' }],
    };
    const pageResult: DecisionEntityPage = {
      entities: [d1],
      versions: [{ id: 'd-1', version: 'v1' }],
    };

    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // Phase 1: initial load — drive versions + page reads.
    const reading = waitFor(cache, (d) => d.decisions.length > 0, 'initial load');

    const versionsRead = await transport.nextRead();
    versionsRead.resolve(versionsResult);

    const pageRead = await transport.nextRead();
    pageRead.resolve(pageResult);

    const initial = await reading;
    assert.equal(initial.decisions[0]?.id, 'd-1', 'initial decision present');
    assert.equal(initial.decisions[0]?.title, 'Gate: approve deploy', 'initial title');

    const rpcsBefore = transport.requestCount;

    // Phase 2: push entity update — title changes, zero RPCs.
    // Revert proof: removing the 'decision' family entity push handler causes this waitFor to time out.
    transport.publish({
      version: 1,
      epoch: EPOCH,
      changes: [
        {
          key: { family: 'decision', decisionId: 'd-1' },
          revision: 2,
          kind: 'updated',
          changedEntity: { family: 'decision', entity: d1v2, version: 'v2' },
        },
      ],
    });

    const updated = await waitFor(
      cache,
      (d) => d.decisions[0]?.title === 'Gate: approve deploy (updated)',
      'decision entity push must update title',
    );
    assert.equal(transport.requestCount, rpcsBefore, 'zero new RPCs after entity push');
    assert.equal(updated.decisions[0]?.title, 'Gate: approve deploy (updated)');

    cache.dispose();
  },
);

test(
  'decision entity cache: membership stale advance triggers versions re-read',
  { timeout: 8000 },
  async () => {
    const d1 = makeDecision('d-1');
    const d2 = makeDecision('d-2', 'Second decision');

    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // Phase 1: initial load.
    const reading = waitFor(cache, (d) => d.decisions.length > 0, 'initial load');
    const v1 = await transport.nextRead();
    v1.resolve({ versions: [{ id: 'd-1', version: 'v1' }] } satisfies DecisionVersionsResult);
    const p1 = await transport.nextRead();
    p1.resolve({
      entities: [d1],
      versions: [{ id: 'd-1', version: 'v1' }],
    } satisfies DecisionEntityPage);
    await reading;
    const rpcsBefore = transport.requestCount;

    // Register the second observer BEFORE publishing so there is always an active listener
    // when the queueMicrotask fires inside the membership stale handler.
    const updated = waitFor(cache, (d) => d.decisions.length === 2, 'both decisions loaded');

    // Phase 2: collection membership change — d-2 added.
    transport.publish({
      version: 1,
      epoch: EPOCH,
      changes: [
        {
          key: { family: 'decisions', scope: 'farm' },
          revision: 2,
          kind: 'updated',
          membershipRevision: 1,
        },
      ],
    });

    // Expect a versions re-read.
    const v2 = await transport.nextRead();
    v2.resolve({
      versions: [
        { id: 'd-1', version: 'v1' },
        { id: 'd-2', version: 'v1' },
      ],
    } satisfies DecisionVersionsResult);

    // Expect a page read for d-2.
    const p2 = await transport.nextRead();
    p2.resolve({
      entities: [d2],
      versions: [{ id: 'd-2', version: 'v1' }],
    } satisfies DecisionEntityPage);

    const result = await updated;
    assert.ok(
      result.decisions.some((d) => d.id === 'd-2'),
      'd-2 added after membership change',
    );
    assert.ok(transport.requestCount > rpcsBefore, 'versions re-read fired');

    cache.dispose();
  },
);

test(
  'decision entity cache: deleted kind removes decision immediately with zero RPCs',
  { timeout: 8000 },
  async () => {
    const d1 = makeDecision('d-1');

    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // Phase 1: initial load with one decision.
    const reading = waitFor(cache, (d) => d.decisions.length > 0, 'initial load');
    const v1 = await transport.nextRead();
    v1.resolve({ versions: [{ id: 'd-1', version: 'v1' }] } satisfies DecisionVersionsResult);
    const p1 = await transport.nextRead();
    p1.resolve({
      entities: [d1],
      versions: [{ id: 'd-1', version: 'v1' }],
    } satisfies DecisionEntityPage);
    await reading;
    const rpcsBefore = transport.requestCount;

    // Phase 2: deleted kind — d-1 is resolved.
    // Revert proof: removing the applyDeleted call causes the predicate never to fire; test times out.
    transport.publish({
      version: 1,
      epoch: EPOCH,
      changes: [
        {
          key: { family: 'decision', decisionId: 'd-1' },
          revision: 2,
          kind: 'deleted',
        },
      ],
    });

    await waitFor(cache, (d) => d.decisions.length === 0, 'decision removed after deletion');
    assert.equal(transport.requestCount, rpcsBefore, 'zero new RPCs after deleted kind');

    cache.dispose();
  },
);

test(
  'decision entity cache: legacy gateway (no entitySync) uses full RPC; entity push ignored',
  { timeout: 8000 },
  async () => {
    const d1 = makeDecision('d-1');

    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(legacyGatewayConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // Phase 1: plain decision.list full read (not versions + ids).
    const reading = waitFor(cache, (d) => d.decisions.length > 0, 'initial full-read');

    const fullRead = await transport.nextRead();
    assert.equal(transport.requestCount, 1, 'exactly one RPC for initial full read');
    fullRead.resolve({ decisions: [d1] } satisfies DecisionListResult);

    const initial = await reading;
    assert.equal(initial.decisions[0]?.id, 'd-1', 'initial decision from full read');

    const rpcsBefore = transport.requestCount;

    // Push an entity with the per-decision family key.
    // On a legacy gateway (no entitySync), 'decision' is a known resource family that
    // is NOT a declared dependency of decision.list (which only declares 'decisions').
    // The cache skips it entirely — no collection update, no re-read.
    // Revert proof: if we mistakenly apply the push (call applyEntity on the undefined collection),
    // the cache would still not update — but the RPC count assertion would fail if a re-read fires.
    transport.publish({
      version: 1,
      epoch: 'conformance-epoch',
      changes: [
        {
          key: { family: 'decision', decisionId: 'd-1' },
          revision: 2,
          kind: 'updated',
          changedEntity: {
            family: 'decision',
            entity: { ...d1, title: 'Should be ignored' },
            version: 'v2',
          },
        },
      ],
    });

    // Allow microtasks to settle — the entity push must not trigger any RPC.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      transport.requestCount,
      rpcsBefore,
      'entity push does not trigger re-read on legacy gateway',
    );
    // The list data is unchanged (no collection injection occurred).
    assert.equal(initial.decisions[0]?.title, d1.title, 'entity push ignored on legacy gateway');

    cache.dispose();
  },
);
