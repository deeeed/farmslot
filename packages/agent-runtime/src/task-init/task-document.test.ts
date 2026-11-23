import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { enumerateChecklistCheckboxes } from '@farmslot/protocol';

import {
  buildTaskDocument,
  insertOperatorNoteStep,
  insertUnderTitle,
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

// The note becomes a step the worker must mark. It is inserted BEFORE the
// checklist's last row, because every farm template ends with its
// `mark complete --mark-last` row: a step after that row leaves two boxes open,
// so --mark-last refuses, and once the worker ticks the completion row to get
// past that, --mark-last ticks this one for them. The note would be claimed
// without being carried out.
test('an operator note step goes in front of the completion row, renumbering it', () => {
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
    '- [ ] **3. Signal completion** — run: `mark complete --mark-last`',
    '',
  ].join('\n');

  const withNote = insertOperatorNoteStep(checklist, 'temp/tasks/x', 'Repin onto the preview.');
  const after = enumerateChecklistCheckboxes(withNote);
  assert.equal(after.length, 4);
  // The note is second to last; the completion row stays last.
  assert.match(after[2].rawLabel, /Carry out the operator note/);
  assert.match(after[3].rawLabel, /Signal completion/);
  // Every label's printed number matches the number `mark N` targets, including
  // the completion row that moved from 3 to 4.
  for (const item of after) {
    const printed = item.rawLabel.match(/^(?:\*\*)?(\d+)\./);
    assert.ok(printed, `step ${item.stepNumber} prints its number`);
    assert.equal(Number(printed[1]), item.stepNumber);
  }
  // Steps before the insertion keep their numbers and their text.
  const before = enumerateChecklistCheckboxes(checklist);
  for (const index of [0, 1]) {
    assert.equal(after[index].stepNumber, before[index].stepNumber);
    assert.equal(after[index].rawLabel, before[index].rawLabel);
  }
  assert.match(withNote, /## Operator note/);
});

test('no operator note leaves the checklist byte-identical', () => {
  const checklist = '# Checklist\n\n- [ ] 1. Only step\n';
  assert.equal(insertOperatorNoteStep(checklist, '/tmp/task', ''), checklist);
  assert.equal(insertOperatorNoteStep(checklist, '/tmp/task', undefined), checklist);
});

// A rendered lightweight template opens with a frontmatter fence, so a regex
// anchored at `^#` matches nothing and the section is silently lost.
test('a section is inserted under the title even behind a frontmatter fence', () => {
  const template = [
    '---',
    'checklist: none',
    '---',
    '',
    '# Worker: Interactive Dev',
    '',
    'Body.',
  ].join('\n');
  const placed = insertUnderTitle(template, '## Operator note\n\nRepin first.');
  assert.ok(
    placed.indexOf('## Operator note') > placed.indexOf('# Worker: Interactive Dev'),
    'the note follows the title',
  );
  assert.ok(placed.indexOf('## Operator note') < placed.indexOf('Body.'), 'and precedes the body');
  assert.ok(placed.startsWith('---\nchecklist: none\n---'), 'the frontmatter is untouched');
});

test('a document with no heading still keeps the section, and an empty one changes nothing', () => {
  assert.match(insertUnderTitle('Just prose.\n', '## Operator note\n\nDo it.'), /## Operator note/);
  assert.equal(insertUnderTitle('# Title\n\nBody.\n', ''), '# Title\n\nBody.\n');
});
