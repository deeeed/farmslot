import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { type PiModelCostMetadata, runSessionUsage } from './session-usage.js';

const fixture = fileURLToPath(new URL('../test/fixtures/pi-session.jsonl', import.meta.url));

test('Pi extraction keeps tokens but rejects unquoted LiteLLM SDK cost', async () => {
  const output = await runSessionUsage({
    repo: '',
    slotId: 'pi-test',
    action: 'total',
    forcedPath: fixture,
    forcedRunner: 'pi',
    environment: {},
  });
  assert.match(output, /turns=3\n/);
  assert.match(output, /input_tokens=8\n/);
  assert.match(output, /output_tokens=742\n/);
  assert.match(output, /cache_creation=38822\n/);
  assert.match(output, /cache_read=58613\n/);
  assert.match(output, /total_tokens=98185\n/);
  assert.doesNotMatch(output, /cost_usd=/);
  assert.match(output, /cost_reason=No verified model price/);
});

test('Pi without a price quote preserves missing cost and rejects absent usage', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const records = (await readFile(fixture, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  delete records[2].message.usage.cost;
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const output = await runSessionUsage({
    repo: '',
    slotId: 'pi-test',
    action: 'total',
    forcedPath: file,
    forcedRunner: 'pi',
    environment: {},
  });
  assert.doesNotMatch(output, /cost_usd=/);
  await writeFile(file, JSON.stringify(records[0]) + '\n');
  await assert.rejects(
    runSessionUsage({
      repo: '',
      slotId: 'pi-test',
      action: 'total',
      forcedPath: file,
      forcedRunner: 'pi',
      environment: {},
    }),
    /no assistant usage/,
  );
});

test('unknown provider pricing cannot turn Pi SDK placeholder zeros into a complete cost', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-pricing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const header = {
    type: 'custom',
    customType: 'farmslot-model-request',
    data: { provider: 'litellm', model: 'model', cost: null },
  };
  const message = {
    type: 'message',
    message: {
      role: 'assistant',
      provider: 'litellm',
      model: 'model',
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0, totalFromProvider: false },
      },
    },
  };
  const summarize = async (
    pricing: PiModelCostMetadata | null | undefined,
    usage: Record<string, unknown>,
  ) => {
    await writeFile(
      file,
      [
        JSON.stringify({ ...header, data: { ...header.data, cost: pricing } }),
        JSON.stringify({ ...message, message: { ...message.message, usage } }),
      ].join('\n') + '\n',
    );
    return runSessionUsage({
      repo: '',
      slotId: 'pi-pricing',
      action: 'total',
      forcedPath: file,
      forcedRunner: 'pi',
      environment: {},
    });
  };
  assert.doesNotMatch(await summarize(null, message.message.usage), /cost_usd=/);
  const free = { input: 0, output: 0, cacheRead: null, cacheWrite: null };
  assert.match(await summarize(free, message.message.usage), /cost_usd=0\.0000/);
  assert.doesNotMatch(
    await summarize(free, { ...message.message.usage, cacheRead: 20 }),
    /cost_usd=/,
  );
  assert.match(
    await summarize(null, {
      ...message.message.usage,
      cost: { total: 0, totalFromProvider: true },
    }),
    /cost_usd=0\.0000/,
  );
  assert.match(
    await summarize(null, {
      ...message.message.usage,
      cost: { total: 0.0176, totalFromProvider: true },
    }),
    /cost_usd=0\.0176/,
  );
  assert.doesNotMatch(await summarize(undefined, message.message.usage), /cost_usd=/);
  assert.match(
    await summarize(undefined, { ...message.message.usage, cost: { total: 0.0176 } }),
    /cost_usd=0\.0176/,
  );
  const paid = { input: 2, output: 8, cacheRead: null, cacheWrite: null };
  assert.doesNotMatch(await summarize(paid, message.message.usage), /cost_usd=/);
  assert.match(
    await summarize(paid, { ...message.message.usage, cost: { total: 0.00028 } }),
    /cost_usd=0\.0002800000/,
  );
  const noUsage = { ...message.message.usage, input: 0, output: 0 };
  assert.doesNotMatch(await summarize(paid, noUsage), /cost_usd=/);
  assert.match(
    await summarize(paid, { ...noUsage, cost: { total: 0, totalFromProvider: true } }),
    /cost_usd=0\.0000/,
  );
  assert.doesNotMatch(
    await summarize(paid, { ...message.message.usage, cacheRead: 20, cost: { total: 0.00028 } }),
    /cost_usd=/,
  );
  const { cost: _cost, ...unpricedUsage } = message.message.usage;
  assert.doesNotMatch(await summarize(paid, unpricedUsage), /cost_usd=/);
  const tiered = { ...paid, input: null, tiers: [{ ...paid, input: 4, inputTokensAbove: 200000 }] };
  assert.doesNotMatch(
    await summarize(tiered, { ...message.message.usage, input: 200000, cost: { total: 0.8 } }),
    /cost_usd=/,
  );
  assert.match(
    await summarize(tiered, { ...message.message.usage, input: 200001, cost: { total: 0.800084 } }),
    /cost_usd=0\.8000840000/,
  );
  assert.doesNotMatch(
    await summarize(
      { ...paid, reasoningOutput: 20 },
      { ...message.message.usage, cost: { total: 0.00028 } },
    ),
    /cost_usd=/,
  );
  assert.doesNotMatch(
    await summarize(
      { ...paid, cacheWrite1h: 0.2 },
      { ...message.message.usage, cacheWrite: 20, cacheWrite1h: 20, cost: { total: 0.00036 } },
    ),
    /cost_usd=/,
  );
  assert.match(
    await summarize(
      { ...paid, cacheWrite1h: 4 },
      { ...message.message.usage, cacheWrite: 20, cacheWrite1h: 20, cost: { total: 0.00036 } },
    ),
    /cost_usd=0\.0003600000/,
  );
});

