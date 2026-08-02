import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readWorkerReport } from './retrospective.js';
import { makeRun } from './test-fixtures.js';

test('readWorkerReport prefers the dedicated report over the PR description', async (t) => {
  const taskDir = await mkdtemp(path.join(tmpdir(), 'farmslot-worker-report-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir);
  await writeFile(path.join(artifactsDir, 'pr-description.md'), 'PR description');
  await writeFile(path.join(artifactsDir, 'report.md'), 'Worker report');
  await writeFile(path.join(artifactsDir, 'comments-report.md'), 'Comments report');

  const report = await readWorkerReport(
    makeRun({ flowType: 'dev', taskFile: path.join(taskDir, 'TASK.md') }),
  );

  assert.equal(report, 'Worker report');
  assert.equal(
    await readWorkerReport(
      makeRun({ flowType: 'pr-complete', taskFile: path.join(taskDir, 'TASK.md') }),
    ),
    'Comments report',
  );
});
