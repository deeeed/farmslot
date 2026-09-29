import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import type { TaskProgressStructured } from '@farmslot/protocol';
import {
  OperationRecord,
  OperationOutputTail,
  readOperations,
} from '../../../../packages/recipe-harness/src/runtime/operation.js';
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
  const stub = mock.method(fs, 'readFileSync', (file: Parameters<typeof fs.readFileSync>[0], options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (file === operation.file) rmSync(operation.file);
    return read(file, options);
  });
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
