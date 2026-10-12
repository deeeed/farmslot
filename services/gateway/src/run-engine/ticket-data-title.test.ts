import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRun } from '../family-observability/test-fixtures.js';

import { mergeInitialContextIntoTicketData } from './task-steps.js';
import { fetchTicketData } from './ticket-data.js';

test('free-text fetch derives a title once and preserves the full task description', async () => {
  const body = 'Fix the selected slot\n\nThe remaining task instructions must be preserved.';
  const data = await fetchTicketData(makeRun({ ticketOrPr: body }));
  assert.equal(data?.source, 'manual');
  assert.equal(data?.title, 'Fix the selected slot');
  assert.equal(data?.description, body);
});

for (const key of ['TAT-78001', 'ABC2-145']) {
  test(`${key} fetch fallback still merges its attached backlog spec and acceptance criteria`, async () => {
    const data = await fetchTicketData(
      makeRun({ project: 'missing-title-test-project', ticketOrPr: key }),
    );
    assert.equal(data?.source, 'manual');
    assert.equal(data?.description, '');
    const merged = mergeInitialContextIntoTicketData(
      data!,
      'Backlog specification\n\n## Acceptance Criteria\n- Preserve the attached specification',
    );
    assert.match(merged.description, /Backlog specification/);
    assert.deepEqual(merged.acceptanceCriteria, ['Preserve the attached specification']);
  });
}

test('free-text Markdown is not classified as a GitHub reference', async () => {
  const body = '# PR #112 native dispatch proof\n\nKeep the full task text.';
  const data = await fetchTicketData(makeRun({ ticketOrPr: body }));
  assert.equal(data?.title, 'PR #112 native dispatch proof');
  assert.equal(data?.description, body);
});
