import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeRun } from '../run-completion/test-fixtures.js';
import {
  claudeSessionUsageProvider,
  piSessionUsageProvider,
} from '../runners/session-usage-provider.js';
import { makeVars } from '../runners/test-fixtures.js';

import { extractRunWorkerSessionUsage, parseSessionUsageOutput } from './session-usage.js';

test('parseSessionUsageOutput normalizes runner session cost fields', () => {
  const usage = parseSessionUsageOutput(
    `
Session:  abc123
Runner:   codex
---
turns=4
model=gpt-5.5
input_tokens=1200
output_tokens=345
cache_creation=0
cache_read=50
reasoning_output_tokens=22
total_tokens=1617
cost_usd=0.0123
`,
    {
      runner: 'codex',
      runnerSessionId: 'abc123',
      runnerSessionPath: '/tmp/abc123.jsonl',
    },
  );

  assert.equal(usage.source, 'runner-transcript');
  assert.equal(usage.scope, 'session-total');
  assert.equal(usage.runner, 'codex');
  assert.equal(usage.runnerSessionId, 'abc123');
  assert.equal(usage.actualModel, 'gpt-5.5');
  assert.equal(usage.turns, 4);
  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.outputTokens, 345);
  assert.equal(usage.cacheRead, 50);
  assert.equal(usage.reasoningOutputTokens, 22);
  assert.equal(usage.totalTokens, 1617);
  assert.equal(usage.costUsd, 0.0123);
  assert.match(usage.measuredAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('extractRunnerSessionUsage returns unavailable when runner has no transcript path', async () => {
  const { extractRunnerSessionUsage } = await import('./session-usage.js');
  const usage = await extractRunnerSessionUsage({
    slotId: 'slot-1',
    runner: 'cursor',
    runnerSessionId: null,
    runnerSessionPath: null,
  });

  assert.equal(usage.source, 'unavailable');
  assert.equal(usage.runner, 'cursor');
  assert.match(usage.error ?? '', /did not expose/);
});

test('Pi worker rollup counts the initial session and both fix rounds once', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-worker-rollup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Native assistant usage totals from the three sessions in the reported run.
  const usages = [
    {
      input: 314,
      output: 137552,
      cacheRead: 36878019,
      cacheWrite: 1020272,
      cost: { total: 22.6048636 },
    },
    {
      input: 170,
      output: 52756,
      cacheRead: 8147976,
      cacheWrite: 458403,
      cost: { total: 6.6070054 },
    },
    {
      input: 116,
      output: 23606,
      cacheRead: 4192117,
      cacheWrite: 87740,
      cost: { total: 2.5881308 },
    },
  ];
  const sessions = await Promise.all(
    usages.map(async (usage, index) => {
      const runnerSessionPath = path.join(root, `${index}.jsonl`);
      await writeFile(
        runnerSessionPath,
        JSON.stringify({
          type: 'message',
          message: { role: 'assistant', model: 'test-model', usage },
        }) + '\n',
      );
      return {
        contextId: index ? 'review-fix' : 'dev',
        runnerSessionId: `${index}`,
        runnerSessionPath,
      };
    }),
  );
  t.mock.method(piSessionUsageProvider, 'recoverSessions', async () => [...sessions, sessions[1]]);
  const run = makeRun({
    flowType: 'dev',
    slotId: 'test-slot',
    metrics: {
      nudgeCount: 0,
      runner: 'pi',
      model: 'test-model',
      sessionTotalTokens: 38036157,
      sessionTurns: 156,
      costEstimate: 22.6049,
    },
  });
  const usage = await extractRunWorkerSessionUsage(run, makeVars());
  assert.equal(usage?.totalTokens, 50999041);
  assert.equal(usage?.costUsd, 31.7999998);
  assert.equal(usage?.turns, 3);
  assert.equal(run.metrics.sessionTotalTokens, 38036157, 'reading does not rewrite stored metrics');
  await writeFile(
    sessions[2].runnerSessionPath,
    JSON.stringify({
      type: 'message',
      message: { role: 'assistant', usage: { input: 1, output: 2 } },
    }) + '\n',
  );
  assert.equal((await extractRunWorkerSessionUsage(run, makeVars()))?.costUsd, null);
});

test('Claude historical rollup deduplicates message blocks and session references without changing stored totals', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-worker-rollup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = path.join(root, 'initial.jsonl');
  const fixed = path.join(root, 'fix.jsonl');
  const assistant = (id: string, cache: number) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        id,
        model: 'claude-opus-5-5',
        usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: cache },
      },
    });
  await writeFile(
    initial,
    assistant('message-initial', 100) + '\n' + assistant('message-initial', 100) + '\n',
  );
  await writeFile(fixed, assistant('message-fix', 200) + '\n');
  const sessions = [initial, fixed, initial].map((runnerSessionPath, index) => ({
    contextId: index === 1 ? 'review-fix' : 'fix-bug',
    runnerSessionId: path.basename(runnerSessionPath),
    runnerSessionPath,
  }));
  t.mock.method(claudeSessionUsageProvider, 'recoverSessions', async () => sessions);
  const run = makeRun({
    flowType: 'fix-bug',
    slotId: 'test-slot',
    metrics: {
      nudgeCount: 0,
      runner: 'claude',
      model: 'opus',
      sessionTurns: 3,
      sessionTotalTokens: 418,
    },
  });
  const usage = await extractRunWorkerSessionUsage(run, makeVars());
  assert.equal(usage?.turns, 2);
  assert.equal(usage.totalTokens, 312);
  assert.equal(usage.costUsd, 0.000296);
  assert.equal(run.metrics.sessionTurns, 3, 'historical reads preserve stored data');
});

