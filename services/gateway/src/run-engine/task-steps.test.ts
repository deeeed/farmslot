import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunTicketData } from '@farmslot/protocol';

import { mergeInitialContextIntoTicketData } from './task-steps.js';

const trackerTicket: RunTicketData = {
  source: 'jira',
  title: 'Tracker title',
  description: 'Live tracker description',
  acceptanceCriteria: ['Tracker AC'],
  affectedArea: '',
  stepsToReproduce: [],
  screenshots: [],
  labels: [],
  jiraKey: 'TAT-78001',
};

test('tracker ticket data keeps live fields and gains structured backlog spec context', () => {
  const merged = mergeInitialContextIntoTicketData(
    trackerTicket,
    [
      'Backlog markdown spec (.backlog/specs/tat-78001.md):',
      '',
      '## Acceptance Criteria',
      '',
      '- Spec AC',
      '',
      '## Backlog Notes',
      '',
      'Operator note',
      '',
      '## Backlog Source',
      '',
      'jira TAT-78001',
    ].join('\n'),
  );

  assert.equal(merged.jiraKey, 'TAT-78001');
  assert.match(merged.description, /Live tracker description/);
  assert.match(merged.description, /Backlog markdown spec/);
  // ACs land in acceptanceCriteria only — the appended context must not carry
  // the spec's AC section into the description a second time.
  assert.doesNotMatch(merged.description, /## Acceptance Criteria/);
  assert.match(merged.description, /Operator note/);
  assert.deepEqual(merged.acceptanceCriteria, ['Tracker AC', 'Spec AC']);
});

test('ticket context merge is idempotent across grade retries', () => {
  const context = '## Acceptance Criteria\n\n- Spec AC\n\n## Backlog Notes\n\nOperator note';
  const once = mergeInitialContextIntoTicketData(trackerTicket, context);
  const twice = mergeInitialContextIntoTicketData(once, context);

  assert.strictEqual(twice, once);
  assert.equal(twice.description.match(/Additional Farmslot context/g)?.length, 1);
  assert.deepEqual(twice.acceptanceCriteria, ['Tracker AC', 'Spec AC']);
});

test('a context that is only an AC section adds criteria without touching the description', () => {
  const merged = mergeInitialContextIntoTicketData(
    trackerTicket,
    '## Acceptance Criteria\n\n- Spec AC',
  );
  assert.equal(merged.description, trackerTicket.description);
  assert.deepEqual(merged.acceptanceCriteria, ['Tracker AC', 'Spec AC']);
});

test('manual ticket data already carrying the spec is not duplicated', () => {
  const manualTicket = {
    ...trackerTicket,
    source: 'manual' as const,
    description: '## Acceptance Criteria\n\n- Spec AC',
    acceptanceCriteria: ['Spec AC'],
  };

  assert.strictEqual(
    mergeInitialContextIntoTicketData(manualTicket, manualTicket.description),
    manualTicket,
  );
});

test('tracker fetch fallback still gains the attached spec', () => {
  const fallbackTicket = {
    ...trackerTicket,
    source: 'manual' as const,
    description: '',
    acceptanceCriteria: [],
  };
  const merged = mergeInitialContextIntoTicketData(
    fallbackTicket,
    [
      'Backlog markdown spec (.backlog/specs/tat-78001.md):',
      '## Acceptance Criteria',
      '- Spec AC',
      '',
      'Backlog notes:',
      'Legacy queued note',
      '',
      'Backlog source: jira TAT-78001',
    ].join('\n'),
  );

  assert.match(merged.description, /Backlog markdown spec/);
  assert.deepEqual(merged.acceptanceCriteria, ['Spec AC']);
});
