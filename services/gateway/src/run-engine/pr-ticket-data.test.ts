import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { type Run, runLinkedTicketRefs, type RunTicketData } from '@farmslot/protocol';

const runs = new Map<string, Run>();
let body = '';
let jiraRequests = 0;
let linkRefreshes = 0;
let configured = true;
const requestedKeys: string[] = [];
mock.module('../runs/store.js', {
  namedExports: {
    getRun: (id: string) => runs.get(id),
    updateRun: (id: string, patch: Partial<Run>) => {
      const run = { ...runs.get(id)!, ...patch };
      runs.set(id, run);
      return run;
    },
  },
});
mock.module('../external/github.js', {
  namedExports: {
    fetchGitHubPR: async () => ({ title: 'PR title', body, branch: 'fix/symbols' }),
    fetchGitHubIssue: async () => {
      throw new Error('unexpected issue lookup');
    },
  },
});
mock.module('../external/jira.js', {
  namedExports: {
    fetchJiraIssue: async (key: string) => {
      jiraRequests++;
      requestedKeys.push(key);
      return {
        source: 'jira',
        jiraKey: key,
        title: `Ticket ${key}`,
        description: `Content ${key}`,
      };
    },
    resolveJiraAuth: () => ({ email: '', token: '' }),
  },
});
mock.module('./project-vars.js', {
  namedExports: {
    loadProjectVarsOrNull: async () =>
      configured
        ? { projectJson: { jira: { project: 'TAT', base_url: 'https://jira.example.test' } } }
        : null,
  },
});
mock.module('./run-links.js', {
  namedExports: {
    refreshRunLinks: async () => {
      linkRefreshes++;
    },
  },
});
const { fetchPRData } = await import('./ticket-data.js');

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run',
    familyId: 'run',
    parentRunId: null,
    familyRootTicketOrPr: 'owner/repo#38127',
    lane: 'production',
    variant: null,
    flowType: 'review-pr',
    mode: 'autonomous',
    status: 'writing-task',
    project: 'mobile',
    ticketOrPr: 'owner/repo#38127',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: '',
      runner: '',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...overrides,
  };
}

test('PR body ticket-like text never creates ticket refs or Jira requests', async () => {
  body = '# TAT-9999\nHIP-3 and EIP-1193\nAC-1: TAT-9999 is body text, not an explicit ticket.';
  runs.set('run', run());
  jiraRequests = 0;
  linkRefreshes = 0;
  await fetchPRData('run');
  const data = runs.get('run')!.ticketData!;
  assert.equal(data.description, body);
  assert.equal(data.jiraKey, undefined);
  assert.deepEqual(data.linkedTickets ?? [], []);
  assert.equal(jiraRequests, 0);
  assert.equal(linkRefreshes, 1);
  assert.equal(data.githubIssue, 'owner/repo#38127');
});

const explicit: RunTicketData = {
  source: 'jira',
  title: 'Dispatch ticket',
  description: 'Dispatch context',
  acceptanceCriteria: [],
  affectedArea: '',
  stepsToReproduce: [],
  screenshots: [],
  labels: [],
  jiraKey: 'TAT-4184',
  linkedTickets: [
    {
      ref: 'TAT-4187',
      url: 'https://jira.example.test/browse/TAT-4187',
      title: 'Related dispatch ticket',
      description: 'Related dispatch content',
      source: 'jira',
    },
  ],
};

test('PR templates enrich dispatch refs without promoting operator additions', async () => {
  body = 'HIP-3, AC-1 and TAT-9999 are prose.';
  const source = run({
    ticketData: structuredClone(explicit),
    linkedTicketRefs: ['TAT-5000', 'TAT-4187'],
  });
  runs.set('run', source);
  requestedKeys.length = 0;
  await fetchPRData('run');
  assert.deepEqual(requestedKeys, ['TAT-4184', 'TAT-4187']);
  assert.deepEqual(runs.get('run')!.linkedTicketRefs, source.linkedTicketRefs);
  assert.deepEqual(
    runs.get('run')!.ticketData!.linkedTickets?.map((t) => [t.ref, t.description]),
    [
      ['TAT-4184', 'Content TAT-4184'],
      ['TAT-4187', 'Content TAT-4187'],
    ],
  );
});

test('a missing Jira config does not erase explicit dispatch references or their content', async () => {
  configured = false;
  try {
    body = 'AC-1 and TAT-9999 are not references.';
    runs.set('run', run({ ticketData: structuredClone(explicit) }));
    await fetchPRData('run');
    assert.equal(runs.get('run')!.ticketData!.jiraKey, explicit.jiraKey);
    assert.deepEqual(runs.get('run')!.ticketData!.linkedTickets, explicit.linkedTickets);
  } finally {
    configured = true;
  }
});

test('removing an operator addition after PR enrichment preserves only dispatch references', async () => {
  body = '# TAT-9999\nHIP-3 and AC-1 are not tickets.';
  runs.set('run', run({ ticketData: structuredClone(explicit), linkedTicketRefs: ['TAT-5000'] }));
  await fetchPRData('run');
  const enriched = runs.get('run')!;
  assert.deepEqual(runLinkedTicketRefs(enriched), ['TAT-4184', 'TAT-4187', 'TAT-5000']);
  // The existing run.linkedTickets.set RPC changes only this metadata field.
  runs.set('run', { ...enriched, linkedTicketRefs: [] });
  await fetchPRData('run');
  const removed = runs.get('run')!;
  assert.deepEqual(runLinkedTicketRefs(removed), ['TAT-4184', 'TAT-4187']);
  assert.deepEqual(
    removed.ticketData!.linkedTickets?.map((t) => t.ref),
    ['TAT-4184', 'TAT-4187'],
  );
  assert.equal(removed.ticketData!.jiraKey, 'TAT-4184');
});
