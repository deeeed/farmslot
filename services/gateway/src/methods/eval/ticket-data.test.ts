import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBlindTicketData } from './ticket-data.js';

test('blind ticket keeps the authored acceptance section in order', () => {
  const problem = [
    'Correct the position ratio.',
    '',
    'Expected behavior: Position ratios use fractions.',
    '',
    'Acceptance criteria:',
    '- AC-1: The position ratio uses the documented fraction.',
    '- AC-2: The account-state ratio retains its current unit.',
    '- AC-3: Tests pin both position and account-state units.',
  ].join('\n');
  const ticket = buildBlindTicketData(problem);
  assert.equal(ticket.title, 'Correct the position ratio.');
  assert.equal(ticket.description, problem);
  assert.deepEqual(ticket.acceptanceCriteria, [
    'AC-1: The position ratio uses the documented fraction.',
    'AC-2: The account-state ratio retains its current unit.',
    'AC-3: Tests pin both position and account-state units.',
  ]);
});

test('blind ticket recovers labeled criteria without a section', () => {
  assert.deepEqual(
    buildBlindTicketData('Correct the ratio.\n\nAC1: Use fractions.\n\nAC2: Retain account units.')
      .acceptanceCriteria,
    ['Use fractions.', 'Retain account units.'],
  );
});

test('blind ticket retains the fallback when no criteria are authored', () => {
  assert.deepEqual(buildBlindTicketData('Correct the ratio.').acceptanceCriteria, [
    'Satisfy the supplied problem statement and retain local artifacts.',
  ]);
});

test('frozen proof criteria take precedence and are copied', () => {
  const criteria = ['Observe the supplied implementation.', 'Retain its proof.'];
  const ticket = buildBlindTicketData('Acceptance criteria:\n- A different criterion.', criteria);
  assert.deepEqual(ticket.acceptanceCriteria, criteria);
  ticket.acceptanceCriteria.push('Local mutation');
  assert.equal(criteria.length, 2);
  assert.deepEqual(buildBlindTicketData('AC1: Do not infer this.', []).acceptanceCriteria, []);
});
