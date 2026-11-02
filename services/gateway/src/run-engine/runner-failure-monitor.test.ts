import assert from 'node:assert/strict';
import test from 'node:test';

import '../runtime/mock-pty.test-support.js';

import {
  resolveMonitorStuckState,
  shouldDeliverStuckNudge,
} from '../runners/observability-progress.js';
import type {
  ObservabilityReading,
  RunnerSessionDeliveryState,
} from '../runners/observability-types.js';
import { makeVars } from '../runners/test-fixtures.js';

import { checkAgentLive } from './run-monitor.js';

const failure = 'OAuth refresh failed for anthropic: invalid_grant, refresh token expired';

test('a live Pi process with a terminal native auth error fails the monitor with its reason', async () => {
  const turn: ObservabilityReading<RunnerSessionDeliveryState> = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
    failure,
  };
  const readers = {
    slot: async () => makeVars(),
    target: async () => ({ target: 'fixture:dev', session: 'fixture' }),
    exec: async () => ({ exitCode: 0, stdout: '42\n', stderr: '' }),
    process: async () => ({ state: 'present' as const, pid: '99' }),
    turn: async () => turn,
  };
  await assert.rejects(checkAgentLive('fixture', 'pi', undefined, undefined, undefined, readers), {
    message: failure,
  });
});

// F328 ce1c5583: Pi's model stream dropped mid-turn ("terminated"); the worker stayed alive.
test('a Pi turn ended on a dropped model connection leaves the live worker monitored', async () => {
  const pane = (failureKind?: 'transport') => ({
    slot: async () => makeVars(),
    target: async () => ({ target: 'fixture:dev', session: 'fixture' }),
    exec: async () => ({ exitCode: 0, stdout: '42\n', stderr: '' }),
    process: async () => ({ state: 'present' as const, pid: '99' }),
    turn: async (): Promise<ObservabilityReading<RunnerSessionDeliveryState>> => ({
      value: 'idle',
      source: 'hook',
      confidence: 'high',
      observedAt: Date.now(),
      failure: 'terminated',
      ...(failureKind ? { failureKind } : {}),
    }),
  });
  assert.equal(
    await checkAgentLive('fixture', 'pi', undefined, undefined, undefined, pane('transport')),
    'working',
  );
  // Only the runner classifies its failure; unclassified text is a genuine failure.
  await assert.rejects(checkAgentLive('fixture', 'pi', undefined, undefined, undefined, pane()), {
    name: 'RunnerExecutionError',
    message: 'terminated',
  });
});

test('an idle Pi whose turn ended on a dropped model connection gets the stuck nudge', () => {
  const now = Date.now();
  const idle = { source: 'hook', confidence: 'high', observedAt: now - 60_000 } as const;
  const state = resolveMonitorStuckState({
    now,
    lastProgressAt: now - 20 * 60_000,
    stuckTimeoutMs: 15 * 60_000,
    activity: { ...idle, value: 'idle' },
    turnState: { ...idle, value: 'idle', failure: 'terminated', failureKind: 'transport' },
  });
  assert.equal(state.kind, 'idle');
  assert.equal(state.stuck, true);
  assert.equal(shouldDeliverStuckNudge(state.kind), true);
});
