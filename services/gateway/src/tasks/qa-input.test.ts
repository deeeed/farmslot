import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { makeRun } from '../run-engine/test-fixtures.js';

import { QA_INPUT, writeQaInput } from './qa-input.js';

// A retried task initialization writes the admitted QA input again (ADR-068 Amendment 7).
test('writeQaInput accepts its identical retry and refuses changed bytes', async (t) => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'qa-input-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  await mkdir(path.join(taskDir, 'inputs'));
  const run = {
    ...makeRun({ flowType: 'qa' }),
    qa: { profile: { id: 'pr', title: 'PR smoke', template_id: 'qa/default' }, inputs: {} },
    executionTemplate: {
      id: 'qa/default',
      sourceId: 'project',
      flow: 'qa',
      platforms: ['cli'],
      labels: [],
      relativePath: 'qa/default.md',
      sha256: 'a'.repeat(64),
    },
  };

  await writeQaInput(taskDir, run);
  const written = await readFile(path.join(taskDir, QA_INPUT), 'utf8');
  await writeQaInput(taskDir, run);
  assert.equal(await readFile(path.join(taskDir, QA_INPUT), 'utf8'), written);

  await assert.rejects(writeQaInput(taskDir, { ...run, ticketOrPr: 'another source' }), {
    code: 'EEXIST',
  });
  assert.equal(await readFile(path.join(taskDir, QA_INPUT), 'utf8'), written);
});
