import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
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
