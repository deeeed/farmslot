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
    agentContexts: [
      {
        id: 'review-context-1',
        role: 'review',
        label: 'Independent review',
        runner: 'codex',
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
      contextMode: 'reuse',
      reviewScope: 'incremental',
      validationDepth: 'static-code',
      sessionIntent: 'resume',
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
      priorRunId: 'review-1',
      contextId: 'review-context-1',
      runnerSessionId: 'session-1',
      runnerSessionPath: '/tmp/session-1.jsonl',
    },
  });
  assert.deepEqual(
    resolveRepeatReviewResumePlan({ ...current, slotId: 'slot-2' } as Run, prior, 'codex'),
    { kind: 'fallback', reason: 'slot-mismatch' },
  );
  assert.deepEqual(resolveRepeatReviewResumePlan(current, prior, 'claude'), {
    kind: 'fallback',
    reason: 'runner-mismatch',
  });
});
