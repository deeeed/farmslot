import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { preservePiStaticModels, resolvePiProviderCatalog } from './pi-farmslot-providers.mjs';
import { capContextImages, IMAGE_OMITTED, modelImageCaps } from './pi-image-cap.mjs';

// Run 6d33468d (localsparks/GLM-5.3-Flash-s1234): Sparks vLLM refused the request with
// "at most 50 images (--vision-max-images); it has 51". Pi records image caps in the model
// catalog (inputLimits.images) but does not trim history against them.
const image = (n) => ({ type: 'image', data: `img-${n}`, mimeType: 'image/png' });
const text = (value) => ({ type: 'text', text: value });

function screenshots(count) {
  return Array.from({ length: count }, (_, n) => ({
    role: 'toolResult',
    toolCallId: `t${n}`,
    toolName: 'read',
    content: [text(`shot ${n}`), image(n)],
  }));
}

const images = (messages) =>
  messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'image').map((block) => block.data)
      : [],
  );

test('a request over the per-request cap loses its oldest images, newest kept', () => {
  const messages = [{ role: 'user', content: 'fix it' }, ...screenshots(51)];
  const capped = capContextImages(messages, { perRequest: 50 });
  assert.equal(capped.dropped, 1);
  assert.equal(images(capped.messages).length, 50);
  assert.deepEqual(images(capped.messages).slice(0, 2), ['img-1', 'img-2']);
  assert.equal(images(capped.messages).at(-1), 'img-50');
  // The dropped image leaves a note in its place; the rest of the message is unchanged.
  assert.deepEqual(capped.messages[1].content, [text('shot 0'), text(IMAGE_OMITTED)]);
  // The input is not modified.
  assert.equal(images(messages).length, 51);
});

test('a message over the per-message cap loses its own oldest images first', () => {
  const messages = [
    { role: 'user', content: [text('compare'), image('a'), image('b'), image('c')] },
    ...screenshots(2),
  ];
  const capped = capContextImages(messages, { perMessage: 2, perRequest: 3 });
  assert.equal(capped.dropped, 2);
  assert.deepEqual(images(capped.messages), ['img-c', 'img-0', 'img-1']);
});

test('no cap, or a request within the cap, leaves the context alone', () => {
  const messages = screenshots(3);
  assert.equal(capContextImages(messages, {}), undefined);
  assert.equal(capContextImages(messages, { perRequest: 3 }), undefined);
  assert.deepEqual(modelImageCaps({ inputLimits: { images: { maxPerRequest: 50 } } }), {
    perRequest: 50,
    perMessage: undefined,
  });
  assert.deepEqual(modelImageCaps(undefined), { perRequest: undefined, perMessage: undefined });
  assert.deepEqual(modelImageCaps({ inputLimits: { images: { maxPerRequest: 0 } } }), {
    perRequest: undefined,
    perMessage: undefined,
  });
});

const modelsFetch = (id) => async () =>
  new Response(JSON.stringify({ data: [{ id }] }), {
    headers: { 'content-type': 'application/json' },
  });

test('a provider max-images setting, or a model limit, sets the model image cap', async () => {
  const [provider] = await resolvePiProviderCatalog(
    {
      FARMSLOT_PI_OLLAMA: '0',
      FARMSLOT_PI_ROUTER_URL: 'http://router.test',
      FARMSLOT_PI_ROUTER_ID: 'localsparks',
      FARMSLOT_PI_ROUTER_MAX_IMAGES: '50',
    },
    { fetchImpl: modelsFetch('GLM-5.3-Flash-s1234') },
  );
  assert.deepEqual(provider.models[0].inputLimits, { images: { maxPerRequest: 50 } });
  const [overridden] = await resolvePiProviderCatalog(
    {
      FARMSLOT_PI_OLLAMA: '0',
      FARMSLOT_PI_ROUTER_URL: 'http://router.test',
      FARMSLOT_PI_ROUTER_MAX_IMAGES: '50',
      FARMSLOT_PI_ROUTER_MODEL_LIMITS: JSON.stringify({ 'GLM-5.3-Flash-s12': { maxImages: 20 } }),
    },
    { fetchImpl: modelsFetch('GLM-5.3-Flash-s12') },
  );
  assert.equal(overridden.models[0].inputLimits.images.maxPerRequest, 20);
  const [uncapped] = await resolvePiProviderCatalog(
    { FARMSLOT_PI_OLLAMA: '0', FARMSLOT_PI_ROUTER_URL: 'http://router.test' },
    { fetchImpl: modelsFetch('model') },
  );
  assert.equal(uncapped.models[0].inputLimits, undefined);
  await assert.rejects(
    resolvePiProviderCatalog(
      {
        FARMSLOT_PI_OLLAMA: '0',
        FARMSLOT_PI_ROUTER_URL: 'http://router.test',
        FARMSLOT_PI_ROUTER_MAX_IMAGES: 'many',
      },
      { fetchImpl: modelsFetch('model') },
    ),
    /FARMSLOT_PI_ROUTER_MAX_IMAGES/,
  );
});

