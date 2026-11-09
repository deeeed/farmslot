import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeAcceptanceCriteria, renderAcceptanceCriteria } from './task-document.js';

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