test('local accounting uses pool LiteLLM pricing environment and preserves precise USD', async (t) => {
  const { extractRunnerSessionUsage } = await import('./session-usage.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'litellm-pool-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  await writeFile(
    file,
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        provider: 'litellm',
        model: 'fixture-model',
        usage: {
          input: 4,
          output: 4,
          cacheRead: 38195,
          cacheWrite: 0,
          cost: { total: 0 },
        },
      },
    }) + '\n',
  );
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://pool.example/v1/model/info');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer pool-fixture-key');
    return Response.json({
      data: [
        {
          model_name: 'fixture-model',
          model_info: {
            input_cost_per_token: 0.000002,
            output_cost_per_token: 0.00001,
            cache_read_input_token_cost: 0.0000002,
            cache_creation_input_token_cost: 0.0000025,
          },
        },
      ],
    });
  });
  const usage = await extractRunnerSessionUsage({
    slotId: 'synthetic-local',
    runner: 'pi',
    runnerSessionPath: file,
    vars: makeVars({
      host: '127.0.0.1',
      machineEnv: {
        LITELLM_URL: 'https://pool.example/v1',
        LITELLM_API_KEY: 'pool-fixture-key',
        FARMSLOT_LITELLM_PRICING_CACHE_DIR: root,
      },
    }),
  });
  assert.equal(usage.costUsd, 0.007687);
  assert.equal(usage.cacheRead, 38195);
  const local = parseSessionUsageOutput('total_tokens=10\ncost_reason=local, unpriced\n');
  assert.equal(local.costUsd, null);
  assert.equal(local.costReason, 'local, unpriced');
  assert.equal(local.costStatus, 'unpriced');
  const { recoveredWorkerSessionReceipt } = await import('./agent-session-rows.js');
  const recovered = recoveredWorkerSessionReceipt(
    makeRun({ flowType: 'dev' }),
    { runnerSessionId: 'synthetic-local', runnerSessionPath: file, contextId: 'dev' },
    local,
  );
  assert.equal(recovered.costReason, 'local, unpriced');
});

test('one missing native boundary retains successful sibling session receipts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'partial-worker-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runnerSessionPath = path.join(root, 'valid.jsonl');
  await writeFile(
    runnerSessionPath,
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        model: 'fixture',
        usage: { input: 20, output: 5, cost: { total: 0.1 } },
      },
    }) + '\n',
  );
  t.mock.method(piSessionUsageProvider, 'recoverSessions', async () => [
    {
      contextId: 'missing',
      runnerSessionId: 'missing',
      runnerSessionPath: path.join(root, 'missing.jsonl'),
    },
    { contextId: 'valid', runnerSessionId: 'valid', runnerSessionPath },
  ]);
  const run = makeRun({
    slotId: 'fixture-slot',
    metrics: { nudgeCount: 0, runner: 'pi', model: 'fixture' },
  });
  run.sessionUsage = [
    {
      runner: 'pi',
      runnerSessionId: 'missing',
      source: 'unavailable',
      measuredAt: run.createdAt,
      nativeSession: {
        sessionId: 'host',
        ownerPrincipalId: 'owner',
        executionNodeId: 'fixture-node',
      },
    },
  ];
  const receipts: import('@farmslot/protocol').RunnerSessionUsage[] = [];
  const result = await extractRunWorkerSessionUsage(run, makeVars(), (_session, usage) =>
    receipts.push(usage),
  );
  assert.equal(result?.source, 'unavailable');
  assert.equal(receipts.length, 2);
  assert.match(receipts[0].error ?? '', /task lease boundary/);
  assert.equal(receipts[1].totalTokens, 25);
});
