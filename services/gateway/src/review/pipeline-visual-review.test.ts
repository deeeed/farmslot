import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  type AgentContext,
  type NativeSessionReadResult,
  type NativeStructuredResult,
  PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA,
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
const {
  collectPipelineVisualResult,
  pipelineReviewerBinding,
  stampPipelineVisualReviews,
  capturePipelineVisualInput,
  pipelineVisualReviewPrompt,
} = await import('./pipeline-visual-review.js');
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
  assert.ok('judgments' in result.result);
  assert.equal(result.result.judgments[0]!.verdict, 'confirmed');
  assert.equal(run.transport, 'tmux');
  assert.equal(run.nativeOwnerPrincipalId, undefined);
});

test('a code-only task without a recorded attempt remains reviewable without visual authority', async () => {
  const { run } = fixture();
  const task = path.join(directory, 'code-only');
  await mkdir(path.join(task, 'artifacts'), { recursive: true });
  await writeFile(path.join(task, 'TASK.md'), '# Code-only task\n');
  await writeFile(path.join(task, 'artifacts/report.md'), 'No visual criteria.\n');
  run.taskFile = path.join(task, 'TASK.md');
  assert.equal(
    await capturePipelineVisualInput(
      run.id,
      { baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40) },
      async () => true,
    ),
    undefined,
  );
  assert.equal(run.visualJudgmentReceipts, undefined);
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

test('visual collection refuses different stills, moments, ACs and executions', () => {
  for (const field of ['recipeRunId', 'claimId', 'reviewedFiles', 'moments']) {
    const { run, reviewer, snapshot } = fixture();
    const value = snapshot.commands[0]!.structuredResult!.value;
    assert.ok('judgments' in value);
    if (field === 'recipeRunId') value.recipeRunId = 'other';
    if (field === 'claimId') value.judgments[0]!.claimId = 'other';
    if (field === 'reviewedFiles') value.judgments[0]!.reviewedFiles = [];
    if (field === 'moments') value.judgments[0]!.moments = [];
    assert.throws(
      () => collectPipelineVisualResult(run, reviewer, snapshot),
      /launch evidence|schema-bound completed/,
    );
  }
});

test('a result binds to the launch closure, whatever closure the reviewer returns', () => {
  // TAT-4145 bda11b1a: the reviewer mis-copied the 64-hex identity it was asked to echo.
  const launch = recordedEvidenceClosureIdentity(input);
  for (const returned of [
    'sha256:bf0e30edd58fe3420f135d847128ca8149c79b94e06dc7f976b0bd6a989c7e13',
    undefined,
  ]) {
    const { run, reviewer, snapshot } = fixture();
    const value = snapshot.commands[0]!.structuredResult!.value;
    assert.ok('judgments' in value);
    if (returned) value.closureIdentity = returned;
    else delete value.closureIdentity;
    const result = collectPipelineVisualResult(run, reviewer, snapshot)!;
    assert.ok('judgments' in result.result);
    assert.equal(result.result.closureIdentity, launch);
  }
});

test('a repair result binds each source and retained row to its launch closure', () => {
  const { run, reviewer, snapshot } = fixture();
  const source = reviewer.pipelineVisualReviewInput!;
  assert.ok(!('schemaVersion' in source));
  const retainedClosure = `sha256:${'c'.repeat(64)}`;
  reviewer.pipelineVisualReviewInput = {
    schemaVersion: 2,
    headSha: source.headSha,
    repairId: 'repair-1',
    scopeDigest: `sha256:${'d'.repeat(64)}`,
    sources: [source],
    retained: [
      {
        claimId: 'kept',
        text: 'Kept criterion',
        recipeRunId: 'older-run',
        closureIdentity: retainedClosure,
        sourceHeadSha: 'e'.repeat(40),
      },
    ],
  };
  reviewer.nativeSession!.resultSchema = PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA;
  snapshot.session.resultSchema = PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA;
  const v1 = snapshot.commands[0]!.structuredResult!.value;
  assert.ok('judgments' in v1);
  const { closureIdentity: _launch, ...fresh } = v1;
  const repair = (claimId: string): NativeStructuredResult => ({
    schema: PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA,
    value: {
      schemaVersion: 2,
      headSha: source.headSha,
      scopeDigest: `sha256:${'d'.repeat(64)}`,
      sources: [fresh],
      retained: [
        {
          claimId,
          recipeRunId: 'older-run',
          closureIdentity: `sha256:${'f'.repeat(64)}`,
          unaffected: true,
          reason: 'The change does not touch this view.',
        },
      ],
    },
  });
  snapshot.commands[0]!.structuredResult = repair('kept');
  const result = collectPipelineVisualResult(run, reviewer, snapshot)!;
  assert.ok('retained' in result.result);
  assert.equal(result.result.sources[0]!.closureIdentity, source.closureIdentity);
  assert.equal(result.result.retained[0]!.closureIdentity, retainedClosure);
  snapshot.commands[0]!.structuredResult = repair('other');
  assert.throws(() => collectPipelineVisualResult(run, reviewer, snapshot), /launch evidence/);
});

test('review prompts never ask for or show a closure identity', () => {
  const { reviewer } = fixture();
  const source = reviewer.pipelineVisualReviewInput!;
  assert.ok(!('schemaVersion' in source));
  const repair = {
    schemaVersion: 2 as const,
    headSha: source.headSha,
    repairId: 'repair-1',
    scopeDigest: `sha256:${'d'.repeat(64)}`,
    sources: [source],
    retained: [
      {
        claimId: 'kept',
        text: 'Kept criterion',
        recipeRunId: 'older-run',
        closureIdentity: `sha256:${'c'.repeat(64)}`,
        sourceHeadSha: 'e'.repeat(40),
      },
    ],
  };
  for (const prompt of [
    pipelineVisualReviewPrompt(source, '/task'),
    pipelineVisualReviewPrompt(repair, '/task'),
  ]) {
    assert.doesNotMatch(prompt, /closureIdentity/);
    assert.ok(!prompt.includes(source.closureIdentity));
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
  const { run, reviewer } = fixture();
  run.flowType = 'review-pr';
  const primaryReviewer = {
    ...reviewer,
    id: 'review',
    nativeSession: undefined,
    nativeSessionHistory: [{ ...reviewer.nativeSession! }],
  };
  run.agentContexts!.push(primaryReviewer);
  assert.throws(
    () => pipelineReviewerBinding(run, { ...reviewer, id: 'review' }),
    /independent admitted/,
  );
  assert.throws(() => pipelineReviewerBinding(run, reviewer), /producing worker/);
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
