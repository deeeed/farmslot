import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
  const read = (
    limit?: number,
  ): { state: string; observedAt?: number; bytesRead?: number; cached?: boolean } =>
    JSON.parse(
      execFileSync('sh', ['-c', buildClaudeBackgroundProbeCommand(sessionId, file, limit)], {
        encoding: 'utf8',
        env: { ...probeEnvironment, HOME: root },
      }),
    );
  const cacheDir = path.join(root, '.cache', 'farmslot', 'claude-background');
  const cacheFile = path.join(cacheDir, `${createHash('sha256').update(file).digest('hex')}.json`);
  return { root, file, write, read, cacheDir, cacheFile };
}
/** A session record with no task evidence, padded to the byte length of `record`. */
function sameLengthFiller(record: unknown) {
  const filler = { type: 'system', sessionId, subtype: '' };
  filler.subtype = 'x'.repeat(JSON.stringify(record).length - JSON.stringify(filler).length);
  assert.equal(JSON.stringify(filler).length, JSON.stringify(record).length);
  return filler;
}
/** About 6.5 KB of records, enough to push earlier lines out of the probe's 4 KB tail window. */
const padding = Array.from({ length: 100 }, (_, index) => ({
  type: 'system',
  sessionId,
  subtype: `padding-${index}`,
}));

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

test('beyond 4 KB, a rotation and a same-size rewrite of the tail are each caught on their own', async (t) => {
  const f = await transcript(t);
  await f.write([launch(), ...padding]);
  assert.equal(f.read().state, 'active');
  // Rotated to a file of the same size and the same last 4 KB, without the launch: only the
  // inode tells them apart.
  const next = path.join(f.root, 'next.jsonl');
  await writeFile(
    next,
    [sameLengthFiller(launch()), ...padding].map((record) => JSON.stringify(record)).join('\n') +
      '\n',
  );
  assert.equal((await stat(next)).size, (await stat(f.file)).size);
  await rename(next, f.file);
  const rotated = f.read();
  assert.equal(rotated.state, 'idle');
  assert.equal(rotated.bytesRead, (await stat(f.file)).size);
  // Rewritten in place to the same size: only the tail hash tells them apart.
  await f.write([...padding, launch()]);
  assert.equal(f.read().state, 'active');
  const inode = (await stat(f.file)).ino;
  await f.write([...padding, sameLengthFiller(launch())]);
  assert.equal((await stat(f.file)).ino, inode);
  const rewritten = f.read();
  assert.equal(rewritten.state, 'idle');
  assert.equal(rewritten.bytesRead, (await stat(f.file)).size);
});

test('a read that parses nothing leaves the cache alone, and an older probe version cache is ignored', async (t) => {
  const f = await transcript(t);
  await f.write([launch()]);
  assert.equal(f.read().cached, true);
  const written = await stat(f.cacheFile);
  assert.equal(f.read().bytesRead, 0);
  assert.equal((await stat(f.cacheFile)).ino, written.ino, 'a no-op read does not rewrite it');
  const stored = JSON.parse(await readFile(f.cacheFile, 'utf8')) as Record<string, unknown>;
  await writeFile(f.cacheFile, JSON.stringify({ ...stored, v: 1 }));
  const rescanned = f.read();
  assert.equal(rescanned.state, 'active');
  assert.equal(rescanned.bytesRead, (await stat(f.file)).size);
});

test('a cache that cannot be written leaves no temporary file and the verdict stands', async (t) => {
  const f = await transcript(t);
  await f.write([launch()]);
  // A directory where the cache file goes makes the final rename fail after the write.
  await mkdir(f.cacheFile, { recursive: true });
  const first = f.read();
  assert.equal(first.state, 'active');
  assert.equal(first.cached, false);
  assert.deepEqual(await readdir(f.cacheDir), [path.basename(f.cacheFile)]);
  await appendFile(f.file, JSON.stringify(completed()) + '\n');
  const second = f.read();
  assert.equal(second.state, 'idle');
  assert.equal(second.bytesRead, (await stat(f.file)).size, 'with no cache, a read parses it all');
});

test('a cache that cannot be written is reported once per transcript', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const transcriptPath = `/tmp/uncached/${sessionId}.jsonl`;
  const overrides = {
    pane: async () => ({ paneId: '%7', panePid: '123' }),
    paneState: async () => ({ session_id: sessionId }),
    sessionState: async () => ({
      session_id: sessionId,
      tmuxPane: '%7',
      transcript_path: transcriptPath,
    }),
    exec: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ state: 'idle', observedAt: 1, cached: false }),
      stderr: '',
    }),
  };
  for (let read = 0; read < 2; read += 1) {
    assert.equal((await readClaudeBackgroundWorkState(makeVars(), '%7', overrides)).value, 'idle');
  }
  assert.equal(warn.mock.callCount(), 1);
  assert.match(
    String(warn.mock.calls[0]?.arguments[0]),
    new RegExp(`offset cache for ${transcriptPath}`),
  );
});
