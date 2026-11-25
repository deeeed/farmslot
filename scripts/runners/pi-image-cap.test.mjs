import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  piModelImageCaps,
  piSdkModels,
  resolvePiProviderCatalog,
} from './pi-farmslot-providers.mjs';
import { capContextImages, IMAGE_OMITTED } from './pi-image-cap.mjs';

// Run 6d33468d (localsparks/GLM-5.3-Flash-s1234): Sparks vLLM refused the request with
// "at most 50 images (--vision-max-images); it has 51". Pi records image caps in the model
// catalog (inputLimits.images) but does not trim history against them.
const image = (n) => ({ type: 'image', data: `img-${n}`, mimeType: 'image/png' });
const text = (value) => ({ type: 'text', text: value });

function screenshots(count, from = 0) {
  return Array.from({ length: count }, (_, n) => ({
    role: 'toolResult',
    toolCallId: `t${from + n}`,
    toolName: 'read',
    content: [text(`shot ${from + n}`), image(from + n)],
  }));
}

// Tool results separated by assistant turns, as a worker taking one screenshot per turn sends them.
function turns(count) {
  return screenshots(count).flatMap((result) => [
    { role: 'assistant', content: [{ type: 'toolCall', id: result.toolCallId, name: 'read' }] },
    result,
  ]);
}

const images = (messages) =>
  messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'image').map((block) => block.data)
      : [],
  );

test('over the per-request cap, the oldest images go in batches of a fifth of the cap', () => {
  const messages = [{ role: 'user', content: 'fix it' }, ...turns(51)];
  const capped = capContextImages(messages, { perRequest: 50 });
  // 51 images over a cap of 50: one batch of 10 goes, the newest 41 stay.
  assert.equal(capped.dropped, 10);
  assert.equal(capped.images, 51);
  assert.deepEqual(images(capped.messages), images(messages).slice(10));
  // The dropped image leaves a note in its place; the rest of the message is unchanged.
  assert.deepEqual(capped.messages[2].content, [text('shot 0'), text(IMAGE_OMITTED)]);
  // The input is not modified.
  assert.equal(images(messages).length, 51);
  // More images up to the next batch drop the same ones, so the request prefix stays the same.
  const grown = capContextImages([...messages, ...screenshots(9, 51)], { perRequest: 50 });
  assert.deepEqual(grown.messages.slice(0, messages.length), capped.messages);
  assert.equal(
    capContextImages([...messages, ...screenshots(10, 51)], { perRequest: 50 }).dropped,
    20,
  );
});

test('consecutive tool results share one per-message count, as Pi sends them', () => {
  const messages = [
    ...screenshots(3),
    { role: 'assistant', content: [text('next')] },
    ...screenshots(2, 3),
  ];
  const capped = capContextImages(messages, { perMessage: 2 });
  // The first three results form one provider message: its oldest image goes. The last two fit.
  assert.equal(capped.dropped, 1);
  assert.deepEqual(images(capped.messages), ['img-1', 'img-2', 'img-3', 'img-4']);
});

test('a user or custom message counts its own images, before the request cap applies', () => {
  const messages = [
    { role: 'user', content: [text('compare'), image('a'), image('b'), image('c')] },
    { role: 'custom', customType: 'note', display: true, content: [image('d')] },
  ];
  const capped = capContextImages(messages, { perMessage: 2, perRequest: 2 });
  assert.equal(capped.dropped, 2);
  assert.deepEqual(images(capped.messages), ['img-c', 'img-d']);
});

test('no cap, or a request within the cap, leaves the context alone', () => {
  const messages = screenshots(3);
  assert.equal(capContextImages(messages, {}), undefined);
  assert.equal(capContextImages(messages, { perRequest: 3, perMessage: 3 }), undefined);
});

test("a model's declared cap comes first; the pool fills a missing per-request cap", () => {
  const env = {
    FARMSLOT_PI_ROUTER_ID: 'localsparks',
    FARMSLOT_PI_ROUTER_MAX_IMAGES: '50',
    FARMSLOT_PI_ROUTER_MODEL_LIMITS: JSON.stringify({ 'GLM-5.3-Flash-s12': { maxImages: 20 } }),
  };
  const caps = (model) => piModelImageCaps(model, env);
  const sparks = { provider: 'localsparks', id: 'GLM-5.3-Flash-s1234' };
  // A static-only model, or one whose source discovery failed, declares nothing.
  assert.deepEqual(caps(sparks), { perRequest: 50, perMessage: undefined });
  assert.equal(caps({ ...sparks, id: 'GLM-5.3-Flash-s12' }).perRequest, 20);
  assert.equal(caps({ ...sparks, inputLimits: { images: { maxPerRequest: 8 } } }).perRequest, 8);
  // A static entry that declares only resize or a per-message cap keeps the pool's request cap.
  assert.equal(
    caps({ ...sparks, inputLimits: { images: { resize: { maxWidth: 1568 } } } }).perRequest,
    50,
  );
  assert.deepEqual(caps({ ...sparks, inputLimits: { images: { maxPerMessage: 20 } } }), {
    perRequest: 50,
    perMessage: 20,
  });
  // Another provider takes nothing from the router settings.
  assert.deepEqual(caps({ provider: 'anthropic', id: 'claude' }), {
    perRequest: undefined,
    perMessage: undefined,
  });
  assert.deepEqual(piModelImageCaps(undefined, env), {
    perRequest: undefined,
    perMessage: undefined,
  });
});

