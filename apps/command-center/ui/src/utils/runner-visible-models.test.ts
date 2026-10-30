import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { RunnerVisibleModelState } from '@farmslot/protocol';

import { installFakeGateway } from '../testing/fake-gateway.js';

import {
  onVisibleModelsChange,
  setObservedVisibleModels,
  visibleDefaultModel,
  visibleModelIds,
  visibleReviewDispatchCatalog,
} from './runner-visible-models.js';

const state = (
  runner: string,
  models: string[],
  defaultModel: string,
): RunnerVisibleModelState => ({
  runner,
  models,
  pickerModels: models,
  defaultModel,
  defaultConfigured: true,
  configured: true,
});

test('the observed projection notifies only on change and keeps slash model IDs', () => {
  setObservedVisibleModels([]);
  let calls = 0;
  const stop = onVisibleModelsChange(() => calls++);
  try {
    assert.equal(visibleDefaultModel('pi'), undefined);
    assert.equal(visibleModelIds('pi'), null);
    setObservedVisibleModels([state('pi', ['anthropic/claude-opus-5'], 'anthropic/claude-opus-5')]);
    setObservedVisibleModels([state('pi', ['anthropic/claude-opus-5'], 'anthropic/claude-opus-5')]);
    assert.equal(calls, 1);
    assert.deepEqual(visibleModelIds('pi'), ['anthropic/claude-opus-5']);
    assert.equal(visibleDefaultModel('pi'), 'anthropic/claude-opus-5');
    assert.ok(visibleReviewDispatchCatalog().runners.some((runner) => runner.id === 'pi'));
  } finally {
    stop();
    setObservedVisibleModels([]);
  }
});

test('views share one owner-scoped observation that follows the gateway owner key', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'visible-model-epoch';
  let revision = 0;
  let models = ['sonnet'];
  let holdRead = false;
  fake.responseForRequest = ({ method }) =>
    method === 'runner.visibleModels.get'
      ? holdRead
        ? undefined
        : {
            payload: { runners: [state('claude', models, models[0])] },
            resourceState: {
              epoch: fake.resourceEpoch,
              dependencies: [
                { key: { family: 'profiles', scope: 'owner', ownerId: 'operator' }, revision },
              ],
            },
          }
      : { payload: {} };
  const { gateway } = await import('../gateway-client.js');
  const { initState } = await import('../state.js');
  const { disposeResourceCache } = await import('../resource-cache.js');
  const { watchVisibleModels } = await import('./runner-visible-models-loader.js');
  fake.beforeRestore = async () => {
    gateway.disconnect();
    await disposeResourceCache();
    setObservedVisibleModels([]);
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  initState();
  await gateway.setAuthCredentials({ token: 'test-secret' });
  gateway.connect();
  await flush();
  const reads = () => fake.requests.filter(({ method }) => method === 'runner.visibleModels.get');
  const nextRead = async (previousCount: number) => {
    const deadline = Date.now() + 1000;
    while (reads().length === previousCount && Date.now() < deadline) await delay(1);
    assert.ok(reads().length > previousCount, 'Invalidation must start a new current read');
    return reads().at(-1)!;
  };
  const errors: string[] = [];
  const first = watchVisibleModels((error) => errors.push(error));
  const second = watchVisibleModels(() => {});
  await flush();
  assert.equal(reads().length, 1);
  assert.deepEqual(reads()[0].params, {});
  assert.deepEqual(reads()[0].resourceRead, { version: 1 });
  assert.deepEqual(visibleModelIds('claude'), ['sonnet']);
  assert.ok(errors.every((error) => error === ''));

  models = ['haiku'];
  revision++;
  const socket = fake.sockets.at(-1)!;
  socket.event('resource.changed', {
    version: 1,
    epoch: fake.resourceEpoch,
    changes: [
      {
        key: { family: 'profiles', scope: 'owner', ownerId: 'operator' },
        revision,
        kind: 'updated',
      },
    ],
  });
  await flush();
  assert.equal(reads().length, 2);
  assert.deepEqual(visibleModelIds('claude'), ['haiku']);
  assert.equal(visibleDefaultModel('claude'), 'haiku');
  const change = () => {
    revision++;
    socket.event('resource.changed', {
      version: 1,
      epoch: fake.resourceEpoch,
      changes: [
        {
          key: { family: 'profiles', scope: 'owner', ownerId: 'operator' },
          revision,
          kind: 'updated',
        },
      ],
    });
  };
  await t.test('retry keeps the last failure until a successful current observation', async () => {
    holdRead = true;
    const beforeFailure = reads().length;
    change();
    const failed = await nextRead(beforeFailure);
    socket.failure(failed.id, {
      code: 'UNAVAILABLE',
      message: 'Visible models unavailable',
    });
    await flush();
    assert.equal(errors.at(-1), 'Visible models unavailable');
    holdRead = true;
    const beforeRetry = reads().length;
    change();
    const pending = await nextRead(beforeRetry);
    assert.equal(errors.at(-1), 'Visible models unavailable');
    holdRead = false;
    socket.response(
      pending.id,
      { runners: [state('claude', models, models[0])] },
      {
        epoch: fake.resourceEpoch,
        dependencies: [
          { key: { family: 'profiles', scope: 'owner', ownerId: 'operator' }, revision },
        ],
      },
    );
    await flush();
    assert.equal(errors.at(-1), '');
  });
  first();
  second();
});
