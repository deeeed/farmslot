import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskLiveSpend } from '@farmslot/protocol';

import { formatSpendUsd, liveSpendSummary, openStepSpend, stepSpend } from './live-spend.js';

const spend: TaskLiveSpend = {
  runner: 'pi',
  readAt: '2026-11-16T00:00:00.000Z',
  totalTokens: 31_094_588,
  costUsd: 0.347207,
  compactions: 0,
  toolCalls: 258,
  steps: [
    {
      segment: 'before-first-mark',
      stepNumber: 1,
      startedAt: '2026-11-16T00:00:00.000Z',
      endedAt: '2026-11-16T00:01:00.000Z',
      wallMs: 60_000,
      toolCalls: 50,
      toolCallsByName: { bash: 50 },
      totalTokens: 1_073_626,
      costUsd: 0.026766,
      compactions: 0,
    },
    {
      segment: 'after-last-mark',
      startedAt: '2026-11-16T00:01:00.000Z',
      endedAt: '2026-11-16T00:02:00.000Z',
      wallMs: 60_000,
      toolCalls: 2,
      toolCallsByName: { bash: 2 },
      totalTokens: 9_000,
      costUsd: 0.0009,
      compactions: 0,
    },
  ],
};

test('spent so far and per-step cost read the live spend, unknown prices stay unknown', () => {
  assert.equal(formatSpendUsd(0.026766), '$0.0268');
  assert.equal(formatSpendUsd(12.5), '$12.50');
  assert.equal(formatSpendUsd(null), '—');
  const summary = liveSpendSummary(spend)!;
  assert.deepEqual([summary.cost, summary.tokens, summary.toolCalls], ['$0.35', '31.1M', '258']);
  assert.equal(stepSpend(spend, 1)?.cost, '$0.0268');
  assert.equal(stepSpend(spend, 2), null, 'a step not reached has no cost yet');
  assert.equal(openStepSpend(spend)?.cost, '$0.0009');
  assert.match(liveSpendSummary({ ...spend, costUsd: null })!.title, /cost unknown/);
  assert.match(liveSpendSummary({ ...spend, behindBytes: 4096 })!.note ?? '', /bytes to go/);
  // Before the first mark there are no steps: the running step shows the whole session so far.
  assert.equal(openStepSpend({ ...spend, steps: [] })?.cost, '$0.35');
});
