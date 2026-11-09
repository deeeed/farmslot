import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { type PiModelCostMetadata, runSessionUsage } from './session-usage.js';

const fixture = fileURLToPath(new URL('../test/fixtures/pi-session.jsonl', import.meta.url));

test('Pi total extraction uses recorded tokens and cost from real assistant JSONL', async () => {
  const output = await runSessionUsage({
    repo: '',
    slotId: 'pi-test',
    action: 'total',
    forcedPath: fixture,
    forcedRunner: 'pi',
  });
  assert.match(output, /turns=3\n/);
  assert.match(output, /input_tokens=8\n/);
  assert.match(output, /output_tokens=742\n/);
  assert.match(output, /cache_creation=38822\n/);
  assert.match(output, /cache_read=58613\n/);
  assert.match(output, /total_tokens=98185\n/);
  assert.match(output, /cost_usd=0\.2324/);
});

test('Pi never estimates a missing native cost or reports absent usage as zero', async (t) => {
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
    /cost_usd=0\.0003/,
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
    /cost_usd=0\.8001/,
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
    /cost_usd=0\.0004/,
  );
});
