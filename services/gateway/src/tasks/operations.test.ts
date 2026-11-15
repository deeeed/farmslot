import assert from 'node:assert/strict';
import fs, {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { TaskProgressStructured } from '@farmslot/protocol';

import {
  OperationOutputTail,
  OperationRecord,
  readOperations,
} from '../../../../packages/recipe-runner/src/runtime/operation.js';

import { attachOperations } from './operations.js';

function progress(): TaskProgressStructured {
  return {
    schema: { flowType: 'qa', title: 'Proof', totalSteps: 0, phases: [] },
    phases: [],
    completedSteps: 0,
    totalSteps: 0,
    currentPhase: null,
    currentStep: null,
  };
}
const local = { host: 'localhost', machine: 'local', sshTarget: '' };

test('projects emitted operations and their task-local log without changing their freshness', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'operation-projection-'));
  const mirror = path.join(root, 'task/artifacts/operations');
  const operation = new OperationRecord(path.join(root, 'runtime'), 'build', root, {
    mirrorDirectory: mirror,
  });
  try {
    operation.stage('compile');
    operation.output('');
    assert.equal(operation.value.lastOutputAt, undefined);
    operation.output('first output\n');
    operation.finish(0);
    const before = readFileSync(operation.file, 'utf8');
    const result = progress();
    await attachOperations(local, path.join(root, 'task/CHECKLIST.md'), result);
    assert.equal(result.operations?.[0].stage, 'compile');
    assert.equal(result.operations?.[0].status, 'pass');
    assert.equal(result.operations?.[0].logPath, `artifacts/operations/${operation.value.id}.log`);
    assert.equal(readFileSync(operation.file, 'utf8'), before);
    assert.equal(readFileSync(operation.value.logPath, 'utf8'), 'first output\n');
  } finally {
    operation.finish(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports a corrupt optional operation instead of claiming it is healthy', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'operation-corrupt-'));
  try {
    const directory = path.join(root, 'artifacts/operations');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, '00000000-0000-0000-0000-000000000000.json'), '{}');
    const result = progress();
    await attachOperations(local, path.join(root, 'CHECKLIST.md'), result);
    assert.match(result.operationsError!, /Invalid operation record/);
    assert.equal(result.operations, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('observation write failure stops observation without killing the command or recreating archived files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'operation-io-failure-'));
  const operation = new OperationRecord(path.join(root, 'runtime'), 'build', root);
  rmSync(root, { recursive: true, force: true });
  assert.doesNotThrow(() => operation.output('still executing\n'));
  assert.doesNotThrow(() => operation.stage('compile'));
  assert.doesNotThrow(() => operation.finish(0));
  assert.equal(operation.value.status, 'pass');
});

test('concurrent pruning between directory listing and record read is harmless', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'operation-prune-race-'));
  const operation = new OperationRecord(root, 'build', root);
  operation.finish(0);
  const read = fs.readFileSync;
  const stub = mock.method(
    fs,
    'readFileSync',
    (
      file: Parameters<typeof fs.readFileSync>[0],
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      if (file === operation.file) rmSync(operation.file);
      return read(file, options);
    },
  );
  try {
    assert.deepEqual(readOperations(root), []);
  } finally {
    stub.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('captured output retains the tail across chunk boundaries', () => {
  const tail = new OperationOutputTail(5);
  tail.append('abcdef');
  assert.equal(tail.toString(), 'bcdef');
  tail.append('gh');
  tail.append('');
  assert.equal(tail.toString(), 'defgh');
});

test('a poll reads only operation records that are new or changed since the last poll', async () => {
  const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
  const record = (n: number, status: string) =>
    JSON.stringify({
      schemaVersion: 1,
      id: id(n),
      command: 'run',
      target: '/proof',
      pid: 100 + n,
      status,
      startedAt: `2026-11-15T00:00:0${n}.000Z`,
      updatedAt: `2026-11-15T00:00:0${n}.000Z`,
      logPath: `/proof/task/artifacts/operations/${id(n)}.log`,
      ...(status === 'running' ? {} : { exitCode: 0, finishedAt: `2026-11-15T00:00:0${n}.500Z` }),
    });
  const files = new Map([
    [`${id(1)}.json`, { mtimeMs: 1, content: record(1, 'pass') }],
    [`${id(2)}.json`, { mtimeMs: 1, content: record(2, 'running') }],
  ]);
  const calls: string[] = [];
  const remote = {
    host: 'operations-proof.invalid',
    machine: 'operations-proof',
    sshTarget: '',
    nodeRequest: async (method: string, params: unknown) => {
      calls.push(method);
      const relPath = (params as { relPath: string }).relPath;
      if (method === 'fs.list')
        return {
          entries: [...files].map(([name, file]) => ({
            name,
            type: 'file',
            size: file.content.length,
            mtimeMs: file.mtimeMs,
          })),
        };
      if (method === 'fs.read') return { content: files.get(path.basename(relPath))?.content };
      throw new Error(`unexpected ${method}`);
    },
  };
  const checklist = '/proof/task/CHECKLIST.md';
  const poll = async () => {
    calls.length = 0;
    const result = progress();
    await attachOperations(remote, checklist, result);
    assert.equal(result.operationsError, undefined);
    return { calls: [...calls], statuses: result.operations?.map((op) => op.status) };
  };
  assert.deepEqual(await poll(), {
    calls: ['fs.list', 'fs.read', 'fs.read'],
    statuses: ['pass', 'running'],
  });
  assert.deepEqual(await poll(), { calls: ['fs.list'], statuses: ['pass', 'running'] });
  files.set(`${id(2)}.json`, { mtimeMs: 2, content: record(2, 'pass') });
  assert.deepEqual(await poll(), { calls: ['fs.list', 'fs.read'], statuses: ['pass', 'pass'] });
  files.delete(`${id(1)}.json`);
  assert.deepEqual(await poll(), { calls: ['fs.list'], statuses: ['pass'] });
});

test('absence and faults read as they did with an existence check first', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'operation-absence-'));
  try {
    // artifacts is a file: the operations directory is absent, not a fault.
    mkdirSync(path.join(root, 'a'));
    writeFileSync(path.join(root, 'a/artifacts'), 'not a directory');
    const absent = progress();
    await attachOperations(local, path.join(root, 'a/CHECKLIST.md'), absent);
    assert.equal(absent.operations, undefined);
    assert.equal(absent.operationsError, undefined);
    // operations is a file: listing it is a fault.
    mkdirSync(path.join(root, 'b/artifacts'), { recursive: true });
    writeFileSync(path.join(root, 'b/artifacts/operations'), 'not a directory');
    const file = progress();
    await attachOperations(local, path.join(root, 'b/CHECKLIST.md'), file);
    assert.match(file.operationsError ?? '', /Operation progress unavailable/);
    // A directory named like a record is still reported, not skipped.
    mkdirSync(path.join(root, 'c/artifacts/operations/00000000-0000-0000-0000-000000000000.json'), {
      recursive: true,
    });
    const directory = progress();
    await attachOperations(local, path.join(root, 'c/CHECKLIST.md'), directory);
    assert.match(directory.operationsError ?? '', /Operation progress unavailable/);
    // An unrelated entry that cannot be statted does not affect the records.
    const operations = path.join(root, 'd/artifacts/operations');
    mkdirSync(path.join(operations, 'archive'), { recursive: true });
    chmodSync(operations, 0o644);
    const unsearchable = progress();
    try {
      await attachOperations(local, path.join(root, 'd/CHECKLIST.md'), unsearchable);
    } finally {
      chmodSync(operations, 0o755);
    }
    assert.equal(unsearchable.operationsError, undefined);
    assert.deepEqual(unsearchable.operations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
