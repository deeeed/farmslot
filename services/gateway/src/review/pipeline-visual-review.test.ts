import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  type AgentContext,
  type NativeSessionReadResult,
  PIPELINE_VISUAL_RESULT_SCHEMA,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  reviewedVisualFiles,
} from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';
const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-visual-review-'));
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_RUNS_DIR = path.join(directory, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(directory, 'pool');
const { createRun } = await import('../runs/store.js');
const { collectPipelineVisualResult, pipelineReviewerBinding, stampPipelineVisualReviews } =
  await import('./pipeline-visual-review.js');
after(() => rm(directory, { force: true, recursive: true }));

const input: RecordedEvidencePackageInput = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
      import.meta.url,
    ),
    'utf8',
  ),
).input;

function fixture() {
  const run = createRun(
    {
      project: 'pipeline-visual-test',
      flowType: 'dev',
      ticketOrPr: 'TEST-VISUAL',
      transport: 'tmux',
    },
    { deferBackgroundPersist: true },
  );
  const claim = input.claims!.criteria.find((c) => c.id === 'check-1')!;
  const reviewer: AgentContext = {
    id: 'review-native',
    role: 'review',
    label: 'Review',
    status: 'working',
    runId: run.id,
    slotId: run.slotId,
    runner: 'codex',
    model: 'test',
    runnerSessionId: 'review-conversation',
    pipelineVisualReviewInput: {
      headSha: 'a'.repeat(40),
      artifactPrefix: 'artifacts/recipe/',
      recipeRunId: input.claims!.recipeRunId,
      closureIdentity: recordedEvidenceClosureIdentity(input),
      claims: [
        {
          claimId: claim.id,
          text: claim.text,
          reviewedFiles: reviewedVisualFiles(input, claim.id),
          moments: claim.moments,
        },
      ],
    },
    nativeSession: {
      sessionId: 'review-session',
      generation: 'generation',
      executionNodeId: 'local',
      leaseId: 'review-lease',
      commandId: 'review-command',
      ownerPrincipalId: 'profile-owner',
      resultSchema: PIPELINE_VISUAL_RESULT_SCHEMA,
      acceptedAt: '2026-10-16T00:00:00Z',
    },
  };
  run.agentContexts = [reviewer];
  const b = reviewer.nativeSession!;
  const snapshot: NativeSessionReadResult = {
    session: {
      id: b.sessionId,
      generation: b.generation!,
      workerLeaseId: b.leaseId,
      ownerPrincipalId: b.ownerPrincipalId,
      executionNodeId: b.executionNodeId,
      nativeSessionId: reviewer.runnerSessionId!,
      resultSchema: b.resultSchema,
      workerManaged: true,
      state: 'idle',
      hostPid: 1,
      runner: 'codex',
      accountContextId: 'account',
      cwd: '/fixture',
      executable: 'fixture',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: false,
        questions: false,
        interrupt: true,
        resume: true,
      },
    },
    events: [],
    cursor: 0,
    hasMore: false,
    pendingRequests: [],
    commands: [
      {
        generation: b.generation!,
        commandId: b.commandId,
        state: 'completed',
        submitted: true,
        accepted: true,
        outcome: 'completed',
        structuredResult: {
          schema: PIPELINE_VISUAL_RESULT_SCHEMA,
          value: {
            schemaVersion: 1,
            recipeRunId: input.claims!.recipeRunId,
            closureIdentity: recordedEvidenceClosureIdentity(input),
            judgments: [
              {
                claimId: claim.id,
                verdict: 'confirmed',
                reason: 'The recorded value is visible.',
                reviewedFiles: reviewedVisualFiles(input, claim.id),
                moments: claim.moments,
              },
            ],
          },
        },
      },
    ],
  };
  return { run, reviewer, snapshot };
}

test('native review results qualify on a tmux run without changing worker ownership', () => {
  const { run, reviewer, snapshot } = fixture();
  const result = collectPipelineVisualResult(run, reviewer, snapshot)!;
  assert.equal(result.binding.commandId, reviewer.nativeSession!.commandId);
  assert.equal(result.result.judgments[0]!.verdict, 'confirmed');
  assert.equal(run.transport, 'tmux');
  assert.equal(run.nativeOwnerPrincipalId, undefined);
});

