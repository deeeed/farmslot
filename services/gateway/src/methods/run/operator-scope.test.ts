import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';
import { normalizeOperatorScope, OPERATOR_SCOPE_MAX_CHARS, runCreate } from '../run.js';

test('the operator scope is stored on the run it was created with', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example',
    ticketOrPr: 'TAT-3405',
    operatorScope: 'flip slice only, AC1/AC2',
  });
  try {
    assert.equal(getRun(run.id)?.operatorScope, 'flip slice only, AC1/AC2');
  } finally {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  }
});

test('an operator scope with an existing task file is refused, not dropped', async (t) => {
  // An existing TASK.md skips write-task, which is what renders the scope.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-operator-scope-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const taskFile = path.join(dir, 'TASK.md');
  await writeFile(taskFile, '# dev: example\n');
  await assert.rejects(
    runCreate(
      {
        flowType: 'dev',
        project: 'example',
        ticketOrPr: 'PROJ-123',
        taskFile,
        operatorScope: 'AC1 only',
      },
      () => {},
    ),
    /operatorScope is rendered into the TASK\.md that write-task writes/,
  );
});

test('a non-string operator scope is refused', async () => {
  await assert.rejects(
    runCreate(
      {
        flowType: 'dev',
        project: 'example',
        ticketOrPr: 'PROJ-123',
        operatorScope: ['AC1'] as unknown as string,
      },
      () => {},
    ),
    /operatorScope must be a string/,
  );
});

test('the operator scope is trimmed, a blank one is dropped, and an oversized one refused', () => {
  const base = { flowType: 'fix-bug' as const, project: 'example', ticketOrPr: 'TAT-3405' };
  const trimmed = { ...base, operatorScope: '  flip slice only  ' };
  normalizeOperatorScope(trimmed);
  assert.equal(trimmed.operatorScope, 'flip slice only');
  const blank: { operatorScope?: string } & typeof base = { ...base, operatorScope: '   ' };
  normalizeOperatorScope(blank);
  assert.equal('operatorScope' in blank, false);
  assert.throws(
    () =>
      normalizeOperatorScope({ ...base, operatorScope: 'x'.repeat(OPERATOR_SCOPE_MAX_CHARS + 1) }),
    /keep it under 8000/,
  );
});
