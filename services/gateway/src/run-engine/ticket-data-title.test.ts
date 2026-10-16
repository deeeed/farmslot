import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRun } from '../family-observability/test-fixtures.js';

import { fetchTicketData } from './ticket-data.js';

test('free-text fetch derives a title once and preserves the full task description', async () => {
  const body = 'Fix the selected slot\n\nThe remaining task instructions must be preserved.';
  const data = await fetchTicketData(makeRun({ ticketOrPr: body }));
  assert.equal(data?.source, 'manual');
  assert.equal(data?.title, 'Fix the selected slot');
  assert.equal(data?.description, body);
});

for (const key of ['TAT-78001', 'ABC2-145']) {
  test(`${key} without a Jira source refuses instead of a key-only ticket`, async () => {
    await assert.rejects(
      fetchTicketData(makeRun({ project: 'missing-title-test-project', ticketOrPr: key })),
      new RegExp(
        `^Error: ${key} is a Jira key, but project missing-title-test-project has no Jira source`,
      ),
    );
  });
}

test('free-text Markdown is not classified as a GitHub reference', async () => {
  const body = '# PR #112 native dispatch proof\n\nKeep the full task text.';
  const data = await fetchTicketData(makeRun({ ticketOrPr: body }));
  assert.equal(data?.title, 'PR #112 native dispatch proof');
  assert.equal(data?.description, body);
});