test('a static models.json entry keeps the pool image cap unless it declares its own', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-image-cap-static-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, 'agent');
  mkdirSync(agent);
  writeFileSync(join(agent, 'models.json'), '{}');
  const env = {
    PI_CODING_AGENT_DIR: agent,
    FARMSLOT_PI_OLLAMA: '0',
    FARMSLOT_PI_ROUTER_URL: 'http://router.test',
    FARMSLOT_PI_ROUTER_ID: 'localsparks',
    FARMSLOT_PI_ROUTER_MAX_IMAGES: '50',
  };
  const catalog = await resolvePiProviderCatalog(env, {
    fetchImpl: async () => Response.json({ data: [{ id: 'GLM-5.3-Flash-s1234' }, { id: 'own' }] }),
  });
  const [provider] = await preservePiStaticModels(
    catalog,
    async () => ({
      getError: () => undefined,
      getModels: () => [
        { id: 'GLM-5.3-Flash-s1234', reasoning: true },
        { id: 'own', reasoning: true, inputLimits: { images: { maxPerRequest: 8 } } },
      ],
    }),
    env,
  );
  const byId = new Map(provider.models.map((model) => [model.id, model]));
  assert.equal(byId.get('GLM-5.3-Flash-s1234').inputLimits.images.maxPerRequest, 50);
  assert.equal(byId.get('own').inputLimits.images.maxPerRequest, 8);
});

async function checkContextHook(extensionUrl) {
  const assert = (await import('node:assert/strict')).default;
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { default: install } = await import(extensionUrl);

  const root = mkdtempSync(path.join(tmpdir(), 'pi-image-cap-'));
  const events = new Map();
  process.env = {
    PI_CODING_AGENT_DIR: path.join(root, 'agent'),
    FARMSLOT_PI_OLLAMA: '0',
    FARMSLOT_OBS_DIR: root,
  };
  const shots = Array.from({ length: 51 }, (_, n) => ({
    role: 'toolResult',
    toolCallId: `t${n}`,
    toolName: 'read',
    content: [{ type: 'image', data: `img-${n}`, mimeType: 'image/png' }],
  }));
  const count = (messages) =>
    messages.flatMap((message) => message.content).filter((block) => block.type === 'image').length;
  try {
    await install({ on: (name, handler) => events.set(name, handler) });
    const context = events.get('context');
    assert.ok(context, 'the extension handles the context event');
    const capped = await context(
      { type: 'context', messages: shots },
      { model: { inputLimits: { images: { maxPerRequest: 50 } } } },
    );
    assert.equal(count(capped.messages), 50);
    assert.equal(capped.messages[0].content[0].type, 'text');
    assert.equal(
      await context({ type: 'context', messages: shots }, { model: { id: 'uncapped' } }),
      undefined,
      'a model without an image cap keeps the context unchanged',
    );
  } finally {
    await events.get('session_shutdown')?.({});
    rmSync(root, { recursive: true, force: true });
  }
}

test('the pi observability extension trims images to the selected model cap', () => {
  const extension = new URL('./pi-farmslot-observability.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `await (${checkContextHook.toString()})(${JSON.stringify(extension)});`,
    ],
    { encoding: 'utf8', timeout: 8000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
