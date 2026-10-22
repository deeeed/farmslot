import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claudeProcessRegistration,
  readClaudeProcessState,
} from './claude-process-observability.js';
import { makeVars } from './test-fixtures.js';

const registration = {
  pid: 42,
  sessionId: 'saved-review',
  startedAt: 1000,
  status: 'idle',
  statusUpdatedAt: 2000,
};

test('native registration binds pid generation and an explicit native turn state', () => {
  assert.deepEqual(claudeProcessRegistration(registration, '42', 900), {
    sessionId: 'saved-review',
    status: 'idle',
    observedAt: 2000,
  });
  for (const value of [
    { ...registration, pid: 43 },
    { ...registration, startedAt: 100 },
    { ...registration, status: 'unknown' },
    { ...registration, statusUpdatedAt: 500 },
    { ...registration, sessionId: '../foreign' },
  ])
    assert.equal(claudeProcessRegistration(value, '42', 900), null);
});

test('legacy native registration retains identity without claiming a timestamped observation', () => {
  const { statusUpdatedAt: _timestamp, ...legacy } = registration;
  assert.deepEqual(claudeProcessRegistration(legacy, '42', 900), {
    sessionId: 'saved-review',
    status: 'idle',
    observedAt: null,
  });
});

test('native process observation refuses a pane handoff or a replacement runner after its read', async () => {
  const vars = makeVars();
  for (const changed of ['none', 'pane', 'process', 'timestamp'] as const) {
    let probes = 0;
    let panes = 0;
    const state = await readClaudeProcessState(vars, 'review', {
      pane: async () => ({
        paneId: ++panes > 1 && changed === 'pane' ? '%other' : '%owned',
        panePid: '7',
      }),
      process: async () => ({
        state: 'present',
        pid: ++probes > 1 && changed === 'process' ? '43' : '42',
      }),
      exec: async () => ({
        stdout: JSON.stringify({
          record:
            changed === 'timestamp'
              ? { pid: 42, sessionId: 'saved-review', startedAt: 1000, status: 'idle' }
              : registration,
          processStartedAt: 900,
          sessionPath: '/sessions/saved-review.jsonl',
        }),
        stderr: '',
        exitCode: 0,
      }),
    });
    if (changed === 'none') assert.equal(state?.status, 'idle');
    else assert.equal(state, null);
  }
});
