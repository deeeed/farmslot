import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecutionTemplateReference, Run } from '@farmslot/protocol';

import { makeRun } from '../../run-engine/test-fixtures.js';

import {
  completedTaskReplayAnchor,
  type CompletedTaskReplayReaders,
  readCompletedTaskReplayBinding,
} from './completed-task-replay.js';

const original = '/farm/projects/example/tasks/fix/original/TASK.md';
const regenerated = '/farm/projects/example/tasks/fix/regenerated/TASK.md';
const template: ExecutionTemplateReference = {
  id: 'fix-bug/default',
  sourceId: 'project:example',
  flow: 'fix-bug',
  relativePath: 'fix-bug.md',
  platforms: ['*'],
  labels: [],
  sha256: 'a'.repeat(64),
};
function fixture() {
  const run = makeRun({
    status: 'failed',
    flowType: 'fix-bug',
    project: 'example',
    taskFile: regenerated,
    engineState: { taskExecution: { taskFile: original, startedAt: '2026-11-06T07:00:00Z' } },
  });
  const output = {
    workerFinished: true,
    capturedAt: '2026-11-06T08:00:00Z',
    artifactManifest: [],
    manifestDigest: 'b'.repeat(64),
  };
  run.output = output;
  run.agentContexts = [
    {
      id: 'fix-bug',
      label: 'Worker',
      role: 'fix-bug',
      status: 'failed',
      runId: run.id,
      slotId: 'slot-1',
      runner: 'codex',
      taskFile: 'temp/tasks/fix/original/TASK.md',
    },
  ];
  const reads: string[] = [];
  const readers: CompletedTaskReplayReaders = {
    taskRoot: async () => '/farm/projects/example/tasks',
    handoff: async (file) => {
      reads.push(file);
      return 'frozen-original-handoff';
    },
    capturedHandoff: async () => 'frozen-original-handoff',
    assertContract: async (candidate) => {
      assert.equal(candidate.taskFile, original);
    },
    provenance: async () => ({ executionTemplate: template }),
  };
  return { run, reads, readers, output };
}

test('completion restores the executed task, not the regenerated task or its missing CI receipt', async () => {
  const { run, reads, readers } = fixture();
  const before = structuredClone(run);
  assert.deepEqual(await readCompletedTaskReplayBinding(run, 'complete', readers), {
    taskFile: original,
    executionTemplate: template,
  });
  assert.deepEqual(reads, [original]);
  assert.deepEqual(run, before, 'selection does not alter run state, receipts or checkout');
});

test('ordinary completion and worker restart never select an older task', () => {
  const { run, output } = fixture();
  for (const step of ['find-slot', 'prepare', 'dispatch', 'monitor', 'review'])
    assert.equal(completedTaskReplayAnchor(run, step), null);
  assert.equal(completedTaskReplayAnchor({ ...run, taskFile: original }, 'complete'), null);
  assert.equal(
    completedTaskReplayAnchor({ ...run, output: { ...output, workerFinished: false } }, 'complete'),
    null,
  );
  assert.equal(completedTaskReplayAnchor({ ...run, status: 'monitoring' }, 'complete'), null);
  assert.equal(
    completedTaskReplayAnchor(
      { ...run, output: { ...output, workerFinished: true, closedAt: '2026-11-06T08:00:00Z' } },
      'complete',
    ),
    null,
  );
});

test('a different worker task cannot authorize restoration', () => {
  const { run } = fixture();
  const changed: Run = {
    ...run,
    agentContexts: run.agentContexts?.map((entry) => ({
      ...entry,
      taskFile: 'temp/tasks/fix/another/TASK.md',
    })),
  };
  assert.throws(() => completedTaskReplayAnchor(changed, 'complete'), /bindings differ/);
});

test('a captured-input mismatch refuses restoration without reading template provenance', async () => {
  const { run, readers } = fixture();
  readers.capturedHandoff = async () => 'another-task';
  readers.provenance = async () => {
    throw new Error('Must not read unverified provenance');
  };
  await assert.rejects(readCompletedTaskReplayBinding(run, 'complete', readers), /inputs differ/);
});

test('the original task must remain inside this project task root', async () => {
  const { run, readers } = fixture();
  readers.taskRoot = async () => '/farm/projects/another/tasks';
  await assert.rejects(readCompletedTaskReplayBinding(run, 'complete', readers), /outside/);
});

test('frozen contract and template validation remain mandatory', async () => {
  const { run, readers } = fixture();
  readers.assertContract = async () => {
    throw new Error('Original contract does not belong to this run');
  };
  await assert.rejects(
    readCompletedTaskReplayBinding(run, 'complete', readers),
    /contract does not belong/,
  );
  readers.assertContract = async () => {};
  readers.provenance = async () => null;
  await assert.rejects(readCompletedTaskReplayBinding(run, 'complete', readers), /provenance/);
});
