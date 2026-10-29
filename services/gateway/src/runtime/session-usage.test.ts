import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeRun } from '../run-completion/test-fixtures.js';
import { piSessionUsageProvider } from '../runners/session-usage-provider.js';
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
  assert.equal(usage?.costUsd, 31.8);
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
