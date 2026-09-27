import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

import type { loadSlotVars } from './config.js';
import type { execOnSlot } from './exec.js';
import { pasteTmuxText, shellQuote } from './tmux.js';

const vars = { machine: 'paste-test' } as Awaited<ReturnType<typeof loadSlotVars>>;
const success: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

function executor(handler?: (command: string) => Promise<ExecResult> | ExecResult) {
  const commands: string[] = [];
  const execute: typeof execOnSlot = async (_vars, command, options) => {
    assert.ok(options && typeof options !== 'string');
    assert.ok(options.timeout && options.timeout > 0 && options.timeout <= 5000);
    commands.push(command);
    if (command.includes('display-message')) return { ...success, stdout: '%701\n' };
    return handler ? handler(command) : success;
  };
  return { commands, execute };
}

test('paste preserves quoted multiline text and bounds every operation', async () => {
  const trace = executor();
  const text = "Feedback 'quoted'\n字".repeat(300);
  await pasteTmuxText(vars, 'session:worker', text, { execute: trace.execute, submitKey: 'C-m' });
  assert.equal(trace.commands.length, 4);
  assert.ok(trace.commands[1].includes(shellQuote(text)));
  assert.match(trace.commands[2], /paste-buffer -d -p/);
  assert.match(trace.commands[2], /-t '%701'/);
  assert.match(trace.commands[3], /send-keys -t '%701' C-m/);
});

test('empty semantic input submits without allocating a paste buffer', async () => {
  const trace = executor();
  await pasteTmuxText(vars, 'session:worker', '', { execute: trace.execute, submitKey: 'Enter' });
  assert.equal(trace.commands.length, 2);
  assert.match(trace.commands[1], /send-keys -t '%701' Enter/);
});

test('paste without submit never sends an Enter key', async () => {
  const trace = executor();
  await pasteTmuxText(vars, '%701', 'draft', { execute: trace.execute });
  assert.equal(trace.commands.length, 3);
  assert.equal(
    trace.commands.some((command) => command.includes('send-keys')),
    false,
  );
});

test('aliases of one pane serialize paste through submit', async () => {
  let releaseFirst!: () => void;
  let firstWritten!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const written = new Promise<void>((resolve) => {
    firstWritten = resolve;
  });
  const trace = executor(async (command) => {
    if (command.includes("-- 'first'")) {
      firstWritten();
      await held;
    }
    return success;
  });
  const first = pasteTmuxText(vars, 'session:worker', 'first', {
    execute: trace.execute,
    submitKey: 'Enter',
  });
  await written;
  const second = pasteTmuxText(vars, '%701', 'second', {
    execute: trace.execute,
    submitKey: 'Enter',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    trace.commands.some((command) => command.includes("-- 'second'")),
    false,
  );
  releaseFirst();
  await Promise.all([first, second]);
  const firstSubmit = trace.commands.findIndex((command) => command.includes('send-keys'));
  const secondWrite = trace.commands.findIndex((command) => command.includes("-- 'second'"));
  assert.ok(firstSubmit < secondWrite);
});

test('a failed set-buffer never pastes or submits', async () => {
  const trace = executor(() => ({ ...success, exitCode: 1, stderr: 'write refused' }));
  await assert.rejects(
    pasteTmuxText(vars, '%701', 'text', { execute: trace.execute, submitKey: 'Enter' }),
    /write refused/,
  );
  assert.equal(trace.commands.length, 2);
});

for (const stage of ['set-buffer', 'paste-buffer']) {
  test(`a thrown ${stage} cleans up its uncertain buffer and preserves the failure`, async () => {
    const failure = new Error(`${stage} transport lost`);
    const trace = executor((command) => {
      if (command.includes(`${stage} -`)) throw failure;
      return success;
    });
    await assert.rejects(
      pasteTmuxText(vars, '%701', 'text', { execute: trace.execute, submitKey: 'Enter' }),
      (error) => error === failure,
    );
    assert.ok(trace.commands.at(-1)?.includes('delete-buffer'));
    assert.equal(
      trace.commands.some((command) => command.includes('send-keys')),
      false,
    );
  });
}

test('failed cleanup preserves both errors and releases the pane queue', async () => {
  const failure = new Error('paste lost');
  const cleanupFailure = new Error('cleanup lost');
  const trace = executor((command) => {
    if (command.includes('paste-buffer')) throw failure;
    if (command.includes('delete-buffer')) throw cleanupFailure;
    return success;
  });
  await assert.rejects(pasteTmuxText(vars, '%701', 'text', { execute: trace.execute }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure, cleanupFailure]);
    return true;
  });
  await pasteTmuxText(vars, '%701', 'next', { execute: executor().execute });
});

