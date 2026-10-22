import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunTicketData } from '../../src/contracts/runs.js';
import {
  normalizeRunLinkedTicketRefs,
  parseRunLinkedTicketRefs,
  runLinkedTicketRefs,
  runLinkedTicketsView,
} from '../../src/runs/linked-tickets.js';
import { selectRunList } from '../../src/runs/run-list-view.js';

const ticket: RunTicketData = {
  source: 'manual',
  title: 'Combined chart work',
  description:
    '## TEAM-100: Positions\nDetails reference OTHER-999 without adding its scope.\n## TEAM-200: Open orders\n## TEAM-300: Depth',
  acceptanceCriteria: [
    '[TEAM-100] Shows the position.',
    '[TEAM-200] Shows open orders.',
    'AC3: [TEAM-300] Shows depth.',
  ],
  affectedArea: '',
  stepsToReproduce: [],
  screenshots: [],
  labels: [],
  jiraKey: 'TEAM-100',
};
function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'chart',
    familyId: 'f1',
    lane: 'production',
    flowType: 'dev',
    status: 'done',
    project: 'fixture',
    ticketOrPr: 'TEAM-100',
    slotId: null,
    branch: 'fix/chart',
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    ticketData: structuredClone(ticket),
    links: [
      { label: 'Jira', url: 'https://tracker.example/browse/TEAM-100' },
      { label: 'PR', url: 'https://github.com/example/repo/pull/10' },
    ],
    ...overrides,
  };
}

test('one covered-ticket union uses canonical, ticket sections, AC prefixes and manual refs, without incidental prose links', () => {
  const source = run({ linkedTicketRefs: ['TEAM-400', 'TEAM-200'] });
  const before = structuredClone(source);
  assert.deepEqual(runLinkedTicketRefs(source), ['TEAM-100', 'TEAM-200', 'TEAM-300', 'TEAM-400']);
  assert.deepEqual(source, before);
});

test('searching a secondary covered key finds the completed run and its recorded PR', () => {
  const source = run();
  for (const key of ['team-200', 'TEAM-300']) {
    const matches = selectRunList([source], { scope: 'all', search: key });
    assert.deepEqual(
      matches.map((r) => r.id),
      ['chart'],
    );
    assert.equal(
      runLinkedTicketsView(matches[0]).pr?.url,
      'https://github.com/example/repo/pull/10',
    );
  }
  assert.deepEqual(selectRunList([source], { scope: 'all', search: 'OTHER-999' }), []);
});

test('operator additions normalize and reject malformed input, and removing them retains source-derived keys', () => {
  assert.deepEqual(normalizeRunLinkedTicketRefs([' team-400 ', 'TEAM-400']), ['TEAM-400']);
  for (const input of [['not-a-ticket'], ['https://tracker.example/browse/TEAM-1'], [2], null])
    assert.throws(() => normalizeRunLinkedTicketRefs(input), /Jira key/);
  assert.deepEqual(runLinkedTicketRefs(run({ linkedTicketRefs: [] })), [
    'TEAM-100',
    'TEAM-200',
    'TEAM-300',
  ]);
});

test('additional-ticket editors accept pasted whitespace, mixed separators and duplicate keys', () => {
  assert.deepEqual(parseRunLinkedTicketRefs(' \tteam-400, TEAM-500\nTEAM-400 '), [
    'TEAM-400',
    'TEAM-500',
  ]);
  assert.deepEqual(parseRunLinkedTicketRefs(' \n\t '), []);
  assert.throws(() => parseRunLinkedTicketRefs('TEAM-400,invalid'), /Jira key/);
});

test('prefetched tickets work for PR runs and known browse roots link operator-added keys', () => {
  const source = run({
    ticketOrPr: 'example/repo#10',
    ticketData: {
      ...ticket,
      description: '',
      acceptanceCriteria: [],
      jiraKey: undefined,
      linkedTickets: [
        {
          ref: 'TEAM-500',
          url: 'https://tracker.example/browse/TEAM-500',
          title: 'Related fix',
          description: '',
          source: 'jira',
        },
      ],
    },
    linkedTicketRefs: ['TEAM-600'],
  });
  const view = runLinkedTicketsView(source);
  assert.deepEqual(
    view.tickets.map(({ ref, url }) => ({ ref, url })),
    [
      { ref: 'TEAM-500', url: 'https://tracker.example/browse/TEAM-500' },
      { ref: 'TEAM-600', url: 'https://tracker.example/browse/TEAM-600' },
    ],
  );
  assert.deepEqual(view.operatorRefs, ['TEAM-600']);
});

test('unresolved URLs keep the covered key visible rather than inventing a tracker host', () => {
  const view = runLinkedTicketsView(run({ links: undefined }));
  assert.deepEqual(
    view.tickets.map((t) => t.url),
    [null, null, null],
  );
});
