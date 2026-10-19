import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// A completed task in a Git checkout whose step 1 runs the frozen `command`.
function completedDeterministicTask(t: TestContext, command: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'host-deterministic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  writeFileSync(path.join(root, 'app.js'), 'export const value = 1;\n');
  const dir = path.join(root, '.task');
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  writeFileSync(
    path.join(dir, 'CHECKLIST.md'),
    '## Steps\n- [ ] CI parity [DETERMINISTIC: ci.local_check]\n- [ ] Review\n',
  );
  writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    JSON.stringify({
      deterministicChecks: [
        { checklist: 'CHECKLIST.md', stepNumber: 1, reference: 'ci.local_check', command },
      ],
    }),
  );
  const signal = JSON.stringify({ status: 'complete', attemptId: 'completed-attempt' });
  writeFileSync(path.join(dir, 'SIGNAL.json'), signal);
  const receipt = path.join(dir, 'artifacts', 'deterministic-checks', 'CHECKLIST.md', '1.json');
  return { root, dir, signal, receipt };
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

test('a complete signal reruns a deterministic step for the current tree, keeping the signal and box', async (t) => {
  const { root, dir, signal, receipt } = completedDeterministicTask(t, 'printf "check passed\\n"');
  const checklist = readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8');
  const logs = t.mock.method(console, 'log', () => {});
  assert.equal(await handleChecklist(['mark', dir, '1']), 0);
  const first = JSON.parse(readFileSync(receipt, 'utf8'));
  writeFileSync(path.join(root, 'app.js'), 'export const value = 2;\n');
  assert.equal(await handleChecklist(['mark', dir, '1']), 0);
  const refreshed = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(refreshed.status, 'passed');
  assert.notEqual(refreshed.inputHash, first.inputHash);
  assert.equal(
    logs.mock.calls.at(-1)?.arguments[0],
    'signal already terminal: status=complete; refreshed the receipt of deterministic step 1 for the current tree',
  );
  assert.equal(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'), signal);
  assert.equal(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), checklist);
});

test('a complete signal refuses a failing deterministic rerun and stays complete', async (t) => {
  const { dir, signal } = completedDeterministicTask(t, 'exit 7');
  const checklist = readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8');
  const errors = t.mock.method(console, 'error', () => {});
  assert.equal(await handleChecklist(['mark', dir, '1']), 1);
  assert.match(
    String(errors.mock.calls[0]?.arguments[0]),
    /^signal already terminal: status=complete; Deterministic step 1 failed with exit 7/,
  );
  assert.equal(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'), signal);
  assert.equal(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), checklist);
});

test('a complete signal still ignores start and numbered steps without a deterministic check', async (t) => {
  const { dir, signal, receipt } = completedDeterministicTask(t, 'printf "check passed\\n"');
  const checklist = readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8');
  assert.equal(await handleChecklist(['mark', dir, '2']), 0);
  assert.equal(await handleChecklist(['mark', dir, 'start']), 0);
  assert.equal(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'), signal);
  assert.equal(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), checklist);
  assert.throws(() => readFileSync(receipt), { code: 'ENOENT' });
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
