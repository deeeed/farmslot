import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GateSummary,
  ReadyGatePayload,
  ReviewGatePayload,
  Run,
  RunDecision,
  RunDecisionPayload,
} from '../../src/contracts/index.js';
import { hasUnsettledRunExecution } from '../../src/contracts/runs.js';
import { runListEvidenceSummary, summarizeRunEvidence } from '../../src/runs/evidence-summary.js';
import {
  LIST_CHECK_NAME_MAX_CHARS,
  LIST_FIX_LABEL_MAX_CHARS,
  listStepOutputs,
  RUN_LIST_PAYLOAD_VALUE_LIMIT,
  runHasTrimmedDetail,
  runListRow,
  trimDecisionForList,
  trimRunForList,
} from '../../src/runs/list-trim.js';
import { runListVersion } from '../../src/runs/list-version.js';

const big = 'x'.repeat(RUN_LIST_PAYLOAD_VALUE_LIMIT);

/** Minimal valid Run with every required field set to a safe default. */
function minRun(): Run {
  return {
    id: 'min',
    familyId: 'fam-min',
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'test',
    ticketOrPr: '',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('run.list trims CI snapshot context without a payload and retains other context', () => {
  const stored: RunDecision = {
    id: 'ci',
    type: 'ci_ci_timeout',
    title: 'CI',
    description: '',
    actions: [],
    createdAt: 'now',
    context: {
      checkSnapshot: { checks: [] },
      checks: [{ name: 'lint', status: 'pending' }],
      repo: 'owner/repo',
    },
  };
  const listed = trimDecisionForList(stored);
  assert.deepEqual(listed.payloadTrimmed, ['context.checkSnapshot']);
  assert.equal(listed.context?.checkSnapshot, undefined);
  assert.deepEqual(listed.context?.checks, stored.context?.checks);
  assert.equal(listed.context?.repo, 'owner/repo');
  assert.deepEqual(stored.context?.checkSnapshot, { checks: [] });
});

function decision(payload: RunDecisionPayload): RunDecision {
  return {
    id: 'd1',
    type: 'engine_review_posting',
    title: 't',
    description: '',
    actions: [],
    createdAt: '2026-09-14T00:00:00.000Z',
    payload,
  };
}

test('run.list keeps small decision payload values and names the large ones it drops', () => {
  const trimmed = trimDecisionForList(
    decision({
      kind: 'review',
      recommendation: 'REQUEST_CHANGES',
      reviewMd: big,
      evidenceMarkdown: big,
    } as ReviewGatePayload),
  );
  assert.deepEqual(trimmed.payload, { kind: 'review', recommendation: 'REQUEST_CHANGES' });
  assert.deepEqual(trimmed.payloadTrimmed, ['reviewMd', 'evidenceMarkdown']);
});

test('a decision with only small values is returned as-is, without a marker', () => {
  const small = decision({ kind: 'review', recommendation: 'COMMENT' } as ReviewGatePayload);
  assert.equal(trimDecisionForList(small), small);
  assert.equal(trimDecisionForList(small).payloadTrimmed, undefined);
});

test('trimRunForList copies instead of mutating the stored run', () => {
  const run: Run = {
    ...minRun(),
    id: 'r1',
    decisions: [
      decision({ kind: 'review', reviewMd: big } as ReviewGatePayload),
      decision({ kind: 'ready' } as ReadyGatePayload),
    ],
  };
  const listed = trimRunForList(run);
  assert.notEqual(listed, run);
  const storedPayload = run.decisions[0].payload;
  if (!storedPayload || storedPayload.kind !== 'review') throw new Error('Expected review payload');
  assert.equal(storedPayload.reviewMd, big, 'the store object keeps its payload');
  assert.equal(listed.decisions[0].payloadTrimmed?.[0], 'reviewMd');
  assert.equal(listed.decisions[1], run.decisions[1], 'untouched decisions are shared');
  const noop: Run = {
    ...minRun(),
    id: 'r2',
    decisions: [decision({ kind: 'ready' } as ReadyGatePayload)],
  };
  assert.equal(trimRunForList(noop), noop);
});

test('the limit is measured in UTF-8 bytes, not string length', () => {
  // 1,000 three-byte characters: 1,002 JSON characters, 3,002 JSON bytes.
  const wide = '\u4e2d'.repeat(1000);
  const trimmed = trimDecisionForList(
    decision({ kind: 'review', reviewMd: wide } as ReviewGatePayload),
  );
  assert.deepEqual(trimmed.payloadTrimmed, ['reviewMd']);
  const narrow = 'x'.repeat(RUN_LIST_PAYLOAD_VALUE_LIMIT - 2);
  assert.equal(
    trimDecisionForList(decision({ kind: 'review', reviewMd: narrow } as ReviewGatePayload))
      .payloadTrimmed,
    undefined,
  );
});

test('run lists omit output file manifests without changing the retained detail', () => {
  const run: Run = {
    ...minRun(),
    id: 'output',
    output: {
      workerFinished: true,
      capturedAt: 'now',
      manifestDigest: 'hash',
      reportPath: 'artifacts/report.md',
      artifactManifest: [{ path: 'artifacts/report.md', purpose: 'report' }],
    },
  };
  const listed = trimRunForList(run);
  assert.equal(listed.output?.reportPath, run.output?.reportPath);
  assert.equal(listed.output?.artifactManifestOmitted, true);
  assert.deepEqual(listed.output?.artifactManifest, []);
  assert.equal(run.output?.artifactManifest.length, 1);
});

// ─── runListRow (slim projection) tests ──────────────────────────────────────

/** A gate summary of realistic weight: what a ready payload and the publish gate both hold. */
function readyGateSummary(): GateSummary {
  return {
    kind: 'publication',
    headline: 'h'.repeat(1500),
    worker: { model: 'claude-opus', turns: 12 },
    review: {
      reviews: [],
      passingReviews: 0,
      totalUnresolved: 0,
      didAnyReviewTriggerReWork: false,
    },
    tokens: {
      mainWorker: {
        model: 'claude-opus',
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheCreation: 0,
        total: 2,
        turns: 12,
      },
      reviews: [],
      byModel: [],
      familyTotalTokens: 2,
      perTurnDetailsAvailable: false,
    },
  };
}

/** One run with every heavy field the slim row drops or reduces, and evidence of each kind. */
function richRun(): Run {
  return {
    id: 'slim-test',
    familyId: 'fam-1',
    lane: 'production',
    flowType: 'dev',
    project: 'test-project',
    ticketOrPr: 'T-1',
    status: 'monitoring',
    slotId: null,
    branch: null,
    taskFile: null,
    summary: 'worker running',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:01:00.000Z',
    metrics: {
      runner: 'claude',
      model: 'claude-opus',
      nudgeCount: 0,
      runnerSessionPath: '/home/worker/.claude/session.jsonl',
      checklistTiming: {
        schemaVersion: 1,
        events: [{ stepNumber: 1, label: 'Read the task', checkedAt: '2026-11-11T00:00:40.000Z' }],
      },
    },
    agentContexts: [
      {
        id: 'review',
        label: 'Reviewer',
        role: 'review',
        status: 'working',
        slotId: 'slot-a',
        runId: 'slim-test',
        runner: 'claude',
        taskFile: 'tasks/REVIEW.md',
        reviewId: 'rev-1',
        reviewLoopNumber: 1,
        startedAt: '2026-11-11T00:00:40.000Z',
        runnerSessionPath: '/home/worker/.claude/review.jsonl',
        signalFile: '/repo/tasks/signal.json',
        usage: {
          totalTokens: 9000,
          measuredAt: '2026-11-11T00:00:55.000Z',
          source: 'runner-transcript',
        },
        runnerSessionArchive: { status: 'captured', relativeDir: 'session-archives/slim-test' },
      },
    ],
    ticketData: {
      source: 'jira',
      title: 'Fix the banner',
      description: 'd'.repeat(3000),
      acceptanceCriteria: ['Shows the banner'],
      affectedArea: 'home',
      stepsToReproduce: ['Open the app'],
      screenshots: [],
      labels: ['bug'],
      jiraKey: 'TEAM-1',
      linkedTickets: [
        {
          ref: 'TEAM-2',
          url: 'https://jira.example/browse/TEAM-2',
          title: 'Related',
          description: 'Related ticket',
          source: 'jira',
        },
      ],
    },
    reviewResult: {
      recommendation: 'COMMENT',
      reviewMd: 'r'.repeat(4000),
      lineComments: [{ path: 'src/main.ts', line: 3, body: 'c'.repeat(600), severity: 'major' }],
      reviewInputArtifactPaths: ['reviews/input.md'],
    },
    reviewWorkspaceSubject: {
      repository: 'owner/repo',
      repositoryUrl: 'https://github.com/owner/repo',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'feature/x',
      title: 'Fix the banner',
      body: 'b'.repeat(3000),
      capturedAt: '2026-11-11T00:00:05.000Z',
    },
    steps: [
      {
        name: 'dispatch',
        status: 'done',
        startedAt: '2026-11-11T00:00:10.000Z',
        completedAt: '2026-11-11T00:00:20.000Z',
        outputs: { selectedSlot: 'slot-a', reason: 'picked best slot', ignoredField: 'drop me' },
      },
      {
        name: 'work',
        status: 'done',
        outputs: {
          transcript: 't'.repeat(8000),
          diffStat: { files: 2, additions: 10, deletions: 3 },
          artifacts: [
            { path: 'evidence/before-login.png', purpose: 'before screenshot', sizeBytes: 400 },
            { path: 'evidence/after-login.png', purpose: 'after screenshot', sizeBytes: 500 },
            { path: 'reports/recipe-report.md', purpose: 'report', sizeBytes: 100 },
            { path: 'reviews/final-review.md', purpose: 'review', sizeBytes: 200 },
          ],
        },
      },
    ],
    decisions: [
      {
        id: 'd1',
        type: 'engine_human_gate',
        title: 'Human gate',
        description: 'Review the package and publish it.',
        selectionData: { selectedEvidenceKeys: ['k'.repeat(900)] },
        createdAt: '2026-11-11T00:00:30.000Z',
        actions: [{ id: 'approve', label: 'Approve', style: 'primary', description: 'Publish' }],
        payload: {
          kind: 'ready',
          gateReadiness: {
            state: 'ready',
            identity: { runId: 'slim-test', generation: 1 },
            reasons: [],
          },
          reviewRoundBudget: {
            used: 1,
            remaining: 2,
            limit: 3,
            label: 'rounds',
            noVerdict: 0,
            noVerdictLimit: 3,
          },
          workerReport: 'w'.repeat(8000),
          inputSnapshot: { taskPrompt: 'p'.repeat(8000) },
          gateSummary: readyGateSummary(),
          branch: 'feature/x',
          prNumber: null,
          repo: null,
          diffStat: { additions: 10, deletions: 2, files: 1 },
          reviews: [
            {
              id: 'pr-rev-1',
              mode: 'cold',
              loopNumber: 1,
              verdict: 'pass',
              unresolvedCount: 0,
              runner: 'claude',
              model: 'claude-opus',
              issues: [{ file: 'src/main.ts', description: 'nit' }],
            },
          ],
        },
      },
    ],
    output: {
      workerFinished: true,
      capturedAt: '2026-11-11T00:00:50.000Z',
      manifestDigest: 'digest',
      artifactManifest: [{ path: 'artifacts/output.mp4', purpose: 'video', sizeBytes: 900 }],
    },
    engineState: {
      generation: 5,
      workspaceReviewDispatchGeneration: 3,
      intelligenceAuditDegraded: false,
      reviewedInputs: { fingerprint: 'abc', recordedAt: '2026-11-11' },
      operatorForceCompleted: true,
      publishGate: {
        packageHash: 'pkg-1',
        reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
        reviewSequence: [{ runner: 'claude', model: null, effort: null, mode: 'cold' }],
        reviews: [
          {
            id: 'rev-1',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            source: 'dispatch',
            runner: 'claude',
            model: 'claude-opus',
            issues: [],
            artifactPaths: ['artifacts/review.md'],
          },
        ],
      },
    },
    resourcePosture: {
      posture: 'active',
      policySource: 'framework-default',
      capabilities: [],
      workerRetained: false,
      updatedAt: '2026-11-11T00:00:00.000Z',
    },
    sessionUsage: [
      {
        runner: 'claude',
        totalTokens: 5000,
        measuredAt: '2026-11-11T00:00:00.000Z',
        source: 'runner-transcript' as const,
      },
    ],
    visualJudgmentReceipts: [],
    templateProvenance: null,
  };
}

test('runListRow drops the four heavy fields', () => {
  const run = richRun();
  const row = runListRow(run);
  assert.equal('resourcePosture' in row, false, 'resourcePosture dropped');
  assert.equal('sessionUsage' in row, false, 'sessionUsage dropped');
  assert.equal('visualJudgmentReceipts' in row, false, 'visualJudgmentReceipts dropped');
  assert.equal('templateProvenance' in row, false, 'templateProvenance dropped');
});

test('runListRow keeps only allowed step output keys', () => {
  const run = richRun();
  const row = runListRow(run);
  assert.equal(row.steps[0]?.outputs?.selectedSlot, 'slot-a');
  assert.equal(row.steps[0]?.outputs?.reason, 'picked best slot');
  assert.equal(row.steps[0]?.outputs?.['ignoredField'], undefined);
});

test('a ready payload on a row leaves out only its heavy keys', () => {
  const run = richRun();
  const full = run.decisions[0]?.payload;
  const payload = runListRow(run).decisions[0]?.payload;
  if (full?.kind !== 'ready' || payload?.kind !== 'ready')
    throw new Error('Expected ready payload');
  for (const heavy of ['workerReport', 'inputSnapshot', 'gateSummary'])
    assert.equal(heavy in payload, false, heavy);
  // Every other key is the run's own: the whole round budget, reviews with their issues.
  const { workerReport: _report, inputSnapshot: _snapshot, gateSummary: _summary, ...rest } = full;
  assert.deepEqual(payload, rest);
  assert.equal(payload.reviewRoundBudget?.limit, 3);
  assert.equal(payload.reviews?.[0]?.issues?.length, 1);
});

test('engine state on a row leaves out only the publish gate summary', () => {
  const run = richRun();
  const state = run.engineState;
  if (!state?.publishGate) throw new Error('Expected a publish gate');
  assert.deepEqual(runListRow(run).engineState, state);
  const summarized: Run = {
    ...run,
    engineState: {
      ...state,
      publishGate: { ...state.publishGate, gateSummary: readyGateSummary() },
    },
  };
  const row = runListRow(summarized);
  assert.deepEqual(row.engineState, state);
  assert.equal(row.detailTrimmed, true);
});

// The frozen contract: small fields stay. A resolved decision keeps its resolution, an action
// its description, a no-change payload its reason, and the row says what it left out.
test('a decision on a row keeps its small fields and leaves out the selection and attestation', () => {
  const resolved: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Publish',
    description: 'Nothing changed.',
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: '2026-01-01T00:01:00.000Z',
    resolvedAction: 'close-run',
    triageAssessmentId: 'triage-1',
    actions: [
      { id: 'close-run', label: 'Close', style: 'secondary', description: 'Close the run' },
    ],
    selectionData: { feedback: 'f'.repeat(600) },
    payload: { kind: 'no-change', disposition: 'already_fixed', reason: 'unchanged' },
  };
  const run: Run = { ...minRun(), decisions: [resolved] };
  const row = runListRow(run);
  const { selectionData: _selection, ...kept } = resolved;
  assert.deepEqual(row.decisions, [kept]);
  assert.equal(row.detailTrimmed, true);
  assert.equal(runHasTrimmedDetail(row), true);
  // A decision that holds neither is served whole, and the row carries no marker.
  const plain = runListRow({ ...minRun(), decisions: [kept] });
  assert.deepEqual(plain.decisions, [kept]);
  assert.equal('detailTrimmed' in plain, false);
});

test('runListRow does not mutate the stored run', () => {
  const run = richRun();
  const before = JSON.stringify(run);
  runListRow(run);
  assert.equal(JSON.stringify(run), before);
});

test('runListRow serves exactly the kept fields of a rich run, and its evidence summary', () => {
  const row = runListRow(richRun());
  assert.deepEqual(JSON.parse(JSON.stringify(row)), {
    id: 'slim-test',
    familyId: 'fam-1',
    lane: 'production',
    flowType: 'dev',
    project: 'test-project',
    ticketOrPr: 'T-1',
    status: 'monitoring',
    slotId: null,
    branch: null,
    taskFile: null,
    summary: 'worker running',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:01:00.000Z',
    // Per-run detail: only the heavy keys are gone (the checklist timing, the agent's usage
    // and session archive, the ticket description, the review text and line comments, the
    // pull request body); every small key is served as the run holds it.
    metrics: {
      runner: 'claude',
      model: 'claude-opus',
      nudgeCount: 0,
      runnerSessionPath: '/home/worker/.claude/session.jsonl',
    },
    agentContexts: [
      {
        id: 'review',
        label: 'Reviewer',
        role: 'review',
        status: 'working',
        slotId: 'slot-a',
        runId: 'slim-test',
        runner: 'claude',
        taskFile: 'tasks/REVIEW.md',
        reviewId: 'rev-1',
        reviewLoopNumber: 1,
        startedAt: '2026-11-11T00:00:40.000Z',
        runnerSessionPath: '/home/worker/.claude/review.jsonl',
        signalFile: '/repo/tasks/signal.json',
      },
    ],
    ticketData: {
      source: 'jira',
      title: 'Fix the banner',
      acceptanceCriteria: ['Shows the banner'],
      affectedArea: 'home',
      stepsToReproduce: ['Open the app'],
      screenshots: [],
      labels: ['bug'],
      jiraKey: 'TEAM-1',
      linkedTickets: [
        {
          ref: 'TEAM-2',
          url: 'https://jira.example/browse/TEAM-2',
          title: 'Related',
          description: 'Related ticket',
          source: 'jira',
        },
      ],
    },
    reviewResult: { recommendation: 'COMMENT', reviewInputArtifactPaths: ['reviews/input.md'] },
    reviewWorkspaceSubject: {
      repository: 'owner/repo',
      repositoryUrl: 'https://github.com/owner/repo',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'feature/x',
      title: 'Fix the banner',
      capturedAt: '2026-11-11T00:00:05.000Z',
    },
    detailTrimmed: true,
    steps: [
      {
        name: 'dispatch',
        status: 'done',
        startedAt: '2026-11-11T00:00:10.000Z',
        completedAt: '2026-11-11T00:00:20.000Z',
        outputs: { selectedSlot: 'slot-a', reason: 'picked best slot' },
        outputsTrimmed: true,
      },
      // The work step keeps its diff stat and the artifacts an older client's list readers
      // need (the before/after pair), not the transcript, the report or the review file.
      {
        name: 'work',
        status: 'done',
        outputs: {
          diffStat: { files: 2, additions: 10, deletions: 3 },
          artifacts: [
            { path: 'evidence/before-login.png', purpose: 'before screenshot', sizeBytes: 400 },
            { path: 'evidence/after-login.png', purpose: 'after screenshot', sizeBytes: 500 },
          ],
        },
        outputsTrimmed: true,
      },
    ],
    decisions: [
      {
        id: 'd1',
        type: 'engine_human_gate',
        title: 'Human gate',
        description: 'Review the package and publish it.',
        createdAt: '2026-11-11T00:00:30.000Z',
        actions: [{ id: 'approve', label: 'Approve', style: 'primary', description: 'Publish' }],
        // The decision's selection is gone (the row carries `detailTrimmed`); the payload
        // lost only its heavy keys, each named here.
        payloadTrimmed: ['workerReport', 'inputSnapshot', 'gateSummary'],
        payload: {
          kind: 'ready',
          gateReadiness: {
            state: 'ready',
            identity: { runId: 'slim-test', generation: 1 },
            reasons: [],
          },
          reviewRoundBudget: {
            used: 1,
            remaining: 2,
            limit: 3,
            label: 'rounds',
            noVerdict: 0,
            noVerdictLimit: 3,
          },
          branch: 'feature/x',
          prNumber: null,
          repo: null,
          diffStat: { additions: 10, deletions: 2, files: 1 },
          reviews: [
            {
              id: 'pr-rev-1',
              mode: 'cold',
              loopNumber: 1,
              verdict: 'pass',
              unresolvedCount: 0,
              runner: 'claude',
              model: 'claude-opus',
              issues: [{ file: 'src/main.ts', description: 'nit' }],
            },
          ],
        },
      },
    ],
    output: {
      workerFinished: true,
      capturedAt: '2026-11-11T00:00:50.000Z',
      manifestDigest: 'digest',
      artifactManifest: [],
      artifactManifestOmitted: true,
    },
    // Engine state is the run's own: small flags and the reviews with their issues stay.
    engineState: {
      generation: 5,
      workspaceReviewDispatchGeneration: 3,
      intelligenceAuditDegraded: false,
      reviewedInputs: { fingerprint: 'abc', recordedAt: '2026-11-11' },
      operatorForceCompleted: true,
      publishGate: {
        packageHash: 'pkg-1',
        reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
        reviewSequence: [{ runner: 'claude', model: null, effort: null, mode: 'cold' }],
        reviews: [
          {
            id: 'rev-1',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            source: 'dispatch',
            runner: 'claude',
            model: 'claude-opus',
            issues: [],
            artifactPaths: ['artifacts/review.md'],
          },
        ],
      },
    },
    evidenceSummary: {
      artifactCount: 5,
      videoCount: 1,
      visualPairCount: 1,
      diffStat: { files: 2, additions: 10, deletions: 3 },
      stepArtifacts: {
        artifactCount: 4,
        artifactBytes: 1200,
        visualEvidenceCount: 2,
        validationEvidenceCount: 1,
        reviewEvidenceCount: 1,
      },
    },
  });
});

test('the served row of a rich run is under 4 KB, a fraction of the trimmed row', () => {
  const run = richRun();
  const served = Buffer.byteLength(JSON.stringify(runListRow(run)));
  const trimmed = Buffer.byteLength(JSON.stringify(trimRunForList(run)));
  assert.ok(served < 4096, `served row ${served} B`);
  assert.ok(served * 5 < trimmed, `served ${served} B vs trimmed ${trimmed} B`);
});

test('the row version basis is trimRunForList, which serving a slim row leaves unchanged', () => {
  const run = richRun();
  const basis = runListVersion(trimRunForList(run));
  runListRow(run);
  assert.equal(runListVersion(trimRunForList(run)), basis);
  // The served row hashes differently, so a version is never taken from the served row.
  assert.notEqual(runListVersion(runListRow(run)), basis);
});

test('the served evidence summary is computed from the full run, not from the slim row', () => {
  const run = richRun();
  const row = runListRow(run);
  assert.deepEqual(row.evidenceSummary, summarizeRunEvidence(run));
  // The slim row alone has lost most of the step and output artifacts the summary counts: it
  // keeps the before/after pair of the run's five.
  const { evidenceSummary, ...withoutSummary } = row;
  assert.equal(evidenceSummary?.artifactCount, 5);
  assert.equal(summarizeRunEvidence(withoutSummary).artifactCount, 2);
  assert.equal(runListEvidenceSummary(row), evidenceSummary);
});

test('a slim row reports itself trimmed and names the payload keys it left out', () => {
  const run = richRun();
  const row = runListRow(run);
  assert.equal(runHasTrimmedDetail(row), true);
  assert.deepEqual(row.decisions[0]?.payloadTrimmed, [
    'workerReport',
    'inputSnapshot',
    'gateSummary',
  ]);
  // The full run reports nothing trimmed.
  assert.equal(runHasTrimmedDetail(run), false);
});

test('list step outputs keep each read key in its bounded shape and drop the rest', () => {
  assert.deepEqual(
    listStepOutputs({
      phase: 'fixing',
      fixInProgress: true,
      nextPollAt: null,
      actionableBotCommentCount: 2,
      checkSummary: { passed: 3, failed: 1, pending: 0, total: 4, perCheck: [{ log: 'x' }] },
      failedNames: ['lint', { name: 'scan', log: 'x'.repeat(100) }],
      failedChecks: ['lint'],
      fixProgress: { completed: 1, total: 3, currentLabel: 'Fix lint', history: ['a', 'b'] },
      checkTimeline: [{ timestamp: 't', status: 'failed' }],
      verdict: 'issues',
      reviewVerdict: { nested: true },
      gatePrerequisiteRefusal: { code: 'EVIDENCE', reasons: ['r'.repeat(500)] },
      packageHash: 'a'.repeat(64),
    }),
    {
      phase: 'fixing',
      fixInProgress: true,
      nextPollAt: null,
      actionableBotCommentCount: 2,
      checkSummary: { passed: 3, failed: 1, pending: 0, total: 4 },
      failedNames: ['lint'],
      failedChecks: ['lint'],
      fixProgress: { completed: 1, total: 3, currentLabel: 'Fix lint' },
      verdict: 'issues',
      gatePrerequisiteRefusal: {},
      packageHash: 'a'.repeat(64),
    },
  );
});

test('a refused completion keeps its run unsettled on the served row, as on the full run', () => {
  const refused: Run = {
    ...minRun(),
    status: 'failed',
    steps: [
      {
        name: 'complete',
        status: 'failed',
        outputs: { gatePrerequisiteRefusal: { code: 'EVIDENCE', detail: 'd'.repeat(3000) } },
      },
    ],
  };
  assert.equal(hasUnsettledRunExecution(refused), true);
  assert.equal(hasUnsettledRunExecution(runListRow(refused)), true);
  const discarded: Run = {
    ...refused,
    steps: [
      {
        name: 'complete',
        status: 'failed',
        outputs: { gatePrerequisiteRefusal: {}, gatePrerequisiteDiscardedAt: 'now' },
      },
    ],
  };
  assert.equal(hasUnsettledRunExecution(runListRow(discarded)), false);
});

test('a row whose only loss is step outputs reads as trimmed; one that lost nothing has no marker', () => {
  const stepOnly: Run = {
    ...minRun(),
    steps: [{ name: 'work', status: 'done', outputs: { transcript: 'worker transcript' } }],
  };
  const row = runListRow(stepOnly);
  assert.equal(row.steps[0]?.outputsTrimmed, true);
  assert.equal(runHasTrimmedDetail(row), true);
  const nothingLost: Run = {
    ...minRun(),
    steps: [{ name: 'dispatch', status: 'done', outputs: { selectedSlot: 'slot-a' } }],
  };
  const kept = runListRow(nothingLost);
  assert.equal('outputsTrimmed' in (kept.steps[0] ?? {}), false);
  assert.equal(runHasTrimmedDetail(kept), false);
  // The marker is on the served row only: the version basis is unchanged.
  const basis = runListVersion(trimRunForList(stepOnly));
  assert.equal(trimRunForList(stepOnly).steps[0]?.outputsTrimmed, undefined);
  runListRow(stepOnly);
  assert.equal(runListVersion(trimRunForList(stepOnly)), basis);
});

test('list rows cap long CI check names and fix labels, and mark the step trimmed', () => {
  const longName = 'n'.repeat(LIST_CHECK_NAME_MAX_CHARS + 50);
  const longLabel = 'l'.repeat(LIST_FIX_LABEL_MAX_CHARS + 50);
  const slim = listStepOutputs({
    failedNames: ['lint', longName],
    fixProgress: { completed: 0, total: 2, currentLabel: longLabel },
  });
  assert.deepEqual(slim, {
    failedNames: ['lint', `${'n'.repeat(LIST_CHECK_NAME_MAX_CHARS - 1)}…`],
    fixProgress: {
      completed: 0,
      total: 2,
      currentLabel: `${'l'.repeat(LIST_FIX_LABEL_MAX_CHARS - 1)}…`,
    },
  });
  const run: Run = {
    ...minRun(),
    steps: [{ name: 'ci-watch', status: 'running', outputs: { failedNames: [longName] } }],
  };
  assert.equal(runListRow(run).steps[0]?.outputsTrimmed, true);
});

// A row drops only heavy per-run detail keys, and says so with one marker.
test('a row that left out a heavy detail key reads as trimmed; small keys stay and add no marker', () => {
  const timed: Run = {
    ...minRun(),
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      checklistTiming: {
        schemaVersion: 1,
        events: [{ stepNumber: 1, label: 'Read', checkedAt: '2026-01-01T00:00:01.000Z' }],
      },
    },
  };
  const row = runListRow(timed);
  assert.equal('checklistTiming' in row.metrics, false);
  assert.equal(row.detailTrimmed, true);
  assert.equal(runHasTrimmedDetail(row), true);
  // The marker is on the served row only: trimRunForList's version basis is unchanged.
  assert.equal(trimRunForList(timed), timed);

  const small: Run = {
    ...minRun(),
    metrics: { nudgeCount: 0, model: null, runner: null, runnerSessionPath: '/x/session.jsonl' },
    agentContexts: [
      {
        id: 'primary',
        label: 'Worker',
        role: 'primary',
        status: 'working',
        slotId: null,
        runId: 'min',
        signalFile: '/repo/tasks/signal.json',
        runnerSessionPath: '/x/session.jsonl',
      },
    ],
  };
  const plain = runListRow(small);
  assert.deepEqual(plain.metrics, small.metrics);
  assert.deepEqual(plain.agentContexts, small.agentContexts);
  assert.equal('detailTrimmed' in plain, false);
  assert.equal(runHasTrimmedDetail(plain), false);
});
