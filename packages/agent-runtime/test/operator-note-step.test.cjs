// The operator-note step, through the real mark engine.
//
// Appending the step after the template's terminal `mark complete --mark-last`
// row looked harmless and was not: two open boxes make --mark-last refuse, and
// once the worker ticks the completion row to get past that, --mark-last ticks
// the note step for them. The note would be recorded as done without being done,
// which is the failure the step exists to prevent (run 1b7b8662).
//
// This exercises the shipped checklist, not a hand-written one: it is built by
// insertOperatorNoteStep from a template shaped like pr-complete.md.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts', 'mark-checklist-step.cjs');
const { CHECKLIST_TARGET_MANIFEST } = require('../scripts/checklist-target.cjs');
const { enumerateChecklistCheckboxes } = require('../scripts/checklist-target.cjs');

// The same shape every farm template ends with: the last row is the completion
// command (pr-complete.md:62, fix-bug.md:98, review-pr.md:91, update-branch.md:41).
const TEMPLATE = [
  '# PR-complete checklist',
  '',
  '## Work',
  '',
  '- [ ] 1. Do the work',
  '  Make the change.',
  '',
  '## Finish',
  '',
  '- [ ] **2. Signal completion** — run: `mark complete --mark-last`',
  '',
].join('\n');

function taskDir(checklist) {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-operator-note-'));
  writeFileSync(
    path.join(dir, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: 'CHECKLIST.md' }, null, 2)}\n`,
  );
  writeFileSync(path.join(dir, 'CHECKLIST.md'), checklist);
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- Nothing relevant.\n');
  writeFileSync(path.join(dir, 'artifacts', 'report.md'), '# Report\n\nDone.\n');
  return dir;
}

const mark = (dir, ...args) =>
  spawnSync(process.execPath, [helper, dir, ...args], { encoding: 'utf8' });

// What this PR ships: the note sits in front of the completion row.
const { insertOperatorNoteStep } = require('../dist/task-init/task-document.js');
const shipped = insertOperatorNoteStep(TEMPLATE, 'temp/tasks/demo', 'Repin onto the preview.');
const items = enumerateChecklistCheckboxes(shipped);
assert.equal(items.length, 3);
assert.match(items[1].rawLabel, /Carry out the operator note/);
assert.match(items[2].rawLabel, /Signal completion/);

{
  // The worker walks the checklist in order and the note is not the last box, so
  // `--mark-last` has exactly one box left — the completion row it belongs to.
  const dir = taskDir(shipped);
  assert.equal(mark(dir, '1').status, 0);
  const note = mark(dir, '2');
  assert.equal(note.status, 0, note.stderr);
  const complete = mark(dir, 'complete', '--mark-last');
  assert.equal(complete.status, 0, complete.stderr);
  const final = readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8');
  assert.equal(
    enumerateChecklistCheckboxes(final).filter((item) => !item.checked).length,
    0,
    'every step is marked',
  );
}

{
  // A worker that skips the note cannot get past it: the order rule refuses a
  // later step while an earlier one is open, so the note cannot be silently lost.
  const dir = taskDir(shipped);
  assert.equal(mark(dir, '1').status, 0);
  const skipped = mark(dir, 'complete', '--mark-last');
  assert.notEqual(skipped.status, 0, 'completion is refused while the note step is open');
  assert.match(skipped.stderr, /checklist incomplete/);
}

{
  // The regression itself: with the step APPENDED after the completion row,
  // `--mark-last` ticks the note for the worker. Built here, never shipped.
  const appended = `${TEMPLATE.trimEnd()}\n- [ ] 3. Carry out the operator note\n`;
  const dir = taskDir(appended);
  assert.equal(mark(dir, '1').status, 0);
  assert.equal(mark(dir, '2').status, 0);
  const complete = mark(dir, 'complete', '--mark-last');
  assert.equal(complete.status, 0, complete.stderr);
  const final = readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8');
  const noteItem = enumerateChecklistCheckboxes(final)[2];
  assert.match(noteItem.rawLabel, /Carry out the operator note/);
  assert.equal(
    noteItem.checked,
    true,
    'appending lets --mark-last tick the note step the worker never did — why it is inserted instead',
  );
}

console.log('operator-note-step: ok');
