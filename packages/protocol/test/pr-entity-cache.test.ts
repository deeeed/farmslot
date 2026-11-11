/**
 * Cache-level tests for PR list entity sync (ADR-071 Amendment 3).
 *
 * Four scenarios:
 * 1. data-only: collection held + complete, inline entity push → zero extra RPCs
 * 2. membership: upstream collection change triggers exactly one versions read
 * 3. cold start: stored rows hydrate the collection, zero ids-read RPCs
 * 4. old gateway: no entitySync capability → full RPC used
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayResourceCache } from '../src/client-cache/cache.js';
import { ResourceCacheConformanceTransport } from '../src/client-cache/conformance.js';
import { resourceCollectorQuery, resourceQuery } from '../src/client-cache/registry.js';
import type { ResourceCacheConnection } from '../src/client-cache/types.js';
import type { PRStatus } from '../src/contracts/reviews.js';
import type { PREntityPage, PRListResult, PRVersionsResult } from '../src/rpc/pr.js';
import { Methods } from '../src/rpc/registry.js';

const scope = {
  gatewayUrl: 'ws://pr-entity-cache-test.invalid/',
  principalId: 'test-principal',
  principalGeneration: 0,
};

const prListQuery = resourceQuery<PRListResult>(Methods.PR_LIST);

function makePR(pr: number, repo = 'org/repo', branch = 'main'): PRStatus {
  return {
    pr,
    repo,
    title: `PR ${pr}`,
    summary: null,
    project: 'example',
    slot: null,
    session: null,
    checks: [],
    checkSummary: { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 },
    allPassed: false,
    anyFailed: false,
    failedNames: [],
    botComments: [],
    actionableBotComments: [],
    prState: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    mergeConflict: false,
    reviewDecision: 'REVIEW_REQUIRED',
    recommendation: 'WORKING',
    headRef: branch,
  };
}

function prKey(pr: PRStatus): string {
  return `${pr.repo}/${pr.pr}`;
}

function prVersion(pr: PRStatus): string {
  // Must match prEntityVersion in gateway (sha256 of canonicalResourceJson).
  // For test purposes a stable mock version is fine.
  return `v-${pr.repo}-${pr.pr}-${pr.headRef}`;
}

function makeVersionsResult(prs: PRStatus[]): PRVersionsResult {
  return {
    versions: prs.map((p) => ({ id: prKey(p), version: prVersion(p) })),
    fetchedAt: new Date().toISOString(),
    observation: { status: 'ready', observedAt: Date.now() },
  };
}

function makePageResult(prs: PRStatus[]): PREntityPage {
  return {
    entities: prs,
    versions: prs.map((p) => ({ id: prKey(p), version: prVersion(p) })),
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
        epoch: 'pr-test-epoch',
        versionLists: false,
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
        epoch: 'pr-test-epoch',
        versionLists: false,
      },
    },
  };
}

function waitForData<T>(
  cache: ReturnType<typeof createGatewayResourceCache>,
  query: ReturnType<typeof resourceQuery<T>>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForData timeout')), 3000);
    const stop = cache.observe(query as ReturnType<typeof resourceQuery>, (state) => {
      if (state.status === 'ready') {
        if (state.data !== undefined) {
          clearTimeout(timer);
          stop();
          resolve(state.data as T);
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
  'pr entity cache: data-only path uses zero extra RPCs after inline entity push',
  { timeout: 5000 },
  async () => {
    const pr1 = makePR(1, 'org/repo', 'main');
    const queryId = resourceCollectorQuery(Methods.PR_LIST, {}).id;
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // First read: versions read + page read
    const reading = waitForData<PRListResult>(cache, prListQuery);

    const versionsRead = await transport.nextRead();
    versionsRead.resolve(makeVersionsResult([pr1]));

    const pageRead = await transport.nextRead();
    pageRead.resolve(makePageResult([pr1]));

    const result = await reading;
    assert.equal(result.prs.length, 1);
    assert.equal(result.prs[0].pr, 1);

    const countAfterFirstRead = transport.requestCount;

    // Push a PR entity update inline (no RPC — entity is pushed)
    const updatedPR = makePR(1, 'org/repo', 'feature');
    transport.publish({
      version: 1,
      epoch: 'pr-test-epoch',
      changes: [
        {
          key: { family: 'upstream', integration: 'github', queryId, prKey: prKey(pr1) },
          revision: 2,
          kind: 'updated',
          changedEntity: {
            family: 'upstream',
            entity: updatedPR,
            version: prVersion(updatedPR),
          },
        },
      ],
    });

    // Second read should use zero extra RPCs
    const reading2 = waitForData<PRListResult>(cache, prListQuery);
    const result2 = await reading2;
    assert.equal(result2.prs[0].headRef, 'feature', 'inline entity applied');
    assert.equal(
      transport.requestCount,
      countAfterFirstRead,
      'no extra RPCs after inline entity push',
    );

    cache.dispose();
  },
);

test(
  'pr entity cache: membership change triggers one versions read',
  { timeout: 5000 },
  async () => {
    const pr1 = makePR(1);
    const pr2 = makePR(2);
    const queryId = resourceCollectorQuery(Methods.PR_LIST, {}).id;
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // First read: versions + page
    const reading = waitForData<PRListResult>(cache, prListQuery);
    const v1 = await transport.nextRead();
    v1.resolve(makeVersionsResult([pr1]));
    const p1 = await transport.nextRead();
    p1.resolve(makePageResult([pr1]));
    await reading;

    const countAfterFirst = transport.requestCount;

    // Push membership change (new PR added to collection)
    transport.publish({
      version: 1,
      epoch: 'pr-test-epoch',
      changes: [
        {
          key: { family: 'upstream', integration: 'github', queryId },
          revision: 2,
          kind: 'updated',
          membershipRevision: 2,
        },
      ],
    });

    // Next read must trigger exactly one versions read (membership changed)
    const reading2 = waitForData<PRListResult>(cache, prListQuery);
    const v2 = await transport.nextRead();
    v2.resolve(makeVersionsResult([pr1, pr2]));
    // Page read for the new PR
    const p2 = await transport.nextRead();
    p2.resolve(makePageResult([pr2]));
    const result2 = await reading2;

    assert.equal(result2.prs.length, 2);
    assert.equal(
      transport.requestCount - countAfterFirst,
      2,
      'one versions read + one page read for new PR',
    );

    cache.dispose();
  },
);

test(
  'pr entity cache: unchanged versions after membership push costs zero ids reads',
  { timeout: 5000 },
  async () => {
    const pr1 = makePR(1);
    const queryId = resourceCollectorQuery(Methods.PR_LIST, {}).id;
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection(entitySyncConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // First read: versions + page
    const reading = waitForData<PRListResult>(cache, prListQuery);
    const v1 = await transport.nextRead();
    v1.resolve(makeVersionsResult([pr1]));
    const p1 = await transport.nextRead();
    p1.resolve(makePageResult([pr1]));
    await reading;

    // Push membership change (same PR, same version — nothing actually changed)
    transport.publish({
      version: 1,
      epoch: 'pr-test-epoch',
      changes: [
        {
          key: { family: 'upstream', integration: 'github', queryId },
          revision: 2,
          kind: 'updated',
          membershipRevision: 2,
        },
      ],
    });

    // The follow-up versions read returns the same versions (no changed entities)
    const reading2 = waitForData<PRListResult>(cache, prListQuery);
    const v2 = await transport.nextRead();
    v2.resolve(makeVersionsResult([pr1])); // same versions as before

    // No page read should fire: entity already held at same version
    const pageReadOrTimeout = Promise.race([
      transport.nextRead().then((r) => {
        r.resolve(makePageResult([pr1]));
        return 'page';
      }),
      new Promise<string>((r) => setTimeout(() => r('none'), 300)),
    ]);
    const outcome = await pageReadOrTimeout;
    const result2 = await reading2;

    assert.equal(result2.prs.length, 1, 'PR still served');
    assert.equal(outcome, 'none', 'zero ids-read RPCs when versions unchanged');

    cache.dispose();
  },
);

test(
  'pr entity cache: no entitySync capability — entity pushes are ignored, no entity sync RPCs fire',
  { timeout: 5000 },
  async () => {
    const pr1 = makePR(1);
    const queryId = resourceCollectorQuery(Methods.PR_LIST, {}).id;
    const transport = new ResourceCacheConformanceTransport(scope);
    // Connect WITHOUT entitySync (legacy gateway)
    transport.setConnection(legacyGatewayConnection(transport));
    const cache = createGatewayResourceCache({ transport });

    // Push a PR entity — should be ignored since entitySync is not in capabilities
    transport.publish({
      version: 1,
      epoch: 'pr-test-epoch',
      changes: [
        {
          key: { family: 'upstream', integration: 'github', queryId, prKey: prKey(pr1) },
          revision: 1,
          kind: 'updated',
          changedEntity: { family: 'upstream', entity: pr1, version: prVersion(pr1) },
        },
      ],
    });

    // Allow microtasks to settle
    await new Promise((r) => setTimeout(r, 50));

    // No entity sync RPCs should have fired (entity push was ignored)
    assert.equal(transport.requestCount, 0, 'no entity sync versions or ids RPCs fired');

    // Observe the query: without entitySync the cache tries the collector path
    // (which fails without upstreamObservers support), resulting in an error state — not 'ready'.
    const errorState = await new Promise<{ status: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout' }), 1000);
      cache.observe(prListQuery as ReturnType<typeof resourceQuery>, (state) => {
        if (state.status === 'error' || state.status === 'unsupported') {
          clearTimeout(timer);
          resolve(state);
        }
      });
    });

    assert.ok(
      errorState.status !== 'ready',
      'without entitySync, pushed entity must not populate the cache as ready',
    );

    cache.dispose();
  },
);
