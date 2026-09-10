import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRExecutionChoice, PRReviewIntent, Run } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';

import { preferRetainedReviewer } from './reviewer-continuity.js';

const choices: PRExecutionChoice[] = [
  { slotId: 'slot-b', runner: 'codex', model: 'gpt-6-astra', effort: 'high' },
  { slotId: 'slot-a', runner: 'codex', model: 'gpt-6-astra', effort: 'high' },
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
        options: {
          sessionIntent: 'resume',
          scope: 'incremental',
          validationDepth: 'static-code',
        },
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
        role: 'review',
        label: 'Reviewer',
        runner: 'codex',
        model: 'gpt-6-astra',
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
  assert.deepEqual(preferRetainedReviewer(intent, 'project', [choices[0]], [prior, differentPR]), [
    choices[0],
  ]);
});

test('fresh-slot fallback and explicit Fresh honor the pool without transferring other owners contexts', () => {
  const { intent, prior } = fixture();
  intent.contributions[0].review = {
    sessionIntent: 'resume',
    scope: 'incremental',
    validationDepth: 'static-code',
    busySession: 'fresh',
  };
  assert.deepEqual(preferRetainedReviewer(intent, 'project', choices, [prior]), [
    choices[1],
    choices[0],
  ]);
  intent.contributions[0].review.sessionIntent = 'reset';
  assert.deepEqual(preferRetainedReviewer(intent, 'project', choices, [prior]), choices);
  intent.contributions[0].review.sessionIntent = 'resume';
  prior.prWork!.review!.ownerId = 'another-owner';
  assert.deepEqual(preferRetainedReviewer(intent, 'project', choices, [prior]), choices);
});
