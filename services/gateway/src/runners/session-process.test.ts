import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  buildFindRunnerDescendantPidCommand,
  resolvePersistedRunnerSessionBinding,
  resolveRunRetainedSessionBinding,
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
    },
  );
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
