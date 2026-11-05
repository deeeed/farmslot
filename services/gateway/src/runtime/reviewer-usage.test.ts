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
