import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunOutput } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { retainedPriorTaskDirs, runOutputRetained } from './retained-task-dirs.js';

const repo = '/slots/va-mmcx-terminal-1';
const bundle = {
  storeId: 'local',
  bundleDigest: 'sha256:retained',
  taskKey: 'task',
  manifestDigest: 'sha256:manifest',
};
const failedCapture: RunOutput = {
  capturedAt: '2026-11-25T00:00:00.000Z',
  workerFinished: true,
  artifactManifest: [],
  manifestDigest: 'sha256:empty',
  captureError: 'store full',
};

test('only finished runs whose bundle retains their output give up their task dirs', (t) => {
  const make = (ticket: string, task: string) => {
    const run = createRun({ flowType: 'dev', project: 'retained-task-dirs', ticketOrPr: ticket });
    t.after(() => {
      updateRun(run.id, { status: 'failed' });
      deleteRun(run.id);
    });
    updateRun(run.id, { taskFile: `${repo}/temp/tasks/${task}/TASK.md` });
    return run.id;
  };
  const retained = make('TAT-4752', 'feat/tat-4752-1123-101010');
  updateRun(retained, { status: 'done', artifactBundle: bundle });
  const captureFailed = make('TAT-4591', 'fix/tat-4591-1111-173307');
  updateRun(captureFailed, {
    status: 'done',
    artifactBundle: bundle,
    output: failedCapture,
  });
  const unbundled = make('PAUDIT-15', 'dev/paudit-15');
  updateRun(unbundled, { status: 'done' });
  const running = make('TAT-4800', 'feat/tat-4800');
  updateRun(running, { status: 'monitoring', artifactBundle: bundle });
  const current = make('TAT-4801', 'feat/tat-4801');
  updateRun(current, { status: 'done', artifactBundle: bundle });

  const runs = [retained, captureFailed, unbundled, running, current].map((id) => getRun(id)!);
  assert.equal(runOutputRetained(getRun(retained)!), true);
  assert.equal(runOutputRetained(getRun(captureFailed)!), false);
  assert.deepEqual(retainedPriorTaskDirs(runs, repo, 'temp/tasks', current), [
    'feat/tat-4752-1123-101010',
  ]);
});
