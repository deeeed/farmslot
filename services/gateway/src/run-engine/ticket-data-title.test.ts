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
