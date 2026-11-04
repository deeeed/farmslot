import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import {
  NodeModelCatalogs,
  nodeModelCatalogs,
  parsePiModelList,
  queryNodeModelCatalog,
  type RunnerModelCatalogNodeSource,
} from './model-catalog.js';

const { resolveDispatchPreviewFromFleet } = await import('../methods/dispatch/preview.js');

const missing = 'pi model litellm/kimi-k3 is not listed on macpro; only on mini';
const source: RunnerModelCatalogNodeSource = {
  nodeCommand: 'pi',
  slotPathKey: 'piPath',
  args: ['--list-models'],
  parse: parsePiModelList,
};

test('an expired node listing cannot refuse a model and a fresh listing restores the check', async (t) => {
  let now = 0;
  const clock = mock.method(Date, 'now', () => now);
  t.after(() => clock.mock.restore());
  const store = new NodeModelCatalogs();
  store.record('pi', 'macpro', ['xai/grok-4.7']);
  store.record('pi', 'mini', ['litellm/kimi-k3']);
  assert.equal(store.blocker('pi', 'litellm/kimi-k3', 'macpro'), missing);
  now = 5 * 60_000;
  assert.equal(store.blocker('pi', 'litellm/kimi-k3', 'macpro'), null);
  let reads = 0;
  await queryNodeModelCatalog(
    'pi',
    source,
    [
      {
        machine: 'macpro',
        list: async () => {
          reads++;
          return 'provider model context max-out thinking images\nxai grok-4.7 2M 64K yes yes\n';
        },
      },
    ],
    store,
  );
  for (let dispatch = 0; dispatch < 3; dispatch++)
    assert.equal(store.blocker('pi', 'litellm/kimi-k3', 'macpro'), missing);
  assert.equal(reads, 1);
  assert.deepEqual(
    parsePiModelList(
      'provider model context max-out thinking images\nlitellm  kimi-k3  1.0M  131.1K  yes  yes\n',
    ),
    ['litellm/kimi-k3'],
  );
});

test(
  'a failed node refresh keeps picker data but cannot refuse using the previous listing',
  { timeout: 2000 },
  async () => {
    const store = new NodeModelCatalogs();
    store.record('pi', 'macpro', ['xai/grok-4.7']);
    store.record('pi', 'mini', ['litellm/kimi-k3']);
    const picker = store.result('pi');
    await queryNodeModelCatalog(
      'pi',
      source,
      [
        {
          machine: 'macpro',
          list: async () => {
            throw new Error('exit code 124');
          },
        },
      ],
      store,
    );
    assert.deepEqual(store.result('pi'), picker);
    assert.equal(store.blocker('pi', 'litellm/kimi-k3', 'macpro'), null);
    await queryNodeModelCatalog(
      'pi',
      source,
      [
        {
          machine: 'macpro',
          list: async () => 'provider model context max-out thinking images\n',
        },
      ],
      store,
    );
    assert.equal(store.blocker('pi', 'litellm/kimi-k3', 'macpro'), null);
    await queryNodeModelCatalog(
      'pi',
      source,
      [
        {
          machine: 'macpro',
          list: async () =>
            'provider model context max-out thinking images\nlitellm kimi-k3 1.0M 131.1K yes yes\n',
        },
      ],
      store,
    );
    assert.equal(store.blocker('pi', 'litellm/kimi-k3', 'macpro'), null);
    assert.deepEqual(store.listing('pi', 'macpro'), ['litellm/kimi-k3']);
  },
);

function slot(slotId: string, machine: string): SlotStatus {
  return {
    slot: slotId,
    machine,
    project: 'catalog-placement',
    platform: 'web',
    branch: 'main',
    lifecycle: 'ready',
    phase: null,
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    warm: true,
    health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: 'OFF', fixtures: '-' },
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: 'pi',
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  };
}

for (const unavailable of ['expired', 'failed-refresh'] as const) {
  test(`a ${unavailable} listing steers placement to a node that lists the model`, (t) => {
    let now = 0;
    const clock = mock.method(Date, 'now', () => now);
    t.after(() => clock.mock.restore());
    const absent = slot('absent', 'placement-absent');
    const listed = slot('listed', 'placement-listed');
    absent.health.cdp = 'Wallet';
    nodeModelCatalogs.record('pi', absent.machine, ['xai/grok-4.7']);
    nodeModelCatalogs.record('pi', listed.machine, ['litellm/kimi-k3']);
    if (unavailable === 'expired') now = 5 * 60_000;
    else {
      nodeModelCatalogs.unavailable('pi', absent.machine);
      nodeModelCatalogs.unavailable('pi', listed.machine);
    }
    const params = {
      project: absent.project,
      flowType: 'dev' as const,
      ticketOrPr: 'PROJ-383',
      runner: 'pi',
      model: 'litellm/kimi-k3',
    };
    assert.equal(nodeModelCatalogs.blocker('pi', params.model, absent.machine), null);
    assert.equal(
      resolveDispatchPreviewFromFleet(params, [absent, listed]).preview.slotId,
      listed.slot,
    );
    assert.equal(
      resolveDispatchPreviewFromFleet({ ...params, flowType: 'pr-complete' }, [
        { ...absent, lifecycle: 'held', branch: 'proj-383' },
        listed,
      ]).preview.slotId,
      listed.slot,
    );
  });
}

test('control: a stale listing refuses neither the only candidate nor a pinned slot', (t) => {
  let now = 0;
  const clock = mock.method(Date, 'now', () => now);
  t.after(() => clock.mock.restore());
  const absent = slot('only', 'only-absent');
  const listed = slot('other', 'other-listed');
  nodeModelCatalogs.record('pi', absent.machine, ['xai/grok-4.7']);
  nodeModelCatalogs.record('pi', listed.machine, ['litellm/kimi-k3']);
  now = 5 * 60_000;
  const params = {
    project: absent.project,
    flowType: 'dev' as const,
    ticketOrPr: 'PROJ-383',
    runner: 'pi',
    model: 'litellm/kimi-k3',
  };
  for (const candidates of [[absent], [absent, { ...listed, lifecycle: 'disabled' as const }]])
    assert.equal(resolveDispatchPreviewFromFleet(params, candidates).preview.slotId, absent.slot);
  assert.equal(
    resolveDispatchPreviewFromFleet({ ...params, slotId: absent.slot }, [absent, listed]).preview
      .slotId,
    absent.slot,
  );
  assert.equal(
    resolveDispatchPreviewFromFleet({ ...params, allowedSlots: [absent.slot] }, [absent, listed])
      .preview.slotId,
    absent.slot,
  );
});
