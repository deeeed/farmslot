import assert from 'node:assert/strict';
import test from 'node:test';

import { assertValidTicketData } from './ticket-data-validation.js';

const ticket = {
  source: 'manual',
  title: 'Supplied scope',
  description: '',
  affectedArea: '',
  acceptanceCriteria: [],
  stepsToReproduce: [],
  screenshots: [],
  labels: [],
};

test('missing description names the exact ticket field', () => {
  const { description: _description, ...missing } = ticket;
  assert.throws(
    () => assertValidTicketData(missing),
    /Missing required field: ticketData\.description/,
  );
});

test('required ticket fields reject malformed values by name', () => {
  const cases: Array<[string, unknown]> = [
    ['description', null],
    ['title', 7],
    ['affectedArea', []],
    ['acceptanceCriteria', undefined],
    ['stepsToReproduce', 'one step'],
    ['screenshots', null],
    ['labels', [3]],
    ['source', 'unknown-tracker'],
  ];
  for (const [field, value] of cases) {
    assert.throws(
      () => assertValidTicketData({ ...ticket, [field]: value }),
      new RegExp('(?:Missing required|Invalid) field: ticketData\\.' + field),
    );
  }
});

test('ticket data must be an object when supplied', () => {
  for (const value of [null, [], 'ticket'])
    assert.throws(() => assertValidTicketData(value), /Invalid field: ticketData .*object/);
});

test('omitted ticket data and valid empty values remain accepted and unchanged', () => {
  const before = structuredClone(ticket);
  assert.doesNotThrow(() => assertValidTicketData(undefined));
  assert.doesNotThrow(() => assertValidTicketData(ticket));
  assert.deepEqual(ticket, before);
});