test('signal or overall PASS cannot replace completed bound native result', () => {
  for (const change of [
    (s: NativeSessionReadResult) => {
      s.commands[0]!.state = 'accepted';
    },
    (s: NativeSessionReadResult) => {
      s.commands[0]!.commandId = 'another-command';
    },
    (s: NativeSessionReadResult) => {
      s.commands[0]!.generation = 'another-generation';
    },
    (s: NativeSessionReadResult) => {
      delete s.commands[0]!.structuredResult;
    },
    (s: NativeSessionReadResult) => {
      s.session.workerLeaseId = 'another-lease';
    },
    (s: NativeSessionReadResult) => {
      s.session.ownerPrincipalId = 'another-owner';
    },
    (s: NativeSessionReadResult) => {
      s.session.executionNodeId = 'another-node';
    },
    (s: NativeSessionReadResult) => {
      s.session.nativeSessionId = 'another-conversation';
    },
  ]) {
    const { run, reviewer, snapshot } = fixture();
    change(snapshot);
    assert.throws(
      () => collectPipelineVisualResult(run, reviewer, snapshot),
      /schema-bound completed/,
    );
  }
});

test('visual collection refuses different stills, moments, ACs and execution closures', () => {
  for (const field of ['recipeRunId', 'closureIdentity', 'claimId', 'reviewedFiles', 'moments']) {
    const { run, reviewer, snapshot } = fixture();
    const value = snapshot.commands[0]!.structuredResult!.value;
    if (field === 'recipeRunId') value.recipeRunId = 'other';
    if (field === 'closureIdentity') value.closureIdentity = `sha256:${'b'.repeat(64)}`;
    if (field === 'claimId') value.judgments[0]!.claimId = 'other';
    if (field === 'reviewedFiles') value.judgments[0]!.reviewedFiles = [];
    if (field === 'moments') value.judgments[0]!.moments = [];
    assert.throws(
      () => collectPipelineVisualResult(run, reviewer, snapshot),
      /launch evidence|schema-bound completed/,
    );
  }
});

test('worker, fix and retained producing sessions cannot gain visual reviewer authority', () => {
  for (const role of ['dev', 'review-fix', 'ci-fix'] as const) {
    const { run, reviewer } = fixture();
    assert.throws(
      () => pipelineReviewerBinding(run, { ...reviewer, role }),
      /independent admitted/,
    );
    run.agentContexts!.push({
      ...reviewer,
      id: role,
      role,
      nativeSession: undefined,
      nativeSessionHistory: [{ ...reviewer.nativeSession! }],
    });
    assert.throws(() => pipelineReviewerBinding(run, reviewer), /producing worker/);
  }
});

test('a retained result activates only for its matching head and closure and stamps once across refreshes', async () => {
  const { run, reviewer, snapshot } = fixture();
  reviewer.pipelineVisualReviewResult = collectPipelineVisualResult(run, reviewer, snapshot);
  reviewer.reviewResultValidatedAt = new Date().toISOString();
  reviewer.status = 'complete';
  const sources = [{ input, artifactPrefix: 'artifacts/recipe/' }];
  await stampPipelineVisualReviews(run, sources, 'b'.repeat(40));
  assert.equal(run.visualJudgmentReceipts?.length ?? 0, 0);
  await stampPipelineVisualReviews(
    run,
    [
      {
        ...sources[0]!,
        input: {
          ...input,
          artifactDigests: { ...input.artifactDigests, 'video.mp4': `sha256:${'b'.repeat(64)}` },
        },
      },
    ],
    'a'.repeat(40),
  );
  assert.equal(run.visualJudgmentReceipts?.length ?? 0, 0);
  await stampPipelineVisualReviews(run, sources, 'a'.repeat(40));
  const first = structuredClone(run.visualJudgmentReceipts);
  assert.equal(first?.length, 1);
  assert.equal(first![0]!.kind, 'pipeline-reviewed');
  assert.equal(first![0]!.approver.credentialId, undefined);
  await stampPipelineVisualReviews(run, sources, 'a'.repeat(40));
  assert.deepEqual(run.visualJudgmentReceipts, first);
});
