import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { readCodexProcessTurnState } = await import('./codex-observability.js');
const { makeVars } = await import('./test-fixtures.js');

function readers(state: 'active' | 'idle', replacement = false, ambiguous = false) {
  let processReads = 0;
  return {
    pane: async () => ({ paneId: '%1', panePid: '100' }),
    process: async () => ({
      state: 'present' as const,
      pid: replacement && ++processReads > 1 ? '201' : '200',
    }),
    exec: async (_vars: unknown, command: string): Promise<ExecResult> => {
      let stdout: string;
      if (command.includes('LSOF_BIN=')) {
        stdout = 'p200\nn/tmp/rollout-owned.jsonl\n';
      } else if (command.includes('requested_paths =')) {
        assert.match(command, /root_only = True/);
        stdout = JSON.stringify(
          ambiguous
            ? { status: 'unavailable' }
            : { status: 'matched', sessionId: 'owned', sessionPath: '/tmp/rollout-owned.jsonl' },
        );
      } else {
        stdout = JSON.stringify({ status: 'matched', state, turnId: 'turn-1', observedAt: 1000 });
      }
      return { exitCode: 0, stdout, stderr: '' };
    },
  };
}

test('hookless Codex native turns distinguish idle from active for a session-only reviewer', async () => {
  for (const state of ['idle', 'active'] as const) {
    const observed = await readCodexProcessTurnState(
      makeVars(),
      'review-owned',
      'owned:turn-1',
      readers(state),
    );
    assert.equal(observed?.value, state);
    assert.equal(observed?.sessionId, 'owned');
    assert.equal(observed?.turnToken, 'owned:turn-1');
    assert.equal(observed?.confidence, 'high');
  }
});

test('hookless idle cannot survive a process replacement, ambiguous root or foreign session', async () => {
  for (const [expected, source] of [
    ['owned:turn-1', readers('idle', true)],
    ['owned:turn-1', readers('idle', false, true)],
    ['foreign:turn-1', readers('idle')],
  ] as const) {
    assert.equal(
      await readCodexProcessTurnState(makeVars(), 'review-owned', expected, source),
      null,
    );
  }
});
