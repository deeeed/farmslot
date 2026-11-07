import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getDiffStat } from './task-artifacts.js';
import { makeRun } from './test-fixtures.js';

test('required completion diff capture refuses unavailable output instead of reporting an empty diff', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'required-output-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = makeRun({ slotId: null, taskFile: path.join(dir, 'TASK.md') });
  await assert.rejects(getDiffStat(run, { fresh: true, required: true }), /missing-slot/);
});
