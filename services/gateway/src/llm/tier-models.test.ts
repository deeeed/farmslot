import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { llmConfigGet, llmConfigSet } from '../methods/llm-config.js';

import { CODEX_LB_BASE_URL } from './codex-lb.js';
import { getLLMConfig, invalidateLLMConfig, setLLMConfig } from './config.js';
import { callLLM, describeModel, piModels, resolveTier } from './index.js';

/** A private FARMSLOT_HOME whose llm-config.json the test owns. */
function isolatedHome(t: TestContext): string {
  const home = mkdtempSync(path.join(tmpdir(), 'llm-tier-models-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  invalidateLLMConfig();
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    invalidateLLMConfig();
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('a configured tier model replaces the built-in id for that provider only', (t) => {
  isolatedHome(t);
  assert.equal(resolveTier('codex-lb', 'fast'), 'gpt-6.2-astra', 'defaults are unchanged');
  setLLMConfig({ tierModels: { 'codex-lb': { fast: 'gpt-5.6-terra', standard: 'gpt-6-luna' } } });
  assert.equal(resolveTier('codex-lb', 'fast'), 'gpt-5.6-terra');
  assert.equal(resolveTier('codex-lb', 'standard'), 'gpt-6-luna');
  assert.equal(resolveTier('codex-lb', 'smart'), 'gpt-6.2-astra', 'an unset tier keeps its id');
  assert.equal(resolveTier('anthropic', 'fast'), 'haiku', 'other providers keep the map');
  assert.equal(resolveTier('codex-lb', 'gpt-6-astra'), 'gpt-6-astra', 'explicit ids pass through');
  assert.equal(
    describeModel('codex-lb', 'standard'),
    'codex-lb/gpt-6-luna (requested tier: standard)',
  );
});

test('tier overrides refuse unknown providers and tiers, unsafe ids and malformed maps', (t) => {
  const home = isolatedHome(t);
  const cases: Array<[unknown, RegExp]> = [
    [{ 'codex-lb': { fast: 'gpt-6-luna; touch /tmp/x' } }, /invalid model id for tierModels/],
    [{ 'codex-lb': { fast: '' } }, /invalid model id for tierModels/],
    [{ 'codex-lb': { fast: '--help' } }, /invalid model id for tierModels/],
    [{ 'codex-lb': { fast: 7 } }, /invalid model id for tierModels/],
    [{ 'codex-lb': { turbo: 'gpt-6-luna' } }, /unknown tier: turbo/],
    [{ 'not-a-provider': { fast: 'gpt-6-luna' } }, /unknown provider: not-a-provider/],
    [{ 'codex-lb': ['gpt-6-luna'] }, /must be an object of tier/],
    [['codex-lb'], /tierModels must be an object/],
  ];
  for (const [tierModels, pattern] of cases) {
    // The RPC receives untyped JSON; the setter must refuse it at runtime.
    assert.throws(() => setLLMConfig(JSON.parse(JSON.stringify({ tierModels }))), pattern);
  }
  assert.equal(getLLMConfig().tierModels, undefined, 'nothing refused was saved');
  // A hand-edited unsafe id is ignored on load, not routed; the valid entries beside it stay.
  writeFileSync(
    path.join(home, 'llm-config.json'),
    JSON.stringify({
      defaultProvider: 'codex-lb',
      tierModels: { 'codex-lb': { fast: 'a b', standard: 'gpt-6-luna' }, nope: { fast: 'x' } },
    }),
  );
  invalidateLLMConfig();
  assert.deepEqual(getLLMConfig().tierModels, { 'codex-lb': { standard: 'gpt-6-luna' } });
  assert.equal(resolveTier('codex-lb', 'fast'), 'gpt-6.2-astra');
  writeFileSync(path.join(home, 'llm-config.json'), JSON.stringify({ tierModels: 'codex-lb' }));
  invalidateLLMConfig();
  assert.equal(getLLMConfig().tierModels, undefined);
});

test('Settings round trip: llm.config.set saves the overrides llm.config.get returns', (t) => {
  const home = isolatedHome(t);
  setLLMConfig({ defaultProvider: 'anthropic' });
  llmConfigSet({
    defaultProvider: 'codex-lb',
    tierModels: { 'codex-lb': { fast: 'gpt-5.6-terra', standard: 'gpt-6-luna' } },
  });
  const read = llmConfigGet();
  assert.equal(read.defaultProvider, 'codex-lb');
  assert.deepEqual(read.tierModels, {
    'codex-lb': { fast: 'gpt-5.6-terra', standard: 'gpt-6-luna' },
  });
  // What Settings saved is what the next call resolves.
  assert.equal(describeModel('codex-lb', 'fast'), 'codex-lb/gpt-5.6-terra (requested tier: fast)');
  // The saved file survives a reload, and `{}` clears the overrides.
  invalidateLLMConfig();
  assert.equal(getLLMConfig().tierModels?.['codex-lb']?.fast, 'gpt-5.6-terra');
  llmConfigSet({ defaultProvider: 'anthropic', tierModels: {} });
  const stored = JSON.parse(readFileSync(path.join(home, 'llm-config.json'), 'utf8'));
  assert.deepEqual(stored.tierModels, {});
  assert.equal(stored.defaultProvider, 'anthropic');
  assert.equal(resolveTier('codex-lb', 'fast'), 'gpt-6.2-astra');
});

test('codex-lb routes configured terra and luna tiers to the LB with their effort', async (t) => {
  isolatedHome(t);
  // The model collection loads first, as in a running gateway: the tiers set after it must
  // route without a restart.
  const models = await piModels();
  assert.equal(models.getModel('codex-lb', 'gpt-6-luna'), undefined);
  setLLMConfig({
    defaultProvider: 'codex-lb',
    intelligenceEffort: 'low',
    tierModels: { 'codex-lb': { fast: 'gpt-5.6-terra', standard: 'gpt-6-luna' } },
  });
  const key = process.env.CODEX_LB_API_KEY;
  const fetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetch;
    if (key === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = key;
  });
  process.env.CODEX_LB_API_KEY = 'unit-lb-client-key';
  const seen: Array<{ url: string; model: unknown; effort: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body: unknown = await request.json();
    const field = (value: unknown, key: string): unknown =>
      typeof value === 'object' && value !== null && key in value
        ? Reflect.get(value, key)
        : undefined;
    seen.push({
      url: request.url,
      model: field(body, 'model'),
      effort: field(field(body, 'reasoning'), 'effort'),
    });
    return new Response(JSON.stringify({ error: { message: 'unit request observed' } }), {
      status: 418,
      headers: { 'content-type': 'application/json' },
    });
  };
  for (const model of ['fast', 'standard']) {
    await assert.rejects(callLLM({ model, userPrompt: 'OK', maxTokens: 16 }));
  }
  assert.deepEqual(seen, [
    { url: `${CODEX_LB_BASE_URL}/responses`, model: 'gpt-5.6-terra', effort: 'low' },
    { url: `${CODEX_LB_BASE_URL}/responses`, model: 'gpt-6-luna', effort: 'low' },
  ]);
  // Terra keeps PI's OpenAI catalog levels; luna, unknown to PI, gets the Astra shape. Only
  // `off` tells them apart: the catalog sends 'none', the Astra shape sends nothing.
  const terra = models.getModel('codex-lb', 'gpt-5.6-terra');
  const luna = models.getModel('codex-lb', 'gpt-6-luna');
  assert.equal(terra?.api, 'openai-responses');
  assert.equal(terra?.baseUrl, CODEX_LB_BASE_URL);
  assert.equal(terra?.thinkingLevelMap?.off, 'none');
  assert.equal(terra?.name, 'GPT-5.6 Terra');
  assert.equal(luna?.thinkingLevelMap?.off, null);
  assert.equal(luna?.reasoning, true);
  assert.equal(luna?.cost.input, 0, 'an LB call is never priced as an API charge');
  // Clearing the tier unregisters its id from the LB again, still without a restart.
  setLLMConfig({ tierModels: { 'codex-lb': { fast: 'gpt-5.6-terra' } } });
  assert.equal(models.getModel('codex-lb', 'gpt-6-luna'), undefined);
  setLLMConfig({ tierModels: {} });
  assert.equal(models.getModel('codex-lb', 'gpt-5.6-terra'), undefined);
  assert.ok(models.getModel('codex-lb', 'gpt-6.2-astra'), 'the built-in ids stay');
});
