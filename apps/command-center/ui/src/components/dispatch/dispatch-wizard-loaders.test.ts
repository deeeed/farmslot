import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import type { DispatchCandidatesResult } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type GatewayResourceCache,
  resourceQuery,
  type ResourceReadResult,
} from '@farmslot/protocol/client-cache';
import { ResourceCacheConformanceTransport } from '@farmslot/protocol/client-cache/conformance';

let activeCache: GatewayResourceCache | undefined;
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => activeCache,
    getResourceWorkspaceKey: () => 'owner',
  },
});
mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
const { requestDispatchWizardCandidates, requestDispatchProjectMatch } =
  await import('./dispatch-wizard-loaders.js');
import type {
  DispatchProjectMatchResult,
  DispatchWizardCandidatesRequest,
} from './dispatch-wizard-loaders.js';
import { buildDispatchCandidatesParams } from './dispatch-wizard-payload.js';

const input: DispatchWizardCandidatesRequest = {
  flowType: 'dev',
  machines: [],
  targetBranch: undefined,
  ticketOrPr: 'deeeed/farmslot#1776',
  app: undefined,
  prepareProfile: undefined,
  skipPrepare: false,
  comparison: undefined,
  mockMode: false,
  mockCandidates: null,
};
const candidates: DispatchCandidatesResult = {
  candidates: [
    {
      slotId: 'mini-slot',
      project: 'farmslot',
      score: 0,
      cdpLive: false,
      branch: 'main',
      lifecycle: 'ready',
      onMain: true,
      free: true,
    },
  ],
};

async function fixture(t: TestContext, held = false) {
  const scope = {
    gatewayUrl: 'ws://dispatch.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority: transport.connection.authority! });
  const query = resourceQuery<DispatchCandidatesResult>(
    'dispatch.candidates',
    buildDispatchCandidatesParams(input),
  );
  if (held) await store.putQuery({ id: query.id, data: candidates, observedAt: 123, bytes: 200 });
  let response: DispatchCandidatesResult | DispatchProjectMatchResult = candidates;
  let release = () => {};
  let gate = Promise.resolve();
  const calls: string[] = [];
  let slotRevision = 0;
  transport.request = async <T>(
    method: typeof query.method,
    params: unknown,
  ): Promise<ResourceReadResult<T>> => {
    calls.push(method);
    const read = resourceQuery(method, params);
    const dependencies = read.dependencies.map((key) => ({
      key,
      revision: key.family === 'slots' ? slotRevision : 0,
    }));
    await gate;
    return {
      data: response as T,
      resourceState: {
        epoch: 'conformance-epoch',
        dependencies,
      },
    };
  };
  transport.setConnection({ connected: true });
  const cache = createGatewayResourceCache({ transport, store });
  activeCache = cache;
  t.after(async () => {
    release();
    await cache.dispose();
    if (activeCache === cache) activeCache = undefined;
  });
  return {
    cache,
    transport,
    calls,
    query,
    changeFleet() {
      slotRevision++;
      transport.publish({
        version: 1,
        epoch: 'conformance-epoch',
        changes: [
          { key: { family: 'slots', scope: 'farm' }, revision: slotRevision, kind: 'updated' },
        ],
      });
    },
    response(value: typeof response) {
      response = value;
    },
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release();
    },
  };
}

test('Dispatch publishes a persisted candidate snapshot while its live read is pending', async (t) => {
  const f = await fixture(t, true);
  f.hold();
  f.response({ candidates: [] });
  const shown: DispatchCandidatesResult[] = [];
  const pending = requestDispatchWizardCandidates(input, (value) => shown.push(value));
  for (let turn = 0; turn < 30 && !shown.length; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(shown, [candidates]);
  assert.equal(f.calls.length, 1);
  f.release();
  assert.deepEqual(await pending, { candidates: [] });
});

test('a repeated Jira ticket uses its first result across flow changes', async (t) => {
  const f = await fixture(t);
  const match: DispatchProjectMatchResult = {
    project: 'metamask-mobile',
    repo: 'MetaMask/metamask-mobile',
    issueType: 'Bug',
  };
  f.response(match);
  assert.deepEqual(await requestDispatchProjectMatch('TAT-4355', 'dev'), match);
  assert.deepEqual(await requestDispatchProjectMatch('TAT-4355', 'fix-bug'), match);
  assert.deepEqual(f.calls, ['dispatch.matchProject']);
});

test('a repeated GitHub reference still refreshes its project match', async (t) => {
  const f = await fixture(t);
  f.response({ project: null, repo: null });
  assert.deepEqual(await requestDispatchProjectMatch('deeeed/farmslot#1776', 'pr-complete'), {
    project: null,
    repo: null,
  });
  const match = { project: 'farmslot', repo: 'deeeed/farmslot' };
  f.response(match);
  assert.deepEqual(await requestDispatchProjectMatch('deeeed/farmslot#1776', 'pr-complete'), match);
  assert.equal(f.calls.length, 2);
});

test('each explicit candidate refresh asks the gateway even when that query is cached', async (t) => {
  const f = await fixture(t);
  const refresh = { ...input, forceRefresh: true };
  await requestDispatchWizardCandidates(refresh);
  await requestDispatchWizardCandidates(refresh);
  assert.equal(f.calls.length, 4, 'each forced read also updates the ordinary cached snapshot');
});

test('a completed read remains usable when fleet revisions advance while it is in flight', async (t) => {
  const f = await fixture(t);
  f.hold();
  f.response({ candidates: [] });
  const states: string[] = [];
  const pending = requestDispatchWizardCandidates(input, () =>
    states.push(f.cache.read(f.query).status),
  );
  for (let turn = 0; turn < 30 && !f.calls.length; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  f.changeFleet();
  f.release();
  assert.deepEqual(await pending, { candidates: [] });
  assert.ok(states.includes('stale'), 'the successful reply was stale from the mid-read write');
});

test('an offline early return cannot treat a held snapshot as a new reply', async (t) => {
  const f = await fixture(t);
  await requestDispatchWizardCandidates(input);
  f.transport.setConnection({ connected: false }, 'network');
  await assert.rejects(requestDispatchWizardCandidates(input), /could not refresh/);
});

test('Refresh updates the snapshot used by the next ordinary candidate read', async (t) => {
  const f = await fixture(t);
  await requestDispatchWizardCandidates(input);
  f.response({ candidates: [] });
  await requestDispatchWizardCandidates({ ...input, forceRefresh: true });
  assert.deepEqual(await requestDispatchWizardCandidates(input), { candidates: [] });
  assert.equal(f.calls.length, 3, 'the last ordinary read is a cache hit after refresh');
});

test('a changed fleet invalidates cached candidates and updates them from the gateway', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await requestDispatchWizardCandidates(input), candidates);
  f.changeFleet();
  f.response({ candidates: [] });
  const shown: DispatchCandidatesResult[] = [];
  assert.deepEqual(await requestDispatchWizardCandidates(input, (value) => shown.push(value)), {
    candidates: [],
  });
  assert.deepEqual(shown, [candidates]);
  assert.equal(f.calls.length, 2);
});

test('a reply for the old workspace is refused', async (t) => {
  const f = await fixture(t);
  f.hold();
  const pending = requestDispatchWizardCandidates(input);
  for (let turn = 0; turn < 30 && !f.calls.length; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  activeCache = undefined;
  f.release();
  await assert.rejects(pending, /owner changed/);
});
