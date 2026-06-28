import assert from 'node:assert/strict';
import test from 'node:test';

import { __setLlmRecoveryCallerForTest, classifyWithLlm } from './llm-classify.js';
test('classifyWithLlm applies valid verdicts with wrapping-call cost', async (t) => {
  __setLlmRecoveryCallerForTest(async () => ({
    output: { category: 'infra', confidence: 'high' },
    costUsd: 0.0123,
  }));
  t.after(() => __setLlmRecoveryCallerForTest(null));
  const r = await classifyWithLlm('farmslot-farm', 'ECONNRESET');
  assert.equal(r?.verdict.category, 'infra');
  assert.equal(r?.costUsd, 0.0123);
});
test('classifyWithLlm demotes malformed action proposals to low-confidence warnings', async (t) => {
  __setLlmRecoveryCallerForTest(async () => ({
    output: { category: 'infra', confidence: 'high', proposedAction: { type: 'shell.exec' } },
    costUsd: 0.01,
  }));
  t.after(() => __setLlmRecoveryCallerForTest(null));
  const r = await classifyWithLlm('farmslot-farm', 'ECONNRESET');
  assert.equal(r?.verdict.confidence, 'low');
  assert.match(r?.verdict.warning ?? '', /not allowed/);
});
test('classifyWithLlm preserves provider cost reported on refinement failure', async (t) => {
  __setLlmRecoveryCallerForTest(async () => {
    throw { message: 'provider stopped', usage: { costUsd: 0.02 } };
  });
  t.after(() => __setLlmRecoveryCallerForTest(null));
  const r = await classifyWithLlm('farmslot-farm', 'ECONNRESET');
  assert.equal(r?.verdict.confidence, 'low');
  assert.equal(r?.costUsd, 0.02);
});
test('classifyWithLlm enforces timeout and aborts the provider signal', async (t) => {
  let aborted = false;
  __setLlmRecoveryCallerForTest(async ({ signal }) => {
    signal?.addEventListener('abort', () => {
      aborted = true;
    });
    return new Promise<never>(() => undefined);
  });
  t.after(() => __setLlmRecoveryCallerForTest(null));
  const startedAt = Date.now();
  const r = await classifyWithLlm('farmslot-farm', 'slow provider', { timeoutMs: 20 });
  assert.equal(r?.verdict.confidence, 'low');
  assert.equal(r?.verdict.warning, 'llm_refine_failed');
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 500);
});
