import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeRun } from '../methods/run/test-fixtures.js';

import { mirrorWorkerProgress } from './progress-mirror.js';

test('a failed checklist copy cannot publish the new attempt shared terminal signal', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'progress-copy-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = path.join(root, 'worker');
  const gateway = path.join(root, 'gateway');
  await mkdir(worker);
  await mkdir(gateway);
  await writeFile(path.join(worker, 'TASK.md'), '# Task');
  await writeFile(path.join(worker, 'CHECKLIST.md'), '# New attempt\n- [x] **1. New**\n');
  await writeFile(
    path.join(worker, 'SIGNAL.json'),
    JSON.stringify({ status: 'complete', attemptId: 'new' }),
  );
  await writeFile(path.join(gateway, 'CHECKLIST.md.worker'), '# Old attempt');
  await writeFile(
    path.join(gateway, 'SIGNAL.json.worker'),
    JSON.stringify({ status: 'complete', attemptId: 'old' }),
  );
  await assert.rejects(
    mirrorWorkerProgress(
      { host: 'localhost', machine: 'local', sshTarget: '' },
      worker,
      gateway,
      makeRun({ id: 'copy-fence' }),
      {
        beforeCopy: async (source) => {
          if (path.basename(source) === 'CHECKLIST.md') throw new Error('copy refused');
          return true;
        },
      },
    ),
    /copy refused/,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(gateway, 'SIGNAL.json.worker'), 'utf8')).attemptId,
    'old',
  );
});