test('a tmux Pi receipt quotes gateway LiteLLM rates only through the request entry it answers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const gateway = 'sha256:gateway-endpoint';
  // Pi's own catalog rates for the request; the SDK total below is quoted from them.
  const catalog = { input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0 };
  const request = (id: string, endpoint?: string) => ({
    type: 'custom',
    customType: 'farmslot-model-request',
    id,
    parentId: 'u1',
    data: {
      provider: 'litellm',
      model: 'glm',
      cost: catalog,
      ...(endpoint ? { endpoint } : {}),
    },
  });
  const turn = (
    id: string,
    parentId: string,
    cost: Record<string, unknown> = { total: 0.0002 },
  ) => ({
    type: 'message',
    id,
    parentId,
    message: {
      role: 'assistant',
      provider: 'litellm',
      model: 'glm',
      usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost },
    },
  });
  const user = { type: 'message', id: 'u1', parentId: null, message: { role: 'user' } };
  // Gateway rates differ from Pi's catalog, so a quote shows which list priced the turn.
  const route = {
    endpointId: gateway,
    prices: new Map<string, PiModelCostMetadata>([
      ['glm', { input: 1, output: 2, cacheRead: null, cacheWrite: null }],
    ]),
  };
  const summarize = async (records: unknown[], options: Record<string, unknown>) => {
    await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    return runSessionUsage({
      repo: '',
      slotId: 'pi-route',
      action: 'total',
      forcedPath: file,
      forcedRunner: 'pi',
      environment: {},
      ...options,
    });
  };
  const bound = [user, request('r1', gateway), turn('a1', 'r1')];
  // Matched: the request entry recorded the gateway's endpoint. (1000 * 1 + 100 * 2) / 1e6.
  assert.match(await summarize(bound, { liteLlmRoute: route }), /cost_usd=0\.0012000000/);
  // Wrong route: the request went to another endpoint. Tokens kept, cost unpriced.
  const wrong = await summarize([user, request('r1', 'sha256:other'), turn('a1', 'r1')], {
    liteLlmRoute: route,
  });
  assert.match(wrong, /total_tokens=1100/);
  assert.doesNotMatch(wrong, /cost_usd=/);
  // Unsupported: no request entry (Pi's own route, outside the Farmslot catalog), or one without
  // an endpoint digest (an older extension).
  for (const records of [
    [user, turn('a1', 'u1')],
    [user, request('r1'), turn('a1', 'r1')],
  ]) {
    const unpriced = await summarize(records, { liteLlmRoute: route });
    assert.match(unpriced, /total_tokens=1100/);
    assert.doesNotMatch(unpriced, /cost_usd=/);
  }
  // Mixed: one bound turn and one unsupported turn leave the receipt unpriced.
  assert.doesNotMatch(
    await summarize([...bound, turn('a2', 'a1')], { liteLlmRoute: route }),
    /cost_usd=/,
  );
  // A provider-reported charge is kept on any route.
  assert.match(
    await summarize([user, turn('a1', 'u1', { total: 0.0042, totalFromProvider: true })], {
      liteLlmRoute: route,
    }),
    /cost_usd=0\.0042000000/,
  );
  // Without a route binding (native workspaces, workers), gateway prices apply as before.
  assert.match(
    await summarize([user, request('r1', 'sha256:other'), turn('a1', 'r1')], {
      liteLlmPrices: route.prices,
    }),
    /cost_usd=0\.0012000000/,
  );
});
