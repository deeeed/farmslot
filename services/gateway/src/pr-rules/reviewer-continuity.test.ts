import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRExecutionChoice, PRReviewIntent, Run } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';

import { preferRetainedReviewer } from './reviewer-continuity.js';

const choices: PRExecutionChoice[] = [
  {
    slotId: 'slot-b',
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    mode: 'warm' as const,
  },
  {
    slotId: 'slot-a',
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    mode: 'warm' as const,
  },
];

function fixture(): { intent: PRReviewIntent; prior: Run } {
  const pr = { host: 'github.com', repo: 'owner/repo', number: 42 };
  const intent: PRReviewIntent = {
    id: 'new-intent',
    pr,
    headSha: 'new-head',
    reviewProfile: 'standard',
    status: 'held',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contributions: [
      {
        ruleId: 'rule',
        ruleRevision: 1,
        teamId: 'team',
        teamRevision: 1,
        ownerId: 'owner',
        reasons: [],
        autoStart: true,
        eligible: true,
        configurationErrors: [],
        project: 'project',
        review: {
          mode: 'warm' as const,
          reviewContext: {
            reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: 'lineage-a' }],
          },
        },
      },
    ],
  };
  const prior: Run = {
    ...makeRun({
      id: 'review-a',
      flowType: 'review-pr',
      project: 'project',
      ticketOrPr: 'owner/repo#42',
      status: 'done',
      slotId: 'slot-a',
    }),
    prWork: {
      kind: 'review',
      id: 'review:old-intent',
      sourceId: 'old-intent',
      pr,
      headSha: 'old-head',
      review: {
        ownerId: 'owner',
        profile: 'standard',
        options: { mode: 'cold' as const },
      },
    },
    decisions: [
      {
        id: 'review-result',
        type: 'engine_review_posting',
        title: 'Review',
        description: 'Review',
        actions: [],
        createdAt: new Date().toISOString(),
        payload: {
          kind: 'review',
          repo: 'owner/repo',
          prNumber: 42,
          recommendation: 'pass',
          reviewMd: 'review.md',
          lineComments: [],
          reviewSnapshot: {
            headSha: 'old-head',
            capturedAt: new Date().toISOString(),
            source: 'github-pr',
          },
        },
      },
    ],
    agentContexts: [
      {
        id: 'context-a',
        reviewId: 'lineage-a',
        role: 'review',
        label: 'Reviewer',
        runner: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        slotId: 'slot-a',
        runId: 'review-a',
        runnerSessionId: 'session-a',
        runnerSessionPath: '/tmp/session-a.jsonl',
        status: 'complete',
      },
    ],
  };
  return { intent, prior };
}

test('a slot reused for another PR still selects the original PR reviewer session', () => {
  const { intent, prior } = fixture();
  const differentPR: Run = {
    ...prior,
    id: 'review-b',
    ticketOrPr: 'owner/repo#43',
    completedAt: new Date().toISOString(),
    prWork: { ...prior.prWork!, pr: { ...prior.prWork!.pr, number: 43 } },
    agentContexts: [
      {
        ...prior.agentContexts![0],
        runId: 'review-b',
        runnerSessionId: 'session-b',
        runnerSessionPath: '/tmp/session-b.jsonl',
      },
    ],
  };
  assert.deepEqual(preferRetainedReviewer(intent, 'project', choices, [prior, differentPR]), [
    choices[1],
  ]);
  assert.deepEqual(
    preferRetainedReviewer(intent, 'project', [choices[0]], [prior, differentPR]),
    [],
  );
});

test('WARM refuses missing compatible placement; explicit COLD uses the pool', () => {
  const { intent, prior } = fixture();
  assert.deepEqual(preferRetainedReviewer(intent, 'project', choices, [prior]), [choices[1]]);
  intent.contributions[0].review!.mode = 'cold';
  const coldChoices = choices.map((choice) => ({ ...choice, mode: 'cold' as const }));
  assert.deepEqual(preferRetainedReviewer(intent, 'project', coldChoices, [prior]), coldChoices);
  intent.contributions[0].review!.mode = 'warm';
  prior.prWork!.review!.ownerId = 'another-owner';
  assert.deepEqual(preferRetainedReviewer(intent, 'project', choices, [prior]), []);
});

test('QA does not inherit static reviewer session placement', () => {
  const { intent, prior } = fixture();
  intent.contributions[0].review = {
    mode: 'cold' as const,
    workflow: 'qa',
    qaProfileId: 'changes',
  };
  assert.deepEqual(preferRetainedReviewer(intent, 'project', choices, [prior]), choices);
});

test('workspace automation prefers the machine holding the compatible retained reviewer', () => {
  const { intent, prior } = fixture();
  prior.slotId = null;
  prior.transport = 'tmux';
  prior.createdByPrincipalId = prior.nativeOwnerPrincipalId = 'owner';
  prior.reviewWorkspace = { machine: 'machine-a' } as Run['reviewWorkspace'];
  prior.agentContexts![0] = {
    ...prior.agentContexts![0],
    id: 'review',
    runner: 'cursor',
    model: 'composer-2.5',
    effort: undefined,
  };
  const workspaces: PRExecutionChoice[] = [
    {
      machine: 'machine-b',
      runner: 'cursor',
      model: 'composer-2.5',
      transport: 'tmux',
      effort: null,
      mode: 'warm' as const,
    },
    {
      machine: 'machine-a',
      runner: 'cursor',
      model: 'composer-2.5',
      transport: 'tmux',
      effort: null,
      mode: 'warm' as const,
    },
  ];
  assert.deepEqual(preferRetainedReviewer(intent, 'project', workspaces, [prior]), [workspaces[1]]);
  assert.deepEqual(preferRetainedReviewer(intent, 'project', [workspaces[0]], [prior]), []);
});

test('WARM requires explicit matching review context even when the PR and runner match', () => {
  const { intent, prior } = fixture();
  intent.contributions[0].review!.reviewContext = undefined;
  assert.deepEqual(preferRetainedReviewer(intent, 'project', choices, [prior]), []);
  intent.contributions[0].review!.reviewContext = {
    reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: 'another-review' }],
  };
  assert.deepEqual(preferRetainedReviewer(intent, 'project', choices, [prior]), []);
});
