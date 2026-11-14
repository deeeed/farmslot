import assert from 'node:assert/strict';
import test from 'node:test';

import { reasoningEffortLabel } from '@farmslot/protocol';

function registeredIds(sources: unknown): string[] {
  if (!Array.isArray(sources)) throw new Error('listPiProviderSources did not return sources');
  const ids: string[] = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const id = Reflect.get(source, 'id');
    const aliases = Reflect.get(source, 'aliases');
    if (typeof id === 'string') ids.push(id);
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) if (typeof alias === 'string') ids.push(alias);
  }
  return ids;
}

test('a registered Pi source does not label omitted off as off', async () => {
  const providers = await import('../../../../scripts/runners/pi-farmslot-providers.mjs');
  const list = Reflect.get(providers, 'listPiProviderSources');
  if (typeof list !== 'function') throw new Error('listPiProviderSources is not exported');
  const ids = registeredIds(
    Reflect.apply(list, providers, [
      {
        FARMSLOT_PI_OLLAMA_URL: 'http://127.0.0.1:11434',
        LITELLM_URL: 'http://127.0.0.1:4000',
        FARMSLOT_PI_ROUTER_URL: 'http://127.0.0.1:8000',
        FARMSLOT_PI_ROUTER_ID: 'localsparks',
      },
    ]),
  );
  assert.deepEqual(ids.sort(), ['litellm', 'localsparks', 'ollama', 'router']);
  for (const id of ids) assert.equal(reasoningEffortLabel('off', `${id}/model`), 'default', id);
});
