import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  buildFindRunnerDescendantPidCommand,
  resolvePersistedRunnerSessionBinding,
  resolveRunRetainedSessionBinding,
  retainedSessionSendOption,
} from './session-process.js';

const execFile = promisify(execFileCb);

test('runner descendant scan ignores the diagnostic wrapper after child exit', async () => {
  const wrapper = spawn(
    'bash',
    [
      '-c',
      [
        'false # codex --model gpt-5.5',
        '__farmslot_status=$?',
        'if [ "$__farmslot_status" -ne 0 ]; then',
        '  echo "[farmslot] runner launch command exited $__farmslot_status; preserving pane for diagnostics" >&2',
        '  sleep 30',
        'fi',
      ].join('\n'),
    ],
    { stdio: 'ignore' },
  );

  try {
    await sleep(100);
    const command = buildFindRunnerDescendantPidCommand(String(process.pid), 'codex');
    await assert.rejects(execFile('bash', ['-lc', command]), /Command failed/);
  } finally {
    wrapper.kill('SIGKILL');
  }
});

test('persisted runner session binding selects id and path from one source', () => {
  assert.deepEqual(
    resolvePersistedRunnerSessionBinding([
      { label: 'context' },
      {
        label: 'parent metrics',
        runnerSessionId: ' session-parent ',
        runnerSessionPath: ' /sessions/parent.jsonl ',
      },
      {
        label: 'requesting metrics',
        runnerSessionId: 'session-requesting',
        runnerSessionPath: '/sessions/requesting.jsonl',
      },
    ]),
    {
      binding: {
        runnerSessionId: 'session-parent',
        runnerSessionPath: '/sessions/parent.jsonl',
      },
      reason: null,
    },
  );
});

test('persisted runner session binding rejects a partial higher-priority source', () => {
  assert.deepEqual(
    resolvePersistedRunnerSessionBinding([
      { label: 'context', runnerSessionId: 'session-context' },
      {
        label: 'parent metrics',
        runnerSessionId: 'session-parent',
        runnerSessionPath: '/sessions/parent.jsonl',
      },
    ]),
    {
      binding: null,
      reason: 'context has incomplete retained session metadata',
      incompleteBinding: true,
    },
  );
});

test('run retained session binding marks a missing agent context as safe for fresh delivery', () => {
  const result = resolveRunRetainedSessionBinding(
    {
      metrics: {
        runnerSessionId: 'metrics-session',
        runnerSessionPath: '/sessions/metrics.jsonl',
      },
      agentContexts: [],
    },
    null,
  );

  // An absent context record carries no half identity, so callers may deliver
  // through the fresh post-launch contract instead of failing closed.
  assert.equal(result.binding, null);
  assert.equal(result.incompleteBinding, undefined);
});

test('run retained session binding prefers the selected agent context', () => {
  assert.deepEqual(
    resolveRunRetainedSessionBinding(
      {
        metrics: {
          runnerSessionId: 'metrics-session',
          runnerSessionPath: '/sessions/metrics.jsonl',
        },
        agentContexts: [],
      },
      {
        runnerSessionId: 'context-session',
        runnerSessionPath: '/sessions/context.jsonl',
      },
    ),
    {
      binding: {
        runnerSessionId: 'context-session',
        runnerSessionPath: '/sessions/context.jsonl',
      },
      reason: null,
    },
  );
});

test('run retained session binding does not borrow metrics for an unbound selected context', () => {
  const result = resolveRunRetainedSessionBinding(
    {
      metrics: {
        runnerSessionId: 'metrics-session',
        runnerSessionPath: '/sessions/metrics.jsonl',
      },
      agentContexts: [],
    },
    { runnerSessionId: null, runnerSessionPath: null },
  );

  assert.deepEqual(result, { binding: null, reason: null });
  assert.deepEqual(retainedSessionSendOption(result), {});
});

test('retained session send option maps one atomic binding', () => {
  assert.deepEqual(
    retainedSessionSendOption({
      binding: {
        runnerSessionId: 'session-1',
        runnerSessionPath: '/sessions/session-1.jsonl',
      },
      reason: null,
    }),
    {
      retainedSession: {
        sessionId: 'session-1',
        sessionPath: '/sessions/session-1.jsonl',
      },
    },
  );
});
