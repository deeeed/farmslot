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
  intent.contributions[0].ownerGeneration = 1;
  assert.deepEqual(preferRetainedReviewer(intent, 'project', workspaces, [prior]), []);
  prior.createdByPrincipalGeneration = prior.prWork!.review!.ownerGeneration = 1;
  assert.deepEqual(preferRetainedReviewer(intent, 'project', workspaces, [prior]), [workspaces[1]]);
});

test('a retained reviewer never crosses owner identity generations', () => {
  const select = (sourceGeneration?: number, priorGeneration?: number) => {
    const { intent, prior } = fixture();
    intent.contributions[0].ownerGeneration = sourceGeneration;
    prior.prWork!.review!.ownerGeneration = priorGeneration;
    return preferRetainedReviewer(intent, 'project', choices, [prior]);
  };
  assert.deepEqual(select(1, undefined), []);
  assert.deepEqual(select(undefined, 1), []);
  assert.deepEqual(select(1, 1), [choices[1]]);
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

test('expired WARM-only workspace intake retains an explicit cold fallback choice', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T00:00:00Z') });
  const { intent, prior } = fixture();
  prior.slotId = null;
  prior.transport = 'tmux';
  prior.createdByPrincipalId = prior.nativeOwnerPrincipalId = 'owner';
  prior.reviewWorkspace = {
    workspaceId: 'workspace',
    machine: 'machine-a',
    executionNodeId: 'machine-a',
    checkoutPath: '/owned/source',
    taskPath: '/owned/task',
    artifactPath: '/owned/task/artifacts',
    retainedAt: '2026-11-01T00:00:00Z',
    executionStoppedAt: '2026-11-01T00:00:00Z',
    retainedUntil: '2026-11-03T00:00:00Z',
  };
  Object.assign(prior.agentContexts![0], {
    id: 'review',
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: undefined,
  });
  const choice: PRExecutionChoice = {
    machine: 'machine-a',
    runner: 'codex',
    model: 'gpt-6-astra',
    transport: 'tmux',
    effort: null,
    mode: 'warm',
  };
  assert.deepEqual(preferRetainedReviewer(intent, 'project', [choice], [prior]), [
    { ...choice, mode: 'cold' },
  ]);
});

// Codex r6 on #2333: a PR rule asks for a warm Claude review with effort
// omitted, after the previous `high` review's workspace retention expired.
// Workspace continuity resolves the retained reviewer's effort onto the cold
// fallback session, and then this conversion dropped it — `choice.effort` is
// null for an omitted request, so the queue launched the next review with no
// effort at all and Claude fell back to its default. The whole point of the PR
// is that a continued review keeps the effort it was launched with.
test('an expired warm Claude review carries its recorded effort into the cold fallback', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T00:00:00Z') });
  const { intent, prior } = fixture();
  prior.slotId = null;
  prior.transport = 'tmux';
  prior.createdByPrincipalId = prior.nativeOwnerPrincipalId = 'owner';
  prior.metrics.runner = 'claude';
  prior.metrics.model = 'sonnet';
  prior.reviewWorkspace = {
    workspaceId: 'workspace',
    machine: 'machine-a',
    executionNodeId: 'machine-a',
    checkoutPath: '/owned/source',
    taskPath: '/owned/task',
    artifactPath: '/owned/task/artifacts',
    retainedAt: '2026-11-01T00:00:00Z',
    executionStoppedAt: '2026-11-01T00:00:00Z',
    retainedUntil: '2026-11-03T00:00:00Z',
  };
  Object.assign(prior.agentContexts![0], {
    id: 'review',
    runner: 'claude',
    model: 'sonnet',
    // What the expired review was launched with.
    effort: 'high',
  });
  const omitted: PRExecutionChoice = {
    machine: 'machine-a',
    runner: 'claude',
    model: 'sonnet',
    transport: 'tmux',
    // The rule did not ask for an effort, so the queue has none of its own.
    effort: null,
    mode: 'warm',
  };

  assert.deepEqual(preferRetainedReviewer(intent, 'project', [omitted], [prior]), [
    { ...omitted, mode: 'cold', effort: 'high' },
  ]);
});

// The other half of that line. A request that names its own effort is only
// compatible with a reviewer recorded at the same one (`continuity.ts:50`), so a
// different explicit effort is not a continuation at all and no retained
// preference is returned. What happens next is the caller's: under a warm-only
// rule the intent stays in `needs-configuration` until a cold choice is
// separately authorized (`dispatch.ts:345-353`), rather than launching from the
// pool. What this case pins is narrower and is the point: the carry above can
// never overwrite an explicit effort.
test('an explicit effort that differs from the retained one is not continued', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T00:00:00Z') });
  const { intent, prior } = fixture();
  prior.slotId = null;
  prior.transport = 'tmux';
  prior.createdByPrincipalId = prior.nativeOwnerPrincipalId = 'owner';
  prior.metrics.runner = 'claude';
  prior.metrics.model = 'sonnet';
  prior.reviewWorkspace = {
    workspaceId: 'workspace',
    machine: 'machine-a',
    executionNodeId: 'machine-a',
    checkoutPath: '/owned/source',
    taskPath: '/owned/task',
    artifactPath: '/owned/task/artifacts',
    retainedAt: '2026-11-01T00:00:00Z',
    executionStoppedAt: '2026-11-01T00:00:00Z',
    retainedUntil: '2026-11-03T00:00:00Z',
  };
  Object.assign(prior.agentContexts![0], {
    id: 'review',
    runner: 'claude',
    model: 'sonnet',
    effort: 'high',
  });
  const explicit: PRExecutionChoice = {
    machine: 'machine-a',
    runner: 'claude',
    model: 'sonnet',
    transport: 'tmux',
    effort: 'medium',
    mode: 'warm',
  };

  assert.deepEqual(preferRetainedReviewer(intent, 'project', [explicit], [prior]), []);
});