const modelsFetch = (id) => async () =>
  new Response(JSON.stringify({ data: [{ id }] }), {
    headers: { 'content-type': 'application/json' },
  });

test('a source max-images setting, or a model limit, caps its discovered models', async () => {
  const router = { FARMSLOT_PI_OLLAMA: '0', FARMSLOT_PI_ROUTER_URL: 'http://router.test' };
  const [provider] = await resolvePiProviderCatalog(
    { ...router, FARMSLOT_PI_ROUTER_ID: 'localsparks', FARMSLOT_PI_ROUTER_MAX_IMAGES: '50' },
    { fetchImpl: modelsFetch('GLM-5.3-Flash-s1234') },
  );
  assert.deepEqual(provider.models[0].inputLimits, { images: { maxPerRequest: 50 } });
  // Registration keeps the cap for the provider and its router alias.
  assert.deepEqual(piSdkModels(provider.models)[0].inputLimits, provider.models[0].inputLimits);
  const [overridden] = await resolvePiProviderCatalog(
    {
      ...router,
      FARMSLOT_PI_ROUTER_MAX_IMAGES: '50',
      FARMSLOT_PI_ROUTER_MODEL_LIMITS: JSON.stringify({ 'GLM-5.3-Flash-s12': { maxImages: 20 } }),
    },
    { fetchImpl: modelsFetch('GLM-5.3-Flash-s12') },
  );
  assert.equal(overridden.models[0].inputLimits.images.maxPerRequest, 20);
  const [uncapped] = await resolvePiProviderCatalog(router, { fetchImpl: modelsFetch('model') });
  assert.equal(uncapped.models[0].inputLimits, undefined);
  for (const [name, value] of [
    ['FARMSLOT_PI_ROUTER_MAX_IMAGES', 'many'],
    ['FARMSLOT_PI_ROUTER_MODEL_LIMITS', JSON.stringify({ model: { maxImages: 0 } })],
  ])
    await assert.rejects(
      resolvePiProviderCatalog({ ...router, [name]: value }, { fetchImpl: modelsFetch('model') }),
      new RegExp(name),
    );
});

async function checkHook(extensionUrl) {
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
    FARMSLOT_PI_ROUTER_ID: 'localsparks',
    FARMSLOT_PI_ROUTER_MAX_IMAGES: '50',
  };
  const system = { role: 'system', content: '', sections: { preamble: 'prompt' } };
  const shots = Array.from({ length: 51 }, (_, n) => ({
    role: 'toolResult',
    toolCallId: `t${n}`,
    toolName: 'read',
    content: [{ type: 'image', data: `img-${n}`, mimeType: 'image/png' }],
  }));
  const messages = [system, ...shots];
  const count = (list) =>
    list
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block.type === 'image').length;
  try {
    await install({ on: (name, handler) => events.set(name, handler) });
    assert.equal(events.has('context'), false, 'the trim does not rewrite the system messages');
    const hook = events.get('context_with_system');
    // The selected model declares no cap: the pool's router setting applies.
    const model = { provider: 'localsparks', id: 'GLM-5.3-Flash-s1234' };
    const capped = await hook({ type: 'context_with_system', messages }, { model });
    assert.equal(count(capped.messages), 41);
    assert.equal(capped.messages[0], system, 'the leading system message is kept as it was');
    assert.equal(capped.messages.length, messages.length);
    assert.equal(
      await hook(
        { type: 'context_with_system', messages },
        { model: { provider: 'xai', id: 'grok' } },
      ),
      undefined,
      'a model without an image cap keeps the context unchanged',
    );
  } finally {
    await events.get('session_shutdown')?.({});
    rmSync(root, { recursive: true, force: true });
  }
}

test('the pi observability extension trims each request to the selected model cap', () => {
  const extension = new URL('./pi-farmslot-observability.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `await (${checkHook.toString()})(${JSON.stringify(extension)});`,
    ],
    { encoding: 'utf8', timeout: 8000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /\[farmslot-pi\] image cap \{"dropped":10,"images":51\}/);
});
