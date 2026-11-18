#!/usr/bin/env node
'use strict';

// Run c2821858 (TAT-4685): the fix was already on main, so the worker could not
// reproduce the bug. `mark no-change --already-fixed` was refused because the
// artifact contract wanted the step-5 `ci.local_check` receipt; recording that
// receipt means marking step 5, which the order rule refuses while step 2
// (reproduce) is unchecked, and step 2 cannot honestly be ticked when the bug
// does not reproduce. The run had no exit at all and sat blocked, which is what
// its own blocked reason says.
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  deterministicChecks,
  resolveWorkerTerminalContract,
} = require('../scripts/worker-terminal-contract.cjs');

const checker = path.resolve(__dirname, '../scripts/check-task-artifact-contract.mjs');

/** A fix-bug task whose checklist declares a deterministic changed-file check. */
function task(t) {
  const checkout = mkdtempSync(path.join(tmpdir(), 'no-change-deterministic-'));
  const taskDir = path.join(checkout, 'task');
  t.after(() => require('node:fs').rmSync(checkout, { recursive: true, force: true }));
  const git = spawnSync('git', ['init', '-q'], { cwd: checkout, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  const checklist = '## Checklist\n- [ ] 1. Changed-file CI [DETERMINISTIC: ci.local_check]\n';
  writeFileSync(path.join(taskDir, 'CHECKLIST.md'), checklist);
  const contract = deterministicChecks.freeze(
    resolveWorkerTerminalContract(null, 'fix-bug'),
    checklist,
    'CHECKLIST.md',
    { 'ci.local_check': 'printf "ci passed\\n"' },
  );
  writeFileSync(
    path.join(taskDir, 'inputs', 'worker-terminal-contract.json'),
    `${JSON.stringify(contract)}\n`,
  );
  // What a no-change exit owes: its report and its learnings.
  writeFileSync(
    path.join(taskDir, 'artifacts', 'no-change-report.md'),
    '# Already fixed\n\nFixed on main by 5804b8b9.\n',
  );
  writeFileSync(
    path.join(taskDir, 'artifacts', 'learnings.md'),
    '# Learnings\n\nNothing to fix.\n',
  );
  const run = (terminal) =>
    spawnSync(
      process.execPath,
      [
        checker,
        taskDir,
        '--contract',
        path.join(taskDir, 'inputs', 'worker-terminal-contract.json'),
        '--terminal',
        terminal,
      ],
      { cwd: taskDir, encoding: 'utf8' },
    );
  return { taskDir, run };
}

test('a no-change exit does not need a deterministic receipt it cannot record', (t) => {
  const { run } = task(t);

  const complete = run('complete');
  assert.equal(complete.status, 1, 'a completed fix still owes its changed-file receipt');
  assert.match(complete.stderr, /ci\.local_check/);

  const noChange = run('no-change');
  assert.equal(noChange.status, 0, `a no-change exit changed nothing to check: ${noChange.stderr}`);
});

test('a recorded deterministic receipt that did not pass still refuses a no-change exit', (t) => {
  const { taskDir, run } = task(t);
  const [declared] = deterministicChecks.read(taskDir, 'CHECKLIST.md');
  assert.ok(declared, 'the fixture must declare one deterministic step');
  const receipts = path.join(taskDir, 'artifacts', 'deterministic-checks', declared.checklist);
  mkdirSync(receipts, { recursive: true });
  writeFileSync(
    path.join(receipts, `${declared.stepNumber}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      checklist: declared.checklist,
      stepNumber: declared.stepNumber,
      command: declared.command,
      reference: declared.reference,
      inputHash: declared.inputHash,
      status: 'failed',
      exitCode: 2,
      finishedAt: new Date().toISOString(),
      logPath: 'artifacts/deterministic-checks/ci.log',
    })}\n`,
  );

  const noChange = run('no-change');
  assert.equal(noChange.status, 1, 'a receipt that was recorded and failed is still a failure');
  assert.match(noChange.stderr, /ci\.local_check/);
});
