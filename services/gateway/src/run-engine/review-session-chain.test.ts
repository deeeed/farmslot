import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { resolveRepeatReviewResumePlan } from './review-session-chain.js';
import { makeRun } from './test-fixtures.js';

function runs() {
  const prior = {
    ...makeRun({
      id: 'review-1',
      familyId: 'family-1',
      flowType: 'review-pr',
      status: 'done',
      project: 'farmslot-farm',
      ticketOrPr: 'deeeed/farmslot#1',
      slotId: 'slot-1',
    }),
    decisions: [
      {
        id: 'result',
        type: 'engine_review_posting',
        title: 'Review',
        description: 'Result',
        actions: [],
        createdAt: '2026-08-07',
        payload: {
          kind: 'review',
          repo: 'deeeed/farmslot',
          prNumber: 1,
          recommendation: 'issues',
          reviewMd: 'review.md',
          lineComments: [],
          reviewSnapshot: { headSha: '1111111', capturedAt: '2026-08-07', source: 'github-pr' },
        },
      },
    ],
    agentContexts: [
      {
        id: 'review-context-1',
        reviewId: 'review-lineage-1',
        role: 'review',
        label: 'Review',
        runner: 'codex',
        model: 'gpt-6-astra',
        slotId: 'slot-1',
        runId: 'review-1',
        runnerSessionId: 'session-1',
        runnerSessionPath: '/tmp/session-1.jsonl',
        status: 'complete',
        startedAt: '2026-08-07T00:00:00.000Z',
      },
    ],
  } satisfies Run;
  const current = makeRun({
    id: 'review-2',
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#1',
    slotId: 'slot-1',
    repeatReviewContext: {
      version: 1,
      chainId: prior.id,
      generation: 2,
      priorRunId: prior.id,
      priorFamilyId: prior.familyId,
      repository: 'deeeed/farmslot',
      prNumber: 1,
      priorReviewedHeadSha: '1111111',
      currentHeadSha: '2222222',
      verdict: 'issues',
      unresolvedFindings: [],
      artifactRefs: [],
      farmslotEvidenceRefs: [],
      mode: 'warm',
      session: { mode: 'warm', continuity: 'resumed', reviewId: 'review-lineage-1' },
      validationDepth: 'static-code',
      priorGenerations: [],
    },
  });
  return { current, prior };
}

test('repeat review resumes only the exact prior reviewer binding', () => {
  const { current, prior } = runs();
  assert.deepEqual(resolveRepeatReviewResumePlan(current, prior, 'codex'), {
    kind: 'resume',
    binding: {
      reviewId: 'review-lineage-1',
      repository: 'deeeed/farmslot',
      prNumber: 1,
      lastReviewedHeadSha: '1111111',
      priorRunId: 'review-1',
      contextId: 'review-context-1',
      runnerSessionId: 'session-1',
      runnerSessionPath: '/tmp/session-1.jsonl',
    },
  });
  assert.deepEqual(
    resolveRepeatReviewResumePlan({ ...current, slotId: 'slot-2' } as Run, prior, 'codex'),
    { kind: 'refused', reason: 'slot-mismatch' },
  );
  assert.deepEqual(resolveRepeatReviewResumePlan(current, prior, 'claude'), {
    kind: 'refused',
    reason: 'runner-mismatch',
  });
});

test('explicit COLD cannot resume a retained WARM context and unbound WARM cannot start fresh', () => {
  const { current, prior } = runs();
  assert.deepEqual(
    resolveRepeatReviewResumePlan({ ...current, reviewMode: 'cold' }, prior, 'codex'),
    { kind: 'fresh' },
  );
  assert.deepEqual(
    resolveRepeatReviewResumePlan(
      { ...current, reviewMode: 'warm', repeatReviewContext: undefined },
      prior,
      'codex',
    ),
    { kind: 'refused', reason: 'missing-session' },
  );
  assert.equal(
    resolveRepeatReviewResumePlan(
      {
        ...current,
        reviewMode: 'warm',
        repeatReviewContext: { ...current.repeatReviewContext!, mode: 'cold' },
      },
      prior,
      'codex',
    ).kind,
    'resume',
  );
});

