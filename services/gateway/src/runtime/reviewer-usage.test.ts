import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunnerSessionUsage } from '@farmslot/protocol';

import { preferSessionUsage } from './reviewer-usage.js';

test('verified spend survives missing or shorter history, while a new conversation starts separately', () => {
  const previous: RunnerSessionUsage = {
    runner: 'claude',
    runnerSessionId: 'same',
    source: 'runner-transcript',
    totalTokens: 100,
    measuredAt: '2026-11-05T00:00:00Z',
  };
  const unavailable: RunnerSessionUsage = {
    ...previous,
    source: 'unavailable',
    totalTokens: undefined,
    measuredAt: '2026-11-05T01:00:00Z',
    error: 'missing history',
  };
  assert.equal(preferSessionUsage(previous, unavailable), previous);
  assert.equal(preferSessionUsage(previous, { ...previous, totalTokens: 50 }), previous);
  const later = { ...previous, measuredAt: '2026-11-05T01:00:00Z' };
  assert.equal(preferSessionUsage(previous, later), later);
  const different = { ...unavailable, runnerSessionId: 'new' };
  assert.equal(preferSessionUsage(previous, different), different);
});

test('direct provider counters remain verified when pricing is unknown', () => {
  const provider: RunnerSessionUsage = {
    runner: 'claude',
    runnerSessionId: 'same',
    source: 'provider-response',
    totalTokens: 200,
    measuredAt: '2026-11-05T01:00:00Z',
    costUsd: null,
    costStatus: 'unpriced',
    costReason: 'price unavailable',
  };
  const transcript: RunnerSessionUsage = {
    ...provider,
    source: 'runner-transcript',
    totalTokens: 100,
    measuredAt: '2026-11-05T00:00:00Z',
  };
  assert.equal(preferSessionUsage(transcript, provider), provider);
  assert.equal(
    preferSessionUsage(provider, { ...transcript, source: 'unavailable', error: 'missing' }),
    provider,
  );
});

test('the shared inventory includes unavailable rows while measured totals keep observed zero', async () => {
  const { allRunSessionUsageReceipts, runSessionUsageReceipts } =
    await import('./session-usage-selection.js');
  const { makeRun } = await import('../run-completion/test-fixtures.js');
  const run = makeRun({
    flowType: 'dev',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'fixture' },
  });
  run.sessionUsage = [
    {
      runner: 'codex',
      runnerSessionId: 'zero',
      role: 'dev',
      kind: 'agent',
      totalTokens: 0,
      costUsd: 0,
      costStatus: 'estimated',
      source: 'runner-transcript',
      measuredAt: '2026-11-05T00:00:00Z',
    },
    {
      runner: 'codex',
      runnerSessionId: 'missing',
      role: 'review-fix',
      kind: 'agent',
      totalTokens: null,
      costUsd: null,
      costStatus: 'unpriced',
      costReason: 'Source unavailable',
      source: 'unavailable',
      error: 'Source unavailable',
      measuredAt: '2026-11-05T00:00:00Z',
    },
  ];
  assert.equal(allRunSessionUsageReceipts(run).length, 2);
  assert.equal(runSessionUsageReceipts(run).length, 1);
  assert.equal(runSessionUsageReceipts(run)[0].totalTokens, 0);
  assert.equal(allRunSessionUsageReceipts(run)[1].costStatus, 'unpriced');
});

test('legacy result-only rows receive explicit pricing status at the shared projection boundary', async () => {
  const { allRunSessionUsageReceipts } = await import('./session-usage-selection.js');
  const { makeRun } = await import('../run-completion/test-fixtures.js');
  const run = makeRun({ flowType: 'dev' });
  const review = (
    id: string,
    costUsd: number | null,
  ): import('@farmslot/protocol').ReviewStatus => ({
    id,
    reviewerSessionId: id,
    reviewedHeadSha: 'head',
    source: 'pipeline',
    mode: 'cold',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    feedbackSent: false,
    runner: 'claude',
    model: 'fixture',
    usage: {
      runner: 'claude',
      runnerSessionId: id,
      source: 'runner-transcript',
      measuredAt: '2026-11-05T00:00:00Z',
      totalTokens: 10,
      costUsd,
    },
  });
  run.engineState = {
    publishGate: { reviews: [review('priced', 0.25), review('unpriced', null)] },
  };
  const rows = allRunSessionUsageReceipts(run);
  assert.equal(rows[0].costStatus, 'estimated');
  assert.equal(rows[0].costUsd, 0.25);
  assert.equal(rows[1].costStatus, 'unpriced');
  assert.equal(rows[1].costUsd, null);
  assert.ok(rows[1].costReason);
});
