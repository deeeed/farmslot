import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FamilyObservabilityRunSummary, RunLink, RunTicketData } from '@farmslot/protocol';

import {
  familyPrUrl,
  familyTicketUrl,
  pullNumberFromUrl,
  runSourceLinks,
} from './family-observability-link-model.js';

function link(label: string, url: string): RunLink {
  return { label, url };
}

function run(
  runId: string,
  ticketOrPr: string,
  links: RunLink[] = [],
  prNumber: number | null = null,
): FamilyObservabilityRunSummary {
  return { runId, ticketOrPr, links, prNumber } as unknown as FamilyObservabilityRunSummary;
}

test('pullNumberFromUrl anchors pull request numbers', () => {
  assert.equal(pullNumberFromUrl('https://github.com/org/repo/pull/5'), '5');
  assert.equal(pullNumberFromUrl('https://github.com/org/repo/pull/5/files'), '5');
  assert.equal(pullNumberFromUrl('https://github.com/org/repo/pull/50'), '50');
  assert.equal(pullNumberFromUrl('https://github.com/org/repo/pulls/5'), null);
});

test('familyTicketUrl resolves exact Jira and PR links without sibling false positives', () => {
  const selected = run('selected', 'PROJ-30', [
    link('wrong', 'https://jira.example/browse/PROJ-309'),
    link('right', 'https://jira.example/browse/PROJ-30'),
  ]);
  const sibling = run('sibling', 'PROJ-30', [
    link('fallback', 'https://jira.example/browse/PROJ-30?x=1'),
  ]);

  assert.equal(
    familyTicketUrl('PROJ-30', [sibling], selected),
    'https://jira.example/browse/PROJ-30',
  );
  assert.equal(familyTicketUrl('PROJ-31', [sibling], selected), null);

  const prRun = run('pr', 'example/repo#12', [
    link('PR', 'https://github.com/example/repo/pull/12/files'),
  ]);
  assert.equal(
    familyTicketUrl('example/repo#12', [prRun], null),
    'https://github.com/example/repo/pull/12/files',
  );
});

test('familyTicketUrl falls back to GitHub PR URL for owner/repo ticketOrPr', () => {
  assert.equal(
    familyTicketUrl('example/repo#77', [], null),
    'https://github.com/example/repo/pull/77',
  );
});

test('familyPrUrl prefers explicit PR links then ticket repo then sibling repo', () => {
  assert.equal(
    familyPrUrl(
      run(
        'with-link',
        'PROJ-1',
        [
          link('PR', 'https://github.com/example/repo/pull/50'),
          link('PR', 'https://github.com/example/repo/pull/5'),
        ],
        5,
      ),
      [],
    ),
    'https://github.com/example/repo/pull/5',
  );

  assert.equal(
    familyPrUrl(run('ticket-pr', 'example/repo#12', [], 12), []),
    'https://github.com/example/repo/pull/12',
  );

  assert.equal(
    familyPrUrl(run('jira', 'PROJ-1', [], 34), [run('sibling', 'example/repo#99')]),
    'https://github.com/example/repo/pull/34',
  );

  assert.equal(familyPrUrl(run('none', 'PROJ-1', [], null), []), null);
});

test('runSourceLinks names the Jira ticket and links it only once the gateway resolved it', () => {
  const ticketData = jiraSourceTicket('TAT-4006');
  assert.deepEqual(runSourceLinks({ ticketOrPr: 'TAT-4006', ticketData }), [
    { label: 'Jira', text: 'TAT-4006', url: null },
  ]);
  assert.deepEqual(
    runSourceLinks({
      ticketOrPr: 'TAT-4006',
      ticketData,
      links: [link('Jira', 'https://jira.example.invalid/browse/TAT-4006')],
      backlogItemId: 'bab0b56e-f019-46c3-96f1-0fa8fabdbc26',
    }),
    [
      { label: 'Jira', text: 'TAT-4006', url: 'https://jira.example.invalid/browse/TAT-4006' },
      {
        label: 'Backlog',
        text: 'bab0b56e',
        url: '#backlog?item=bab0b56e-f019-46c3-96f1-0fa8fabdbc26',
      },
    ],
  );
  assert.deepEqual(runSourceLinks({ ticketOrPr: 'adhoc' }), []);
});

function jiraSourceTicket(jiraKey: string): RunTicketData {
  return {
    source: 'jira',
    jiraKey,
    title: '',
    description: '',
    acceptanceCriteria: [],
    affectedArea: '',
    stepsToReproduce: [],
    screenshots: [],
    labels: [],
  };
}
