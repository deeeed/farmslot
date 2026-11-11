import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  ModelCatalogFormatError,
  NodeModelCatalogs,
  parsePiModelCatalog,
  queryNodeModelCatalog,
} from './model-catalog.js';

const full = ['anthropic/fixture', ...Array.from({ length: 7 }, (_, i) => `litellm/fixture-${i}`)];
const table = 'provider model\nanthropic fixture\n';
const report = (sources: unknown) =>
  `${JSON.stringify({ type: 'farmslot.pi-provider-discovery', sources })}\n${table}`;

test('legacy tables and optional discovery failures remain usable; configured empty responses permit removals', () => {
  assert.deepEqual(parsePiModelCatalog(table), {
    ids: ['anthropic/fixture'],
    configuredProviders: [],
  });
  assert.deepEqual(
    parsePiModelCatalog(
      report([
        { provider: 'ollama', configured: false, status: 'failed', modelCount: 0 },
        { provider: 'litellm', configured: true, status: 'ready', modelCount: 0 },
      ]),
    ),
    { ids: ['anthropic/fixture'], configuredProviders: ['litellm'] },
  );
});

for (const sources of [
  undefined,
  [{}],
  [{ provider: 'litellm', configured: true, status: 'ready', modelCount: -1 }],
]) {
  test('malformed structured discovery cannot certify a partial listing', () => {
    assert.throws(() => parsePiModelCatalog(report(sources)), ModelCatalogFormatError);
  });
}

test('changing small sets restart confirmation; moderate and unconfigured drops publish immediately', () => {
  const store = new NodeModelCatalogs();
  store.record('fixture', 'node-a', full);
  const accept = (ids: string[], configuredProviders = ['litellm']) =>
    store.accept('fixture', 'node-a', { ids, configuredProviders });
  assert.equal(accept(full.slice(0, 2)), false);
  assert.equal(accept(full.slice(0, 2)), false);
  assert.equal(accept(full.slice(0, 3)), false);
  assert.equal(accept([...full.slice(0, 3)].reverse()), false);
  assert.equal(accept(full.slice(0, 3)), true);
  store.record('fixture', 'node-a', full);
  assert.equal(accept(full.slice(0, 4)), true);
  store.record('fixture', 'node-a', full);
  assert.equal(accept(full.slice(0, 1), []), true);
});

test('direct node reads retain suspect models without renewing other nodes age or refusing placement', async (t) => {
  let now = 0;
  const clock = mock.method(Date, 'now', () => now);
  t.after(() => clock.mock.restore());
  const store = new NodeModelCatalogs();
  store.record('fixture', 'node-a', full);
  store.record('fixture', 'node-b', ['anthropic/fixture']);
  now = 200_000;
  const source = {
    nodeCommand: 'fixture',
    slotPathKey: 'piPath' as const,
    args: [],
    parse: parsePiModelCatalog,
  };
  const nodes = [
    {
      machine: 'node-a',
      list: async () =>
        report([{ provider: 'litellm', configured: true, status: 'ready', modelCount: 0 }]),
    },
  ];
  await queryNodeModelCatalog('fixture', source, nodes, store);
  assert.deepEqual(store.listing('fixture', 'node-a'), full);
  assert.equal(
    store.blocker('fixture', 'litellm/fixture-0', 'node-b')?.includes('only on node-a'),
    true,
  );
  now = 300_000;
  assert.equal(store.blocker('fixture', 'litellm/fixture-0', 'node-b'), null);
  await queryNodeModelCatalog('fixture', source, nodes, store);
  assert.deepEqual(store.listing('fixture', 'node-a'), full);
  await queryNodeModelCatalog('fixture', source, nodes, store);
  assert.deepEqual(store.listing('fixture', 'node-a'), ['anthropic/fixture']);
});