test('a WARM pipeline selection leaves the pr-complete worker dispatch fresh', () => {
  const { current, prior } = runs();
  const pipeline = {
    ...current,
    flowType: 'pr-complete' as const,
    reviewMode: 'warm' as const,
    reviewContext: {
      reviewLineages: [
        { repository: 'deeeed/farmslot', prNumber: 1, reviewId: 'review-lineage-1' },
      ],
    },
    repeatReviewContext: undefined,
  };
  assert.deepEqual(resolveRepeatReviewResumePlan(pipeline, prior, 'codex'), { kind: 'fresh' });
  assert.deepEqual(
    resolveRepeatReviewResumePlan({ ...pipeline, flowType: 'review-pr' }, prior, 'codex'),
    { kind: 'refused', reason: 'missing-session' },
  );
});

test('an artifact-only primary review resumes from its immutable result without a posting gate', () => {
  const { current, prior } = runs();
  const payload = prior.decisions[0].payload;
  assert.equal(payload?.kind, 'review');
  if (payload?.kind !== 'review') throw new Error('fixture review result missing');
  const standalone: Run = {
    ...prior,
    decisions: [],
    reviewResult: {
      ...payload,
      session: {
        mode: 'cold',
        continuity: 'fresh',
        reviewId: 'review-lineage-1',
        sessionId: 'session-1',
        repository: 'deeeed/farmslot',
        prNumber: 1,
        lastReviewedHeadSha: '1111111',
      },
    },
  };
  assert.equal(resolveRepeatReviewResumePlan(current, standalone, 'codex').kind, 'resume');
  const foreign: Run = {
    ...standalone,
    reviewResult: {
      ...standalone.reviewResult!,
      session: { ...standalone.reviewResult!.session!, repository: 'foreign/repo' },
    },
  };
  assert.deepEqual(resolveRepeatReviewResumePlan(current, foreign, 'codex'), {
    kind: 'refused',
    reason: 'missing-session',
  });
});

test('reviewer continuity does not cross models or automation owners', () => {
  const { current, prior } = runs();
  assert.equal(
    resolveRepeatReviewResumePlan(current, prior, 'codex', 'gpt-6-astra').kind,
    'resume',
  );
  assert.deepEqual(resolveRepeatReviewResumePlan(current, prior, 'codex', 'different-model'), {
    kind: 'refused',
    reason: 'model-mismatch',
  });
  const work = {
    kind: 'review' as const,
    id: 'review:one',
    sourceId: 'intent-one',
    pr: { host: 'github.com', repo: 'owner/repo', number: 1 },
    headSha: 'head-a',
    review: {
      ownerId: 'owner',
      profile: 'standard',
      options: {
        mode: 'warm' as const,
      },
    },
  };
  assert.deepEqual(resolveRepeatReviewResumePlan({ ...current, prWork: work }, prior, 'codex'), {
    kind: 'refused',
    reason: 'missing-session',
  });
  assert.deepEqual(
    resolveRepeatReviewResumePlan(
      { ...current, prWork: work },
      {
        ...prior,
        prWork: { ...work, review: { ...work.review, ownerId: 'other' } },
      },
      'codex',
    ),
    { kind: 'refused', reason: 'missing-session' },
  );
});

