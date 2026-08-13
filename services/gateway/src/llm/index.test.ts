import assert from 'node:assert/strict';
import test from 'node:test';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

import {
  callLLM,
  callLLMChat,
  ensureOAuthCredentialSeeded,
  fallbackDoneTextDelta,
  piCredentialStore,
  piModels,
  throwOnTransportStop,
  TIER_MAP,
} from './index.js';

const registryModels = builtinModels();
const getModelById = (provider: string, model: string): unknown =>
  registryModels.getModel(provider, model);

test('openai-codex tier defaults resolve to pi-ai registered model ids', () => {
  for (const tier of ['fast', 'standard', 'smart']) {
    const model = TIER_MAP[tier]?.['openai-codex'];
    assert.equal(typeof model, 'string');
    assert.ok(
      getModelById('openai-codex', model),
      `${tier} mapped to unregistered openai-codex model ${model}`,
    );
  }
});

test('streaming fallback emits done text only when deltas were absent', () => {
  assert.equal(fallbackDoneTextDelta('', 'final answer', 'stop'), 'final answer');
  assert.equal(fallbackDoneTextDelta('partial', 'final answer', 'stop'), null);
  assert.equal(fallbackDoneTextDelta('', 'tool preface', 'toolUse'), null);
  assert.equal(fallbackDoneTextDelta('', '', 'stop'), null);
});

test('throwOnTransportStop throws on transport stopReasons with provider context', () => {
  for (const [stopReason, expectedName] of [
    ['error', 'Error'],
    ['aborted', 'AbortError'],
  ]) {
    assert.throws(
      () =>
        throwOnTransportStop('openai-codex', 'standard', 'auth-profile', stopReason, 401, {
          'x-request-id': 'req-1',
        }),
      (err: Error) =>
        err.name === expectedName &&
        err.message.includes(`reason=${stopReason}`) &&
        err.message.includes('http=401') &&
        err.message.includes('x-request-id=req-1'),
    );
  }
});

test('throwOnTransportStop passes clean and truncation stopReasons through', () => {
  for (const stopReason of ['stop', 'length', 'toolUse', undefined]) {
    throwOnTransportStop('openai-codex', 'standard', 'auth-profile', stopReason, 200, undefined);
  }
});

test('callLLMChat surfaces faux transport errors and aborts in both branches', async () => {
  // Any non-empty key satisfies auth resolution; the faux provider never reads it.
  process.env.OPENAI_API_KEY ??= 'faux-test-key';
  const faux = fauxProvider({ provider: 'openai', models: [{ id: 'faux-chat-model' }] });
  (await piModels()).setProvider(faux.provider);
  const base = {
    provider: 'openai',
    model: 'faux-chat-model',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  // Transport error — streaming branch (terminal 'error' stream event).
  faux.setResponses([
    () => {
      throw new Error('upstream 500');
    },
  ]);
  await assert.rejects(
    callLLMChat({ ...base, onDelta: () => {} }),
    (err: Error) => err.name === 'Error' && err.message.includes('reason=error'),
  );

  // Transport error — non-streaming branch (errored AssistantMessage resolves).
  faux.setResponses([
    () => {
      throw new Error('upstream 500');
    },
  ]);
  await assert.rejects(
    callLLMChat(base),
    (err: Error) => err.name === 'Error' && err.message.includes('reason=error'),
  );

  // User abort must preserve AbortError identity for AbortSignal-aware callers.
  for (const extra of [{ onDelta: () => {} }, {}]) {
    const ac = new AbortController();
    ac.abort();
    faux.setResponses([fauxAssistantMessage('never delivered')]);
    await assert.rejects(
      callLLMChat({ ...base, signal: ac.signal, ...extra }),
      (err: Error) => err.name === 'AbortError' && err.message.includes('reason=aborted'),
    );
  }

  // Clean finish still resolves and surfaces stopReason.
  faux.setResponses([fauxAssistantMessage('ok')]);
  const result = await callLLMChat(base);
  assert.equal(result.text, 'ok');
  assert.equal(result.stopReason, 'stop');
});

test('callLLM can fail closed instead of using CLI fallback without API auth', async () => {
  await assert.rejects(
    callLLM({
      provider: '__no_api_auth_for_unit_test__',
      model: 'fast',
      userPrompt: 'classify',
      allowCliFallback: false,
    }),
    /CLI fallback disabled/,
  );
});

test('throwOnTransportStop includes the provider errorMessage when present', () => {
  assert.throws(
    () =>
      throwOnTransportStop(
        'openai-codex',
        'standard',
        'codex-cli:auth.json',
        'error',
        undefined,
        undefined,
        'Provider is not configured: openai-codex',
      ),
    (err: Error) => err.message.includes('message="Provider is not configured: openai-codex"'),
  );
});

test('oauth seeding writes a full bundle once and re-seeds only on rotation', async () => {
  const provider = `oauth-seed-test-${process.pid}`;
  // Partial bundles never seed — pi-ai requires access+refresh+expires.
  await ensureOAuthCredentialSeeded(provider, { access: 'a1' });
  assert.equal(await piCredentialStore.read(provider), undefined);

  await ensureOAuthCredentialSeeded(provider, { access: 'a1', refresh: 'r1', expires: 123 });
  assert.deepEqual(await piCredentialStore.read(provider), {
    type: 'oauth',
    access: 'a1',
    refresh: 'r1',
    expires: 123,
  });

  // Same access token → no rewrite (mutate the store to detect one).
  await piCredentialStore.modify(provider, async () => ({
    type: 'oauth',
    access: 'sentinel',
    refresh: 'r1',
    expires: 123,
  }));
  await ensureOAuthCredentialSeeded(provider, { access: 'a1', refresh: 'r1', expires: 123 });
  assert.deepEqual((await piCredentialStore.read(provider)) ?? {}, {
    type: 'oauth',
    access: 'sentinel',
    refresh: 'r1',
    expires: 123,
  });

  // Rotated access token → re-seed.
  await ensureOAuthCredentialSeeded(provider, { access: 'a2', refresh: 'r2', expires: 456 });
  assert.deepEqual(await piCredentialStore.read(provider), {
    type: 'oauth',
    access: 'a2',
    refresh: 'r2',
    expires: 456,
  });
  await piCredentialStore.delete(provider);
});
