import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { enumerateChecklistCheckboxes } from '@farmslot/protocol';

import {
  appendOperatorNoteStep,
  buildTaskDocument,
  normalizeAcceptanceCriteria,
  renderAcceptanceCriteria,
  renderReferenceCheckoutInputs,
} from './task-document.js';

const { rawTicketCriteria, ledgerCriteria } = JSON.parse(
  readFileSync(
    new URL('../../../protocol/test/fixtures/nested-list-criteria.json', import.meta.url),
    'utf8',
  ),
);

test('nested-list normalization preserves the existing ledger and TASK.md output', () => {
  const expected = ledgerCriteria.map(({ text }: { text: string }) => text);
  assert.deepEqual(normalizeAcceptanceCriteria(rawTicketCriteria), expected);
  assert.equal(
    renderAcceptanceCriteria(rawTicketCriteria),
    expected
      .map((text: string) => {
        const [first, ...rest] = text.split('\n');
        return [`- ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
      })
      .join('\n'),
  );
});

test('empty entries, blank lines and checkboxes keep the current normalization', () => {
  assert.deepEqual(
    normalizeAcceptanceCriteria(['', ' - [ ] First\n\n * [X] Child ', '* [x] ', 'Second']),
    ['First\nChild', 'Second'],
  );
  assert.equal(renderAcceptanceCriteria(['', ' * [ ] ']), '_Not specified_');
});

test('a task document lists every reference checkout the project declares, read-only', () => {
  const lines = renderReferenceCheckoutInputs([
    { name: 'mobile', path: '/dev/metamask/mobile-ref', present: true, headSha: 'aaa111' },
    { name: 'extension', path: '/dev/metamask/extension-ref', present: true, headSha: 'bbb222' },
  ]).join('\n');
  assert.match(lines, /### Reference checkouts \(read-only\)/);
  assert.match(lines, /- `mobile`: `\/dev\/metamask\/mobile-ref` at `aaa111`/);
  assert.match(lines, /- `extension`: `\/dev\/metamask\/extension-ref` at `bbb222`/);
  assert.match(lines, /never write, build or install in them/);
  assert.match(lines, /`reference-checkouts\.json`/);
});

test('a reference checkout the machine lacks reads as blocked, never as unchecked', () => {
  const lines = renderReferenceCheckoutInputs([
    { name: 'mobile', path: '/dev/metamask/mobile-ref', present: false },
  ]).join('\n');
  assert.match(lines, /- `mobile`: not readable from this task/);
  // The reviewer's checklist records BLOCKED or NOT_CHECKED; name the one it means.
  assert.match(lines, /BLOCKED, never NOT_CHECKED/);
  assert.ok(!lines.includes('/dev/metamask/mobile-ref` at'), 'no revision is claimed for it');
});

test('a project with no reference repos adds nothing to the inputs', () => {
  assert.deepEqual(renderReferenceCheckoutInputs(undefined), []);
  assert.deepEqual(renderReferenceCheckoutInputs([]), []);
});

test('a reference with uncommitted changes is not described by its revision alone', () => {
  const lines = renderReferenceCheckoutInputs([
    { name: 'core', path: '/dev/metamask/core-ref', present: true, headSha: 'eee555', dirty: true },
  ]).join('\n');
  assert.match(lines, /- `core`: `\/dev\/metamask\/core-ref` at `eee555`/);
  assert.match(lines, /uncommitted changes are present, so cite what you read/);
});

// Run 1b7b8662 (pr-complete, MetaMask/metamask-mobile#39654) put the operator's
// repin instruction on line 945 of a 947-line TASK.md, and the worker never did
// it. The note is the operator's override, so it is read before the task it
// overrides, not after 800 lines of context.
test('an operator note is rendered before the Task block, exactly once', () => {
  const note = 'Repin #39654 onto the combined Core preview before anything else.';
  const document = buildTaskDocument({
    flowType: 'pr-complete',
    modePreamble: '> Autonomous execution: complete the authorized work.',
    vars: { TASK_DIR: '/tmp/task', TICKET: 'TAT-4571', TITLE: 'Align perps formatting' },
    description: 'x'.repeat(4000),
    acceptanceCriteria: ['Formatting matches the shared surface'],
    hasTicketData: false,
    operatorNote: note,
  });
  assert.equal(document.match(/^## Operator note$/gm)?.length, 1);
  assert.ok(
    document.indexOf('## Operator note') < document.indexOf('## Task'),
    'the note precedes the Task block',
  );
  assert.match(
    document,
    new RegExp(`## Operator note\\n[\\s\\S]*${note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  // The heading must not collide with CHECKLIST_SKIP_SECTIONS, which swallows a
  // section called "Task", "Description", "Comments" and friends.
  assert.doesNotMatch(document, /^## Task note$/m);
});

test('a task document without an operator note carries no note heading', () => {
  const document = buildTaskDocument({
    flowType: 'fix-bug',
    modePreamble: '',
    vars: { TASK_DIR: '/tmp/task', TICKET: 'TAT-1', TITLE: 'No note' },
    description: 'Body',
    acceptanceCriteria: ['Something'],
    hasTicketData: false,
  });
  assert.doesNotMatch(document, /^## Operator note$/m);
});

// C: the note becomes a step the worker must mark. It is APPENDED, never
// inserted: the worker-terminal contract freezes proof, deterministic and
// optional declarations by stepNumber (write.ts freezeChecklistDeclarations),
// and templates carry internal references like `mark 14`. Appending shifts
// nothing.
test('an operator note appends one final checklist step and renumbers nothing', () => {
  const checklist = [
    '# PR-complete checklist',
    '',
    '## Setup',
    '',
    '- [ ] 1. Start the task',
    '  `mark start`, then `mark 1`.',
    '- [ ] 2. Confirm the PR branch',
    '  Run `git branch --show-current`.',
    '',
    '## Finish',
    '',
    '- [ ] 3. Complete',
    '  `mark complete`.',
    '',
  ].join('\n');
  const before = enumerateChecklistCheckboxes(checklist);
  assert.deepEqual(
    before.map((item) => item.stepNumber),
    [1, 2, 3],
  );

  const withNote = appendOperatorNoteStep(
    checklist,
    '/tmp/task',
    'Repin onto the combined preview.',
  );
  const after = enumerateChecklistCheckboxes(withNote);
  assert.equal(after.length, before.length + 1);
  // Every pre-existing step keeps its number and its text.
  for (const [index, item] of before.entries()) {
    assert.equal(after[index].stepNumber, item.stepNumber);
    assert.equal(after[index].rawLabel, item.rawLabel);
  }
  const appended = after[after.length - 1];
  assert.equal(appended.stepNumber, 4);
  assert.match(appended.rawLabel, /4\. Carry out the operator note/);
  // It points at the section A renders, so the worker does not have to search.
  assert.match(withNote, /## Operator note/);
  assert.ok(withNote.startsWith(checklist.trimEnd()), 'the template is appended to, not rewritten');
});

test('no operator note leaves the checklist byte-identical', () => {
  const checklist = '# Checklist\n\n- [ ] 1. Only step\n';
  assert.equal(appendOperatorNoteStep(checklist, '/tmp/task', ''), checklist);
  assert.equal(appendOperatorNoteStep(checklist, '/tmp/task', undefined), checklist);
});