test('native review continuity uses its owned stopped session without a tmux transcript path', () => {
  const { current, prior } = runs();
  const binding = {
    sessionId: 'native-session',
    generation: 'generation',
    leaseId: 'lease',
    commandId: 'initial',
    ownerPrincipalId: 'owner',
    executionNodeId: 'local',
    acceptedAt: 'accepted',
    closedAt: 'closed',
  };
  const nativePrior: Run = {
    ...prior,
    transport: 'native',
    nativeOwnerPrincipalId: 'owner',
    agentContexts: [
      { ...prior.agentContexts![0], runnerSessionPath: null, nativeSession: binding },
    ],
  };
  const nativeCurrent: Run = { ...current, transport: 'native', nativeOwnerPrincipalId: 'owner' };
  assert.deepEqual(
    resolveRepeatReviewResumePlan(nativeCurrent, nativePrior, 'codex', 'gpt-6-astra'),
    {
      kind: 'native-resume',
      binding: {
        reviewId: 'review-lineage-1',
        repository: 'deeeed/farmslot',
        prNumber: 1,
        lastReviewedHeadSha: '1111111',
        priorRunId: prior.id,
        contextId: prior.agentContexts![0].id,
        runnerSessionId: 'session-1',
      },
    },
  );
  for (const wrong of [
    { ...nativeCurrent, nativeOwnerPrincipalId: 'other' },
    { ...nativeCurrent, ticketOrPr: 'deeeed/farmslot#2' },
    {
      ...nativeCurrent,
      repeatReviewContext: { ...nativeCurrent.repeatReviewContext!, priorFamilyId: 'other' },
    },
  ])
    assert.equal(resolveRepeatReviewResumePlan(wrong, nativePrior, 'codex').kind, 'refused');
  const transferred = {
    ...nativePrior,
    agentContexts: [
      { ...nativePrior.agentContexts![0], nativeSession: { ...binding, releasedAt: 'released' } },
    ],
  };
  assert.equal(resolveRepeatReviewResumePlan(nativeCurrent, transferred, 'codex').kind, 'refused');
  assert.equal(resolveRepeatReviewResumePlan(current, nativePrior, 'codex').kind, 'refused');
});

test('COLD never resolves a retained session, and WARM without head evidence refuses', () => {
  const { current, prior } = runs();
  assert.deepEqual(
    resolveRepeatReviewResumePlan(
      { ...current, repeatReviewContext: { ...current.repeatReviewContext!, mode: 'cold' } },
      prior,
      'codex',
    ),
    { kind: 'fresh' },
  );
  assert.deepEqual(resolveRepeatReviewResumePlan(current, { ...prior, decisions: [] }, 'codex'), {
    kind: 'refused',
    reason: 'missing-session',
  });
  assert.deepEqual(resolveRepeatReviewResumePlan(current, prior, 'codex', 'gpt-6-astra', 'high'), {
    kind: 'refused',
    reason: 'effort-mismatch',
  });
  assert.deepEqual(
    resolveRepeatReviewResumePlan({ ...current, ticketOrPr: 'deeeed/farmslot#2' }, prior, 'codex'),
    { kind: 'refused', reason: 'pr-mismatch' },
  );
  assert.deepEqual(
    resolveRepeatReviewResumePlan(
      current,
      { ...prior, agentContexts: [{ ...prior.agentContexts![0], role: 'primary' }] },
      'codex',
    ),
    { kind: 'refused', reason: 'missing-session' },
  );
});

test('WARM requires explicit lineage and refuses an unrelated sibling reviewer', () => {
  const { current, prior } = runs();
  assert.deepEqual(
    resolveRepeatReviewResumePlan(
      { ...current, repeatReviewContext: { ...current.repeatReviewContext!, session: undefined } },
      prior,
      'codex',
    ),
    { kind: 'refused', reason: 'missing-session' },
  );
  const sibling = {
    ...prior.agentContexts![0],
    id: 'sibling',
    reviewId: 'another-review',
    runnerSessionId: 'sibling-session',
    completedAt: '2099-01-01',
  };
  const plan = resolveRepeatReviewResumePlan(
    current,
    { ...prior, agentContexts: [...prior.agentContexts!, sibling] },
    'codex',
  );
  assert.equal(plan.kind, 'resume');
  if (plan.kind === 'resume') assert.equal(plan.binding.runnerSessionId, 'session-1');
});
