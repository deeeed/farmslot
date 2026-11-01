import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { makeVars } from './test-fixtures.js';

await import('../runtime/mock-pty.test-support.js');
const { buildClaudeBackgroundProbeCommand, readClaudeBackgroundWorkState } =
  await import('./claude-background-work.js');

// Resolve once so repeated probes do not pay a version-manager shim's startup cost.
const pythonDirectory = path.dirname(
  execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(),
);
const probeEnvironment = {
  ...process.env,
  PATH: `${pythonDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
};

const sessionId = 'fixture-session';
function launch(task = 'background-1', tool = 'tool-1') {
  return {
    type: 'user',
    sessionId,
    message: { content: [{ type: 'tool_result', tool_use_id: tool }] },
    toolUseResult: { backgroundTaskId: task },
  };
}
function completed(task = 'background-1', tool = 'tool-1', status = 'completed') {
  return {
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId,
    content: `<task-notification><task-id>${task}</task-id><tool-use-id>${tool}</tool-use-id><status>${status}</status></task-notification>`,
  };
}
function stopCall(task = 'background-1', tool = 'stop-1') {
  return {
    type: 'assistant',
    sessionId,
    message: {
      content: [{ type: 'tool_use', id: tool, name: 'TaskStop', input: { task_id: task } }],
    },
  };
}
function stopResult(task = 'background-1', tool = 'stop-1', isError?: boolean) {
  return {
    type: 'user',
    sessionId,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: tool,
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ],
    },
    toolUseResult: { task_id: task, task_type: 'local_bash' },
  };
}
async function transcript(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-background-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, `${sessionId}.jsonl`);
  const write = (records: unknown[]) =>
    writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // The probe keeps its per-transcript cache under HOME; keep it inside this test's root.
  const read = (limit?: number): { state: string; observedAt?: number; bytesRead?: number } =>
    JSON.parse(
      execFileSync('sh', ['-c', buildClaudeBackgroundProbeCommand(sessionId, file, limit)], {
        encoding: 'utf8',
        env: { ...probeEnvironment, HOME: root },
      }),
    );
  return { root, file, write, read };
}

test('native background work remains active after a Stop and settles only on its own completion', async (t) => {
  const f = await transcript(t);
  const records = [
    launch(),
    { type: 'system', sessionId, subtype: 'stop_hook_summary' },
    {
      type: 'assistant',
      sessionId,
      message: { content: [{ type: 'text', text: 'Everything is finished.' }] },
    },
  ];
  await f.write(records);
  assert.equal(f.read().state, 'active');
  for (const status of ['completed', 'failed', 'killed']) {
    await f.write([...records, completed('background-1', 'tool-1', status)]);
    assert.equal(f.read().state, 'idle');
  }
});

test('asynchronous native agents use the same task completion identity', async (t) => {
  const f = await transcript(t);
  const agent = { ...launch(), toolUseResult: { isAsync: true, agentId: 'background-1' } };
  await f.write([agent]);
  assert.equal(f.read().state, 'active');
  await f.write([agent, completed()]);
  assert.equal(f.read().state, 'idle');
});

test('foreign sessions, tool identities and ordinary prompts cannot settle native background work', async (t) => {
  const f = await transcript(t);
  await f.write([
    launch(),
    { ...completed(), sessionId: 'other-session' },
    completed('background-1', 'other-tool'),
    { ...completed(), content: 'Done; nothing running.' },
  ]);
  assert.equal(f.read().state, 'active');
  await f.write([launch(), launch('background-2', 'tool-2'), completed()]);
  assert.equal(f.read().state, 'active');
  await f.write([
    launch(),
    launch('background-2', 'tool-2'),
    completed(),
    completed('background-2', 'tool-2'),
  ]);
  assert.equal(f.read().state, 'idle');
});

test('an idle compacted journal larger than 32 MiB still proves no background work', async (t) => {
  const f = await transcript(t);
  const attachment = { type: 'api-request-blob', sessionId, data: 'x'.repeat(64 * 1024) };
  await f.write([
    launch(),
    completed(),
    ...Array.from({ length: 576 }, () => attachment),
    { type: 'system', sessionId, subtype: 'stop_hook_summary' },
    { type: 'system', sessionId, subtype: 'compact_boundary' },
  ]);
  assert.ok((await stat(f.file)).size > 32 * 1024 * 1024);
  assert.equal(f.read().state, 'idle');
});

test('compaction does not erase an unfinished task across bounded record reads', async (t) => {
  const f = await transcript(t);
  const records = [
    launch(),
    ...Array.from({ length: 64 }, () => ({
      type: 'api-request-blob',
      sessionId,
      data: 'x'.repeat(512),
    })),
    { type: 'system', sessionId, subtype: 'stop_hook_summary' },
    { type: 'system', sessionId, subtype: 'compact_boundary' },
  ];
  await f.write(records);
  assert.equal(f.read(1024).state, 'active');
  await f.write([...records, completed()]);
  assert.equal(f.read(1024).state, 'idle');
});

test('terminal notifications reconcile before launch and cannot be undone by duplicate launches', async (t) => {
  const f = await transcript(t);
  for (const records of [
    [completed(), launch()],
    [launch(), completed(), launch()],
    [completed('background-1', 'tool-1', 'failed'), launch()],
    [completed('background-1', 'tool-1', 'killed'), launch()],
  ]) {
    await f.write(records);
    assert.equal(f.read().state, 'idle');
  }
  await f.write([completed('background-1', 'other-tool'), launch()]);
  assert.equal(f.read().state, 'active');
  await f.write([completed(), launch(), launch('background-2', 'tool-2')]);
  assert.equal(f.read().state, 'active');
});

test('a matched successful TaskStop settles only its target, including reordered native records', async (t) => {
  const f = await transcript(t);
  for (const error of [undefined, false]) {
    await f.write([launch(), stopCall(), stopResult('background-1', 'stop-1', error)]);
    assert.equal(f.read().state, 'idle');
  }
  await f.write([stopResult(), stopCall(), launch()]);
  assert.equal(f.read().state, 'idle');
  await f.write([launch(), launch('background-2', 'tool-2'), stopCall(), stopResult()]);
  assert.equal(f.read().state, 'active');
  await f.write([
    launch(),
    launch('background-2', 'tool-2'),
    stopCall(),
    stopResult(),
    stopCall('background-2', 'stop-2'),
    stopResult('background-2', 'stop-2'),
  ]);
  assert.equal(f.read().state, 'idle');
});

test('failed, mismatched or unproven stop receipts cannot erase live background work', async (t) => {
  const f = await transcript(t);
  const cases = [
    [stopCall()],
    [stopResult()],
    [stopCall(), stopResult('background-1', 'stop-1', true)],
    [stopCall(), stopResult('other-task')],
    [stopCall(), stopResult('background-1', 'other-call')],
    [stopCall('other-task'), stopResult()],
    [stopCall(), { ...stopResult(), sessionId: 'foreign' }],
    [{ ...stopCall(), sessionId: 'foreign' }, stopResult()],
    [
      stopCall(),
      {
        ...stopResult(),
        message: { content: [{ type: 'tool_result', tool_use_id: 'stop-1', is_error: 'false' }] },
      },
    ],
    [stopCall(), { ...stopResult(), toolUseResult: { task_id: 'background-1' } }],
    [
      {
        ...stopCall(),
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'stop-1',
              name: 'TaskOutput',
              input: { task_id: 'background-1' },
            },
          ],
        },
      },
      stopResult(),
    ],
  ];
  for (const records of cases) {
    await f.write([launch(), ...records]);
    assert.equal(f.read().state, 'active');
  }
});

test('incomplete, oversized and unattributed native evidence never proves idle', async (t) => {
  const f = await transcript(t);
  await f.write([launch()]);
  assert.equal(f.read(10).state, 'unknown');
  await writeFile(f.file, JSON.stringify(launch()));
  assert.equal(f.read().state, 'unknown');
  await f.write([{ ...launch(), sessionId: 'other-session' }]);
  assert.equal(f.read().state, 'unknown');
});

test('background state is bound to the root session, exact pane and a live runner', async () => {
  for (const processState of ['present', 'absent'] as const) {
    const reading = await readClaudeBackgroundWorkState(makeVars(), '%7', {
      pane: async () => ({ paneId: '%7', panePid: '123' }),
      paneState: async () => ({ session_id: 'child', rootSessionId: sessionId }),
      sessionState: async () => ({
        session_id: sessionId,
        tmuxPane: '%7',
        transcript_path: `/tmp/${sessionId}.jsonl`,
      }),
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ state: 'active', observedAt: 1 }),
        stderr: '',
      }),
      process: async () =>
        processState === 'present' ? { state: 'present', pid: '124' } : { state: 'absent' },
    });
    assert.equal(reading.value, processState === 'present' ? 'active' : 'unknown');
  }
  const changed = await readClaudeBackgroundWorkState(makeVars(), '%7', {
    pane: async () => ({ paneId: '%7', panePid: '123' }),
    paneState: async () => ({ session_id: sessionId }),
    sessionState: async () => ({
      session_id: sessionId,
      tmuxPane: '%8',
      transcript_path: `/tmp/${sessionId}.jsonl`,
    }),
    exec: async () => assert.fail('foreign pane must not read the transcript'),
  });
  assert.equal(changed.value, 'unknown');
});

test('a later read parses only the bytes appended since the last one', async (t) => {
  const f = await transcript(t);
  await f.write([launch()]);
  const first = f.read();
  assert.equal(first.state, 'active');
  assert.equal(first.bytesRead, (await stat(f.file)).size);
  const appended = JSON.stringify(completed()) + '\n';
  await appendFile(f.file, appended);
  const second = f.read();
  assert.equal(second.state, 'idle', 'the cached launch meets its appended completion');
  assert.equal(second.bytesRead, Buffer.byteLength(appended));
  assert.equal(f.read().bytesRead, 0, 'nothing new, nothing parsed');
});

test('truncation, rotation and an in-place rewrite restart from byte zero', async (t) => {
  const f = await transcript(t);
  await f.write([launch(), completed()]);
  assert.equal(f.read().state, 'idle');
  // Truncated to a shorter journal whose task is unfinished.
  await f.write([launch('background-2', 'tool-2')]);
  const truncated = f.read();
  assert.equal(truncated.state, 'active');
  assert.equal(truncated.bytesRead, (await stat(f.file)).size);
  // Rotated: a new file (new inode) at the same path.
  const next = path.join(f.root, 'next.jsonl');
  await writeFile(
    next,
    [launch('background-3', 'tool-3'), completed('background-3', 'tool-3'), launch()]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  await rename(next, f.file);
  const rotated = f.read();
  assert.equal(rotated.state, 'active');
  assert.equal(rotated.bytesRead, (await stat(f.file)).size);
  // Rewritten in place, longer, with a different beginning: the tail check catches it.
  await f.write([
    { type: 'system', sessionId, subtype: 'rewritten-history-record' },
    launch(),
    completed(),
    launch('background-3', 'tool-3'),
    completed('background-3', 'tool-3'),
  ]);
  const rewritten = f.read();
  assert.equal(rewritten.state, 'idle');
  assert.equal(rewritten.bytesRead, (await stat(f.file)).size);
});

test('a partial trailing line is read once it is complete, not before', async (t) => {
  const f = await transcript(t);
  await f.write([launch()]);
  assert.equal(f.read().state, 'active');
  const line = JSON.stringify(completed());
  await appendFile(f.file, line.slice(0, 20));
  assert.equal(f.read().state, 'unknown', 'a line still being written proves nothing');
  await appendFile(f.file, line.slice(20) + '\n');
  const completedRead = f.read();
  assert.equal(completedRead.state, 'idle');
  assert.equal(completedRead.bytesRead, Buffer.byteLength(line) + 1);
});
