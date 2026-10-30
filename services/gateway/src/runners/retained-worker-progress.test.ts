import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import { readRetainedWorkerProgressTarget } from './retained-worker-progress.js';
import { makeVars } from './test-fixtures.js';

const context: AgentContext = {
  runId: 'run-1',
  slotId: 'slot-1',
  id: 'fix-bug',
  role: 'fix-bug',
  label: 'Worker',
  status: 'waiting',
  runner: 'claude',
  target: { session: 'owned', window: 'bugfix', target: 'owned:bugfix', paneId: '%288' },
  runnerSessionId: 'saved-session',
  runnerSessionPath: '/tmp/saved-session.jsonl',
};
const vars = makeVars();

test('a successful pane census confirms a vanished worker without a rerun', async () => {
  for (const stdout of ['foreign\t%2\t201\n', 'owned\t%1\t101\n']) {
    const actual = await readRetainedWorkerProgressTarget(vars, context, {
      exec: async () => ({ exitCode: 0, stdout, stderr: '' }),
      probe: async () => ({ state: 'absent' }),
      binding: async () => assert.fail('no live worker to bind'),
    });
    assert.deepEqual(actual, { state: 'absent' });
  }
});

test('unreadable census, malformed output and a surviving saved pane remain unknown', async () => {
  for (const result of [
    { exitCode: 124, stdout: '', stderr: 'timeout' },
    { exitCode: 1, stdout: '', stderr: 'transport unavailable' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: 'owned\t%1\t\n', stderr: '' },
    { exitCode: 0, stdout: 'moved\t%288\t101\n', stderr: '' },
  ]) {
    const actual = await readRetainedWorkerProgressTarget(vars, context, {
      exec: async () => result,
      probe: async () => assert.fail('uncertain pane inventory must not imply absence'),
      binding: async () => assert.fail('no binding probe'),
    });
    assert.equal(actual.state, 'unknown');
  }
});

test('a resumed worker on a new pane must match the recorded conversation', async () => {
  for (const matches of [false, true]) {
    const actual = await readRetainedWorkerProgressTarget(vars, context, {
      exec: async () => ({ exitCode: 0, stdout: 'owned\t%1\t101\n', stderr: '' }),
      probe: async (_vars, pid, runner) => {
        assert.equal(pid, '101');
        assert.equal(runner, 'claude');
        return { state: 'present', pid: '202' };
      },
      binding: async (_vars, _runner, options) => {
        assert.equal(options.paneId, '%1');
        assert.equal(options.runnerPid, '202');
        assert.equal(options.expectedSessionId, context.runnerSessionId);
        assert.equal(options.expectedSessionPath, context.runnerSessionPath);
        return matches
          ? {
              ok: true,
              binding: {
                runnerSessionId: 'saved-session',
                runnerSessionPath: '/tmp/saved-session.jsonl',
                canonicalSessionPath: '/tmp/saved-session.jsonl',
                source: 'native',
              },
            }
          : { ok: false, reason: 'foreign conversation' };
      },
    });
    assert.equal(actual.state, matches ? 'present' : 'unknown');
    if (actual.state === 'present') assert.equal(actual.target, '%1');
    assert.equal(context.target?.paneId, '%288', 'observation does not rewrite run ownership');
  }
});

test('uncertain process liveness or a second live session cannot establish quiescence', async () => {
  for (const state of ['unknown', 'ambiguous'] as const) {
    const actual = await readRetainedWorkerProgressTarget(vars, context, {
      exec: async () => ({ exitCode: 0, stdout: 'owned\t%1\t101\nowned\t%2\t102\n', stderr: '' }),
      probe: async () =>
        state === 'unknown'
          ? { state: 'unknown', code: 'probe-timeout', reason: 'node busy' }
          : { state: 'present', pid: '202' },
      binding: async () => ({
        ok: true,
        binding: {
          runnerSessionId: 'saved-session',
          runnerSessionPath: '/tmp/saved-session.jsonl',
          canonicalSessionPath: '/tmp/saved-session.jsonl',
          source: 'native',
        },
      }),
    });
    assert.equal(actual.state, 'unknown');
  }
});
