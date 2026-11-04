import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  NodeModelCatalogs,
  parsePiModelList,
  queryNodeModelCatalog,
  type RunnerModelCatalogNodeSource,
} from './model-catalog.js';

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
