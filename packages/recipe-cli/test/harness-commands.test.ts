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
    '## Steps\n- [ ] CI parity [DETERMINISTIC: checks.unit]\n- [ ] Review\n',
  );
  writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    JSON.stringify({
      deterministicChecks: [
        { checklist: 'CHECKLIST.md', stepNumber: 1, reference: 'checks.unit', command },
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

// The whole path the engine's order refusal names: `./mark N --skip "<reason>"`
// goes through this handler to the mark script. Live run 6ff29609 got
// `unknown option --skip` from the CLI in front of it.
test('a skip reason reaches the mark script through the checklist handler', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-skip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  writeFileSync(
    path.join(dir, 'CHECKLIST.md'),
    '## Steps\n- [ ] 1. Reproduce [OPTIONAL: the bug still reproduces]\n- [ ] 2. Fix it\n',
  );
  writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    JSON.stringify({
      optionalSteps: [
        { checklist: 'CHECKLIST.md', stepNumber: 1, when: 'the bug still reproduces' },
      ],
    }),
  );

  assert.equal(await handleChecklist(['mark', dir, '1', '--skip', 'already fixed upstream']), 0);
  const checklist = readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8');
  assert.match(checklist, /\[x\] 1\. Reproduce/);
  assert.match(checklist, /\[ \] 2\. Fix it/, 'only the named step is marked');
  const event = JSON.parse(
    readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'),
  ).checklistTiming.events.at(-1);
  assert.equal(event.stepNumber, 1);
  assert.equal(event.skipped, true);
  assert.equal(event.reason, 'already fixed upstream');
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

test('a complete signal reuses unchanged checks and reruns changed inputs, keeping the signal and box', async (t) => {
  const { root, dir, signal, receipt } = completedDeterministicTask(
    t,
    'printf run >> .task/check-count',
  );
  const checklist = readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8');
  const logs = t.mock.method(console, 'log', () => {});
  assert.equal(await handleChecklist(['mark', dir, '1']), 0);
  const first = JSON.parse(readFileSync(receipt, 'utf8'));
  const receiptBefore = readFileSync(receipt, 'utf8');
  assert.equal(await handleChecklist(['mark', dir, '1']), 0);
  assert.equal(readFileSync(path.join(dir, 'check-count'), 'utf8'), 'run');
  assert.equal(readFileSync(receipt, 'utf8'), receiptBefore);
  writeFileSync(path.join(root, 'app.js'), 'export const value = 2;\n');
  assert.equal(await handleChecklist(['mark', dir, '1']), 0);
  const refreshed = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(refreshed.status, 'passed');
  assert.notEqual(refreshed.inputHash, first.inputHash);
  assert.equal(readFileSync(path.join(dir, 'check-count'), 'utf8'), 'runrun');
  assert.equal(
    logs.mock.calls.at(-1)?.arguments[0],
    'signal already terminal: status=complete; validated deterministic step 1 for the current tree',
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

// The pi `farmslot_mark` tool reaches the engine through this handler, and GLM
// eval 4cba5c2f used it to re-open a terminal blocked signal with `start`. This
// path used to return null for that case so the mark could proceed, and the
// mark script had no guard either. The decision now lives in the mark script,
// so this handler must surface its refusal rather than answer success.
test('start does not re-open a completed run through the tool path', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-start-reopen-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(dir, 'CHECKLIST.md'), '- [ ] 1. First\n- [ ] 2. Second\n');
  writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    JSON.stringify({
      schemaVersion: 1,
      flowType: 'fix-bug',
      mode: 'autonomous',
      requireSignal: true,
      commands: {
        complete: { report: 'artifacts/report.md', artifacts: ['artifacts/report.md'] },
        'no-change': { artifacts: [] },
        blocked: { artifacts: [] },
      },
      whenPresent: [],
    }),
  );

  writeFileSync(path.join(dir, 'artifacts', 'report.md'), '# Report\n');
  assert.equal(await handleChecklist(['mark', dir, '1']), 0);
  assert.equal(await handleChecklist(['mark', dir, '2']), 0);
  assert.equal(await handleChecklist(['mark', dir, 'complete']), 0);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8')).status, 'complete');

  // This path ignores the start rather than refusing it, which two existing
  // tests pin. What matters is the signal: a finished run keeps its record.
  await handleChecklist(['mark', dir, 'start']);
  assert.equal(
    JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8')).status,
    'complete',
    'the finished run keeps its record',
  );

  // Cleared by a re-dispatch, start is the ordinary beginning of an attempt.
  rmSync(path.join(dir, 'SIGNAL.json'));
  assert.equal(await handleChecklist(['mark', dir, 'start']), 0);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8')).status, 'running');

  // And a blocked run still resumes, the contract the harness pins elsewhere.
  assert.equal(await handleChecklist(['mark', dir, 'blocked', '--reason', 'target down']), 0);
  assert.equal(await handleChecklist(['mark', dir, 'start']), 0);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8')).status, 'running');
});

// `mark N` on the row that says to run `mark complete` completes the run
// (agent-runtime runs it), so completion staging must follow the signal, not
// the typed step: before, the run completed with no learning package staged.
test('marking the completion row stages learnings and shows completion guidance', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-completion-row-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  writeFileSync(path.join(dir, 'inputs', 'handoff.json'), '{}');
  writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- None\n');
  writeFileSync(path.join(dir, 'artifacts', 'report.md'), 'Done.\n');
  writeFileSync(
    path.join(dir, 'TASK.md'),
    '# Task\n\n## Steps\n- [ ] 1. Do it\n- [ ] 2. Finish: run `<task>/mark complete --mark-last`\n',
  );
  const calls: string[] = [];
  const options = {
    beforeComplete: () => calls.push('beforeComplete'),
    closeout: () => {
      calls.push('closeout');
      return { status: 0 };
    },
  };
  assert.equal(await handleChecklist(['mark', dir, '1'], options), 0);
  assert.deepEqual(calls, []);
  assert.equal(await handleChecklist(['mark', dir, '2'], options), 0);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8')).status, 'complete');
  assert.deepEqual(calls, ['beforeComplete', 'closeout']);
});
