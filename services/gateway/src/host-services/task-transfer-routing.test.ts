import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { ExecResult } from '../core/exec.js';

await import('../runtime/mock-pty.test-support.js');
const actualExec = await import('../core/exec.js');
const parentCommands: string[] = [];
const success: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
mock.module('../core/exec.js', {
  namedExports: {
    ...actualExec,
    execLocal: async (command: string) => {
      parentCommands.push(command);
      return success;
    },
  },
});
const { backgroundHost } = await import('./background/client.js');
const { copyTaskDirSubdirectories, copyPreparedTaskRootSidecars } =
  await import('../tasks/sidecars.js');

test('remote task staging uses the background transfer owner instead of parent exec', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-transfer-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskDir = path.join(root, 'task');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/proof.txt'), 'proof');
  await writeFile(path.join(taskDir, 'mark'), '#!/bin/sh\n');
  t.mock.method(backgroundHost, 'active', () => true);
  const request = t.mock.method(backgroundHost, 'request', async () => success);
  const params = {
    taskDir,
    workerTaskAbs: path.join(root, 'worker'),
    host: 'fixture.invalid',
    machine: 'fixture-remote',
    sshTarget: 'fixture.invalid',
  };
  const before = parentCommands.length;
  await copyTaskDirSubdirectories(params);
  await copyPreparedTaskRootSidecars(params);
  assert.ok(request.mock.calls.length >= 3, 'copies and marker publication must use IPC');
  for (const call of request.mock.calls) assert.equal(call.arguments[0], 'taskFiles.transfer');
  assert.equal(parentCommands.length, before, 'gateway parent must not execute a transfer');
});

test('transfer command budget and inherited cleanup are retained through IPC', async (t) => {
  const { runTaskTransfer } = await import('./task-transfer.js');
  const { withCleanupSignal } = await import('../core/cleanup-scope.js');
  t.mock.method(backgroundHost, 'active', () => true);
  let finish: () => void = () => assert.fail('missing completion');
  const reply = new Promise<ExecResult>((resolve) => {
    finish = () => resolve(success);
  });
  const request = t.mock.method(backgroundHost, 'request', () => reply);
  const controller = new AbortController();
  const commands = { pending: new Set<Promise<unknown>>(), unconfirmed: false };
  const pending = withCleanupSignal(
    controller.signal,
    () =>
      runTaskTransfer('fixture copy', {
        cwd: '/fixture',
        timeout: 123,
        closeoutTimeoutMs: 400,
        maxBuffer: 9000,
      }),
    commands,
  );
  assert.equal(commands.pending.size, 1);
  try {
    const sent = request.mock.calls[0]?.arguments;
    assert.ok(sent);
    assert.equal(sent[0], 'taskFiles.transfer');
    assert.deepEqual(sent[1], {
      command: 'fixture copy',
      cwd: '/fixture',
      timeout: 123,
      closeoutTimeoutMs: 400,
      maxBuffer: 9000,
    });
    const transport = sent[2];
    assert.ok(transport);
    assert.equal(transport.deadlineMs, 523);
    assert.ok(transport.signal);
    assert.equal(transport.signal.aborted, false);
    controller.abort();
    assert.equal(transport.signal.aborted, true);
  } finally {
    finish();
  }
  assert.deepEqual(await pending, success);
  assert.equal(commands.pending.size, 0);
});

test('an untimed transfer keeps its original unbounded command budget', async (t) => {
  const { runTaskTransfer } = await import('./task-transfer.js');
  t.mock.method(backgroundHost, 'active', () => true);
  const request = t.mock.method(backgroundHost, 'request', async () => success);
  await runTaskTransfer('fixture copy');
  const transport = request.mock.calls[0]?.arguments[2];
  assert.ok(transport);
  assert.equal(transport.deadlineMs, null);
  assert.equal(parentCommands.includes('fixture copy'), false);
});
