import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMetroRecipeBridge,
  resolveMetroRecipeBridgePort,
} from './metro-recipe-bridge-transport.js';

test('resolveMetroRecipeBridgePort prefers FARMSLOT_RECIPE_METRO_PORT', () => {
  assert.equal(
    resolveMetroRecipeBridgePort({
      FARMSLOT_RECIPE_METRO_PORT: '9001',
      METRO_PORT: '7677',
    }),
    9001,
  );
});

test('createMetroRecipeBridge posts commands to Metro relay and surfaces bridge failures', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const bridge = createMetroRecipeBridge({
    host: '127.0.0.1',
    port: 7677,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, platform: 'android' }), { status: 200 });
    },
  });

  const result = await bridge.send(
    { command: 'status', nodeId: 'bridge-status', payload: {} },
    {
      nodeId: 'bridge-status',
      recipePath: '/tmp/recipe.json',
      artifactsDir: '/tmp/artifacts',
      outputs: {},
    },
  );

  assert.deepEqual(result, { ok: true, platform: 'android' });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? '', /\/farmslot-recipe\/command$/u);
});

test('createMetroRecipeBridge throws when Metro relay returns ok:false', async () => {
  const bridge = createMetroRecipeBridge({
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: false, error: 'bridge missing' }), { status: 200 }),
  });

  await assert.rejects(
    () =>
      bridge.send(
        { command: 'status', nodeId: 'bridge-status', payload: {} },
        {
          nodeId: 'bridge-status',
          recipePath: '/tmp/recipe.json',
          artifactsDir: '/tmp/artifacts',
          outputs: {},
        },
      ),
    /bridge missing/u,
  );
});