test('an already-consumed buffer is not reported as a second failure', async () => {
  const failure = new Error('paste acknowledgement lost');
  const trace = executor((command) => {
    if (command.includes('paste-buffer')) throw failure;
    if (command.includes('delete-buffer')) return { ...success, exitCode: 1 };
    return success;
  });
  await assert.rejects(
    pasteTmuxText(vars, '%701', 'text', { execute: trace.execute }),
    (error) => error === failure,
  );
  assert.ok(trace.commands.at(-1)?.includes('list-buffers'));
});

test('a refused submit reports failure without deleting an already consumed buffer', async () => {
  const trace = executor((command) =>
    command.includes('send-keys') ? { ...success, exitCode: 1, stderr: 'submit refused' } : success,
  );
  await assert.rejects(
    pasteTmuxText(vars, '%701', 'text', { execute: trace.execute, submitKey: 'Enter' }),
    /submit refused/,
  );
  assert.equal(trace.commands.length, 4);
});

test('a reported cleanup failure retains the original paste failure', async () => {
  let bufferName = '';
  const trace = executor((command) => {
    if (command.includes('set-buffer'))
      bufferName = command.match(/-b '(farmslot-paste-[^']+)'/)![1];
    if (command.includes('paste-buffer'))
      return { ...success, exitCode: 1, stderr: 'paste refused' };
    if (command.includes('delete-buffer'))
      return { ...success, exitCode: 1, stderr: 'cleanup refused' };
    if (command.includes('list-buffers')) return { ...success, stdout: `${bufferName}\n` };
    return success;
  });
  await assert.rejects(pasteTmuxText(vars, '%701', 'text', { execute: trace.execute }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /paste refused/);
    assert.match(error.errors[1].message, /cleanup refused/);
    return true;
  });
});

test('one host does not block the same pane id on another host', async () => {
  let releaseFirst!: () => void;
  let firstWritten!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const written = new Promise<void>((resolve) => {
    firstWritten = resolve;
  });
  const trace = executor(async (command) => {
    if (command.includes("-- 'first'")) {
      firstWritten();
      await held;
    }
    return success;
  });
  const first = pasteTmuxText(vars, '%701', 'first', { execute: trace.execute });
  await written;
  try {
    await pasteTmuxText({ ...vars, machine: 'other-host' }, '%701', 'second', {
      execute: trace.execute,
    });
    assert.ok(trace.commands.some((command) => command.includes("-- 'second'")));
  } finally {
    releaseFirst();
    await first;
  }
});

test('expired queued input never writes a buffer', async (context) => {
  let now = 0;
  context.mock.method(Date, 'now', () => now);
  let releaseFirst!: () => void;
  let firstWritten!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const written = new Promise<void>((resolve) => {
    firstWritten = resolve;
  });
  const trace = executor(async (command) => {
    if (command.includes("-- 'first'")) {
      firstWritten();
      await held;
    }
    return success;
  });
  const first = pasteTmuxText(vars, '%701', 'first', { execute: trace.execute });
  await written;
  const second = pasteTmuxText(vars, '%701', 'second', { execute: trace.execute });
  const settled = Promise.allSettled([first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  now = 25_000;
  releaseFirst();
  assert.deepEqual(
    (await settled).map((result) => result.status),
    ['rejected', 'rejected'],
  );
  assert.equal(
    trace.commands.some((command) => command.includes("-- 'second'")),
    false,
  );
});
