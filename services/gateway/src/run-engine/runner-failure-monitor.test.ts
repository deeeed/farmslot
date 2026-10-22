import assert from 'node:assert/strict';
import test from 'node:test';

import '../runtime/mock-pty.test-support.js';

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
