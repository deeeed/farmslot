import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { handleChecklist } from '../src/harness/commands/checklist.js';

function task(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-checklist-'));
  writeFileSync(path.join(dir, 'TASK.md'), '# Task\n\n## Steps\n- [x] Done\n- [ ] Remaining\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('explicit reviewer checklist bypasses the completed worker signal and preserves it', async (t) => {
  const dir = task(t);
  const worker = JSON.stringify({ status: 'complete', attemptId: 'worker', step: 'complete' });
  writeFileSync(path.join(dir, 'SIGNAL.json'), worker);
  writeFileSync(path.join(dir, 'CI-FIX.md'), '# Fix\n\n## Steps\n- [ ] Verify\n');
  assert.equal(await handleChecklist(['mark', dir, '--checklist', 'CI-FIX.md', '1']), 0);
  assert.match(readFileSync(path.join(dir, 'CI-FIX.md'), 'utf8'), /\[x\] Verify/);
  assert.equal(
    JSON.parse(readFileSync(path.join(dir, 'CI-FIX-SIGNAL.json'), 'utf8')).status,
    'running',
  );
  assert.equal(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'), worker);
});

test('blocked start resumes progress while retaining checked boxes and timing', async (t) => {
  const dir = task(t);
  writeFileSync(
    path.join(dir, 'SIGNAL.json'),
    JSON.stringify({
      status: 'blocked',
      attemptId: 'blocked-attempt',
      reason: 'Unavailable target',
      checklistTiming: {
        schemaVersion: 1,
        source: 'TASK.md',
        events: [{ stepNumber: 1, label: 'Done', checkedAt: '2026-10-12T00:00:00.000Z' }],
      },
    }),
  );
  assert.equal(await handleChecklist(['mark', dir, 'start']), 0);
  const signal = JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'));
  assert.equal(signal.status, 'running');
  assert.equal(signal.checklistTiming.events.length, 1);
  assert.match(readFileSync(path.join(dir, 'TASK.md'), 'utf8'), /\[x\] Done/);
  assert.equal(await handleChecklist(['mark', dir, '2']), 0);
  assert.match(readFileSync(path.join(dir, 'TASK.md'), 'utf8'), /\[x\] Remaining/);
});

test('start preserves successful terminal verdicts', async (t) => {
  const dir = task(t);
  const completed = JSON.stringify({ status: 'complete', attemptId: 'completed-attempt' });
  writeFileSync(path.join(dir, 'SIGNAL.json'), completed);
  assert.equal(await handleChecklist(['mark', dir, 'start']), 0);
  assert.equal(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'), completed);
});

test('an explicit --checklist (or its --signal) that is not a task-local basename is a usage error', async (t) => {
  const dir = task(t);
  const signal = JSON.stringify({ status: 'complete' });
  writeFileSync(path.join(dir, 'SIGNAL.json'), signal);
  const errors = t.mock.method(console, 'error', () => {});
  let completeHookRan = false;
  const options = { beforeComplete: () => (completeHookRan = true) };
  assert.equal(await handleChecklist(['mark', dir, '--checklist', './TASK.md', '1'], options), 2);
  assert.equal(
    await handleChecklist(
      ['mark', dir, '--checklist', 'TASK.md', '--signal', '../S.json', '1'],
      options,
    ),
    2,
  );
  assert.equal(await handleChecklist(['mark', dir, '--checklist', 'TASK', 'complete'], options), 2);
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments[0]),
    [
      '--checklist must be a task-local basename (got ./TASK.md)',
      '--signal must be a task-local basename (got ../S.json)',
      '--checklist must end with .md (got TASK)',
    ],
  );
  assert.equal(completeHookRan, false);
  assert.equal(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'), signal);
});
