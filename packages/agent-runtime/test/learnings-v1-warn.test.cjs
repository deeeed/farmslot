// Learnings v1 (ADR-026 Amendment 4): the mark step warns on a v1 file's issues
// while the worker can still fix it, and never refuses a step or a finished run.
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const mark = path.join(root, 'scripts', 'mark-checklist-step.cjs');
const contract = path.join(root, 'scripts', 'check-task-artifact-contract.mjs');
const { CHECKLIST_TARGET_MANIFEST } = require('../scripts/checklist-target.cjs');

function task(learnings) {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-learnings-v1-'));
  writeFileSync(
    path.join(dir, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: 'CHECKLIST.md' })}\n`,
  );
  writeFileSync(
    path.join(dir, 'CHECKLIST.md'),
    '# Worker: Feature — DEMO-1\n\n- [ ] First gate\n- [ ] Write learnings\n',
  );
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(dir, 'artifacts', 'report.md'), '# Report\n\nDone.\n');
  if (learnings !== undefined)
    writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), learnings);
  return dir;
}
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const BROKEN =
  '# Learnings v1\n\n- edit: A placeholder reached a validator.\n  evidence: app/a.ts:3\n';

test('a step mark warns on v1 issues and still marks the step', (t) => {
  const dir = task(BROKEN);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run(mark, [dir, '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /LEARNINGS_V1_WARN artifacts\/learnings\.md/);
  assert.match(result.stderr, /- line 4: evidence must be "<repo> <path>:<line>"/);
  assert.match(result.stderr, /- line 3: edit needs family/);
  assert.match(
    result.stderr,
    /confirmation {2}run <other run id>/,
    'prints the format to fix against',
  );
  assert.match(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /- \[x\] First gate/);
});

test('completion warns on v1 issues and never fails the run on format', (t) => {
  const dir = task(BROKEN);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(run(mark, [dir, '1']).status, 0);
  const result = run(mark, [dir, 'complete', '--mark-last']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /LEARNINGS_V1_WARN/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8')).status, 'complete');
  const checked = run(contract, [dir, '--require-learnings']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, /LEARNINGS_V1_WARN/);
});

test('a valid v1 file, a legacy file and a task without learnings stay quiet', (t) => {
  for (const learnings of [
    '# Learnings v1\n\n- None\n',
    '- Nothing relevant to recur.\n',
    undefined,
  ]) {
    const dir = task(learnings);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const result = run(mark, [dir, '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /LEARNINGS_V1_WARN/, String(learnings));
  }
});
