import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const providers = await import('@earendil-works/pi-ai/providers/all');
let builds = 0;
let failNextBuild = false;
mock.module('@earendil-works/pi-ai/providers/all', {
  namedExports: {
    ...providers,
    builtinModels: (...args: Parameters<typeof providers.builtinModels>) => {
      builds += 1;
      if (failNextBuild) {
        failNextBuild = false;
        throw new Error('synthetic provider load failure');
      }
      return providers.builtinModels(...args);
    },
  },
});
const { piModels, warmPiModels } = await import('./index.js');

test('a failed warm-up is logged once and the next call loads again', async (t) => {
  const logged = t.mock.method(console, 'error', () => undefined);
  failNextBuild = true;
  await warmPiModels();
  assert.equal(builds, 1);
  assert.equal(logged.mock.callCount(), 1);
  const [message, error] = logged.mock.calls[0].arguments;
  assert.match(String(message), /model warm-up failed/);
  assert.equal((error as Error).message, 'synthetic provider load failure');

  const models = await piModels();
  assert.equal(builds, 2);
  assert.ok(models.getProvider('anthropic'));
});

test('the warm-up and later calls share one cached collection', async () => {
  const loaded = await piModels();
  const built = builds;
  await warmPiModels();
  const [first, second] = await Promise.all([piModels(), piModels()]);
  assert.equal(builds, built);
  assert.equal(first, loaded);
  assert.equal(second, loaded);
});
