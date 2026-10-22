import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import {
  loadReviewHistoryArtifacts,
  mergeReviewHistoryArtifacts,
  reviewArtifactDir,
  reviewHistoryIdentity,
  reviewHistoryView,
} from '../src/review-history.js';
import { reviewHistorySourceRequest } from '../src/review-history-timeline.js';

function run(): Run {
  return {
    id: 'history-run',
    familyId: 'history-run',
    parentRunId: null,
    familyRootTicketOrPr: 'HISTORY',
    flowType: 'dev',
    lane: 'production',
    variant: null,
    mode: 'interactive',
    status: 'fixing',
    project: 'fixture',
    ticketOrPr: 'HISTORY',
    slotId: 'worker-slot',
    branch: 'feature',
    taskFile: 'temp/task/TASK.md',
    steps: [{ name: 'review', status: 'running', inputs: { reviewSelection: { mode: 'cold' } } }],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-6.1-sol' },
    createdAt: '2026-10-21T10:00:00Z',
    updatedAt: '2026-10-21T11:00:00Z',
    agentContexts: [],
  };
}
function actor(loop: number): AgentContext {
  return {
    id: `review-${loop}`,
    role: 'review',
    label: 'Reviewer',
    status: 'complete',
    runId: 'history-run',
    slotId: 'worker-slot',
    reviewId: 'pipeline-review-history-run',
    reviewLoopNumber: loop,
    taskFile: 'temp/task/REVIEW.md',
    reviewResultFile: `artifacts/review-result-${loop}.json`,
    runner: 'codex',
    model: 'gpt-6.1-sol',
    startedAt: '2026-10-21T10:00:00Z',
    completedAt: '2026-10-21T10:01:00Z',
  };
}

test('four active pipeline rounds remain visible before any ready gate exists', () => {
  const current = run();
  current.agentContexts = [1, 2, 3, 4].map(actor);
  current.agentContexts[1].reviewFallback = {
    reason: 'missing-session',
    detail: 'Retained session missing',
    comparedRanges: ['a..b'],
  };
  current.agentContexts.push({
    id: 'review-fix',
    role: 'review-fix',
    label: 'Worker fix',
    status: 'working',
    runId: current.id,
    slotId: current.slotId,
    attemptStartedAt: '2026-10-21T11:00:00Z',
  });
  const artifacts = Object.fromEntries(
    [3, 4, 2, 1].map((count, index) => [
      `artifacts/review-result-${index + 1}.json`,
      {
        content: JSON.stringify({
          verdict: 'issues',
          issues: Array.from({ length: count }, (_, i) => ({
            file: 'order.ts',
            line: 462 + i,
            description: `Finding ${i + 1}`,
          })),
        }),
      },
    ]),
  );
  const history = reviewHistoryView(current, artifacts);
  assert.equal(history.roundCount, 4);
  const rounds = history.checks[0].rounds;
  assert.deepEqual(
    rounds.map((round) => [
      round.loopNumber,
      round.runner,
      round.model,
      round.durationMs,
      round.findings.length,
    ]),
    [
      [1, 'codex', 'gpt-6.1-sol', 60000, 3],
      [2, 'codex', 'gpt-6.1-sol', 60000, 4],
      [3, 'codex', 'gpt-6.1-sol', 60000, 2],
      [4, 'codex', 'gpt-6.1-sol', 60000, 1],
    ],
  );
  assert.deepEqual(
    rounds.map((round) => round.mode),
    ['cold', 'cold', null, null],
  );
  assert.deepEqual(
    rounds.map((round) => round.fixRunning),
    [false, false, false, true],
  );
  assert.ok(
    rounds.every((round) => round.findings.every((finding) => finding.resolvedBy === null)),
  );
  assert.equal(rounds[0].findings[0].severity, 'Severity not recorded');
  assert.equal(rounds[0].findings[0].line, 462);
});

test('step outputs keep actual loop numbers, fix SHA, untracked counts and recorded fix duration', () => {
  const current = run();
  current.steps[0].outputs = {
    reviewId: 'publication-review',
    runner: 'codex',
    model: 'gpt-6.1-sol',
    timeline: [
      {
        kind: 'worker-fix',
        loopNumber: 4,
        startedAt: '2026-10-21T10:01:00Z',
        completedAt: '2026-10-21T10:02:00Z',
      },
    ],
    attempts: [
      {
        loopNumber: 3,
        mode: 'cold',
        verdict: 'issues',
        unresolvedCount: 1,
        issues: [{ file: 'order.ts', description: 'Missing fill' }],
      },
      {
        loopNumber: 4,
        mode: 'warm',
        verdict: 'pass',
        unresolvedCount: 0,
        issues: [],
        fixDelta: {
          baseSha: 'aaaaaaa',
          headSha: 'bbbbbbb',
          diffPath: 'artifacts/fix.diff',
          diffStat: { files: 2, additions: 3, deletions: 1 },
          untrackedFiles: [{ path: 'new.ts', blobSha: 'blob', mode: '100644' }],
        },
      },
    ],
  };
  const history = reviewHistoryView(current);
  assert.deepEqual(
    history.checks[0].rounds.map((round) => [round.loopNumber, round.verdict, round.mode]),
    [
      [3, 'issues', 'cold'],
      [4, 'pass', 'warm'],
    ],
  );
  const fixed = history.checks[0].rounds[1];
  assert.equal(fixed.fixRange, 'aaaaaaa → bbbbbbb');
  assert.equal(fixed.fixStat, '1 tracked + 1 untracked · +3 −1');
  assert.equal(fixed.fixDiffPath, 'artifacts/fix.diff');
  assert.equal(fixed.fixDurationMs, 60000);
  assert.equal(
    fixed.findings.some((finding) => finding.status === 'resolved'),
    false,
    'a later pass is not an explicit per-finding resolution record',
  );
});

test('the existing artifact directory contract is shared with gateway snapshot capture', () => {
  assert.equal(reviewArtifactDir(3), 'artifacts/pipeline-review-loop-3');
  assert.equal(
    reviewArtifactDir(4, 'requested-review'),
    'artifacts/requested-review/review-loop-4',
  );
  assert.throws(() => reviewArtifactDir(3, '../foreign'));
});

test('the existing gate history keeps recorded mode, loop number, checklist timing and staleness', () => {
  const current = run();
  current.engineState = {
    publishGate: {
      reviews: [
        {
          id: 'requested-review',
          source: 'human-gate',
          runner: 'codex',
          model: 'gpt-6.1-sol',
          mode: 'warm',
          loopNumber: 9,
          verdict: 'issues',
          unresolvedCount: 1,
          stale: true,
          attempts: [
            {
              mode: 'warm',
              loopNumber: 9,
              verdict: 'issues',
              unresolvedCount: 1,
              startedAt: '2026-10-21T10:00:00Z',
              completedAt: '2026-10-21T10:01:00Z',
              issues: [{ description: '[P2] Preserve selection.', file: 'order.ts', line: 462 }],
              checklistTiming: {
                schemaVersion: 1,
                events: [
                  { stepNumber: 1, label: 'Read changes', checkedAt: '2026-10-21T10:00:02Z' },
                ],
              },
            },
          ],
        },
      ],
    },
  };
  const check = reviewHistoryView(current).checks[0];
  assert.equal(check.source, 'Requested review');
  assert.equal(check.stale, true);
  assert.equal(check.rounds[0].loopNumber, 9);
  assert.equal(check.rounds[0].mode, 'warm');
  assert.equal(check.rounds[0].timing[0].durationMs, 2000);
  assert.equal(check.rounds[0].findings[0].severity, 'P2');
});

test('only a missing retained artifact on the same active task can use the supported live read', async () => {
  const current = run();
  current.agentContexts = [actor(1)];
  const live: string[] = [];
  const read = async (params: { path: string }) => {
    live.push(params.path);
    return '{"verdict":"issues","issues":[]}';
  };
  const loaded = await loadReviewHistoryArtifacts(current, async () => null, read);
  assert.ok(loaded['artifacts/review-result-1.json'].content);
  assert.ok(live.includes('temp/task/artifacts/review-result-1.json'));
  live.length = 0;
  current.status = 'done';
  const finished = await loadReviewHistoryArtifacts(current, async () => null, read);
  assert.equal(live.length, 0);
  assert.match(finished['artifacts/review-result-1.json'].error ?? '', /Not recorded/);
  current.status = 'fixing';
  current.agentContexts[0].slotId = 'other-slot';
  await loadReviewHistoryArtifacts(current, async () => null, read);
  assert.equal(live.length, 0);
});

test('transport failures stay visible and never become zero findings or a resolved claim', async () => {
  const current = run();
  current.agentContexts = [actor(1)];
  const loaded = await loadReviewHistoryArtifacts(current, async () => {
    throw new Error('Gateway unavailable');
  });
  const round = reviewHistoryView(current, loaded).checks[0].rounds[0];
  assert.equal(round.findingsLabel, 'Findings unavailable');
  assert.equal(round.unresolvedCount, null);
  assert.ok(round.unavailable.some((reason) => reason.includes('Gateway unavailable')));
});

test('review progress output does not reload artifacts; a new retained result does', () => {
  const current = run();
  current.agentContexts = [actor(1)];
  const identity = reviewHistoryIdentity(current);
  current.steps[0].outputs = { lastOutput: 'Reviewer is reading a file' };
  current.updatedAt = '2026-10-21T11:01:00Z';
  assert.equal(reviewHistoryIdentity(current), identity);
  current.agentContexts[0].reviewResultValidatedAt = current.updatedAt;
  assert.notEqual(reviewHistoryIdentity(current), identity);
});

test('a same-round infrastructure retry keeps the failure and presents the current reviewer', () => {
  const current = run();
  const failed = { ...actor(5), status: 'failed' as const };
  const active = {
    ...actor(5),
    id: 'resumed-reviewer',
    status: 'working' as const,
    startedAt: '2026-10-21T11:00:00Z',
    attemptStartedAt: '2026-10-21T11:00:00Z',
    completedAt: undefined,
    reviewResultFile: 'artifacts/resumed-result.json',
  };
  current.agentContexts = [failed, active];
  current.steps[0].outputs = {
    attempts: [
      {
        loopNumber: 5,
        verdict: 'failed',
        startedAt: failed.startedAt,
        completedAt: failed.completedAt,
        issues: [{ description: 'Old attempt failed' }],
        unresolvedCount: 1,
      },
    ],
  };
  const history = reviewHistoryView(current);
  assert.equal(
    history.roundCount,
    2,
    'both attempts stay visible without changing the engine budget',
  );
  assert.equal(history.checks[0].rounds[0].verdict, 'failed');
  const row = history.checks[0].rounds[1];
  assert.equal(row.verdict, 'pending');
  assert.equal(row.startedAt, '2026-10-21T11:00:00Z');
  assert.equal(row.unresolvedCount, null);
  assert.equal(row.findingsLabel, 'Review is running. Findings appear when it finishes.');
  assert.equal(row.loopNumber, 5);
  assert.equal(row.roundNumber, 6);
});

test('recorded priority prefixes provide severity and exact sentence titles without protocol fields', () => {
  const current = run();
  current.agentContexts = [actor(1)];
  const history = reviewHistoryView(current, {
    'artifacts/review-result-1.json': {
      content: JSON.stringify({
        verdict: 'issues',
        issues: [
          {
            file: 'order.ts',
            line: 462,
            description:
              '[P1] Reject stale completions. A market switch must preserve the new selection.',
          },
        ],
      }),
    },
  });
  const finding = history.checks[0].rounds[0].findings[0];
  assert.equal(finding.severity, 'P1');
  assert.equal(finding.title, 'Reject stale completions.');
  assert.equal(finding.details, 'A market switch must preserve the new selection.');
});

test('native owner bindings keep transport ownership separate from the running fix activity', () => {
  const current = run();
  current.agentContexts = [
    actor(1),
    {
      id: 'dev',
      role: 'dev',
      label: 'Worker',
      status: 'working',
      runId: current.id,
      slotId: current.slotId,
      nativeSession: {
        sessionId: 'native',
        executionNodeId: 'local',
        ownerPrincipalId: 'person',
        generation: 'generation',
        leaseId: 'lease',
        commandId: 'command',
      },
    },
    {
      id: 'review-fix',
      role: 'review-fix',
      label: 'Fix',
      status: 'working',
      runId: current.id,
      slotId: current.slotId,
      attemptStartedAt: '2026-10-21T11:00:00Z',
      nativeSessionOwner: { contextId: 'dev', sessionId: 'native', leaseId: 'lease' },
    },
  ];
  assert.equal(reviewHistoryView(current).checks[0].rounds[0].fixRunning, true);
});

test('a review replay preserves completed rounds, the failed reason and the intervening fix', () => {
  const current = run();
  current.status = 'reviewing';
  current.engineState = { generation: 1 };
  current.steps = [{ name: 'review', status: 'running', startedAt: '2026-10-22T07:38:32Z' }];
  const first = {
    ...actor(1),
    startedAt: '2026-10-22T06:27:27Z',
    attemptStartedAt: '2026-10-22T06:28:28Z',
    completedAt: '2026-10-22T06:40:52Z',
  };
  const failed = {
    ...actor(2),
    status: 'failed' as const,
    startedAt: '2026-10-22T07:16:47Z',
    completedAt: '2026-10-22T07:23:30Z',
  };
  current.agentContexts = [
    first,
    failed,
    {
      id: 'review-fix',
      role: 'review-fix',
      label: 'Worker fix',
      status: 'complete',
      runId: current.id,
      slotId: current.slotId,
      startedAt: '2026-10-22T06:40:57Z',
      attemptStartedAt: '2026-10-22T06:41:45Z',
      completedAt: '2026-10-22T07:16:46Z',
    },
  ];
  current.reviewRoundSettlements = {
    [JSON.stringify([failed.reviewId, 2, failed.startedAt])]: {
      reason: 'Lock file is already being held',
      at: '2026-10-22T07:35:53Z',
    },
  };
  const history = reviewHistoryView(current, {
    [first.reviewResultFile!]: {
      content: JSON.stringify({
        verdict: 'issues',
        issues: [{ file: 'chart.ts', line: 42, description: 'Order submit fails' }],
      }),
    },
  });
  assert.equal(history.roundCount, 2);
  assert.equal(history.checks[0].rounds[0].verdict, 'issues');
  assert.equal(history.checks[0].rounds[0].startedAt, first.startedAt);
  assert.equal(history.checks[0].rounds[1].verdict, 'failed');
  assert.equal(history.checks[0].rounds[1].failureReason, 'Lock file is already being held');
  assert.equal(history.checks[0].rounds[1].fixDurationMs, 2_149_000);
  assert.equal(history.checks[0].rounds[1].hasFix, true);
  assert.deepEqual(history.activeReplay, { roundNumber: 3, startedAt: '2026-10-22T07:38:32Z' });
  const identity = reviewHistoryIdentity(current);
  current.steps[0].startedAt = '2026-10-22T07:39:00Z';
  assert.notEqual(reviewHistoryIdentity(current), identity);
});

test('a replay with loop 1 preserves original findings, frozen heads and the failed attempt in order', () => {
  const current = run();
  const first = {
    ...actor(1),
    deliveryBaselineRef: '1111111',
    nativeSession: {
      sessionId: 'session',
      leaseId: 'lease1',
      generation: 'generation',
      commandId: 'command1',
      executionNodeId: 'local',
      ownerPrincipalId: 'person',
    },
  };
  const failed = {
    ...actor(2),
    status: 'failed' as const,
    startedAt: '2026-10-21T10:02:00Z',
    completedAt: '2026-10-21T10:03:00Z',
    nativeSession: {
      ...first.nativeSession,
      leaseId: 'lease2',
      handoffFrom: { runId: current.id, contextId: first.id, leaseId: 'lease1' },
    },
  };
  const replay = {
    ...actor(1),
    id: 'replay',
    startedAt: '2026-10-21T10:04:00Z',
    completedAt: '2026-10-21T10:05:00Z',
    deliveryBaselineRef: '2222222',
    reviewResultFile: 'artifacts/replayed.json',
    nativeSession: { ...first.nativeSession, sessionId: 'replayed-session' },
  };
  current.agentContexts = [first, failed, replay];
  const history = reviewHistoryView(current, {
    [first.reviewResultFile!]: {
      content: JSON.stringify({
        verdict: 'issues',
        issues: [
          { file: 'order.ts', line: 91, description: '[P1] Preserve the active order. Details.' },
        ],
      }),
    },
    [replay.reviewResultFile]: {
      content: JSON.stringify({
        verdict: 'issues',
        issues: [
          { file: 'chart.ts', line: 145, description: '[P2] Use calendar months. Details.' },
        ],
      }),
    },
    'artifacts/pipeline-review-loop-1/review-diff-stat.json': {
      content: JSON.stringify({
        baseSha: 'base',
        headSha: '2222222',
        diffPath: 'artifacts/new.diff',
      }),
    },
    'artifacts/pipeline-review-loop-2/fix-delta-stat.json': {
      content: JSON.stringify({
        baseSha: '1111111',
        headSha: '2222222',
        capturedAt: '2026-10-21T10:01:50Z',
        diffPath: 'artifacts/fix.diff',
      }),
    },
    'artifacts/fix.diff': {
      content:
        'diff --git a/order.ts b/order.ts\n--- a/order.ts\n+++ b/order.ts\n@@ -1 +1 @@\n-old\n+new',
    },
  });
  const rounds = history.checks[0].rounds;
  assert.deepEqual(
    rounds.map((row) => [row.roundNumber, row.loopNumber, row.verdict, row.mode]),
    [
      [1, 1, 'issues', 'cold'],
      [2, 2, 'failed', 'warm'],
      [3, 1, 'issues', 'cold'],
    ],
  );
  assert.equal(rounds[0].headSha, '1111111');
  assert.equal(
    rounds[0].diffPath,
    null,
    'replay overwrote loop 1 diff; it is not the original reviewed source',
  );
  assert.equal(rounds[0].findings[0].line, 91);
  assert.equal(rounds[0].findings[0].severity, 'P1');
  assert.equal(rounds[2].findings[0].line, 145);
  assert.deepEqual(reviewHistorySourceRequest(current, rounds[0], rounds[0].findings[0]), {
    slotId: 'worker-slot',
    ref: '1111111',
    path: 'order.ts',
  });
  assert.deepEqual(
    history.events.map((event) => event.kind),
    ['review', 'fix', 'review', 'review'],
  );
  const fix = history.events.find((event) => event.kind === 'fix');
  assert.deepEqual(fix?.fix.files, ['order.ts']);
});

test('finding identity survives line and severity changes; another reviewer cannot resolve it by omission', () => {
  const current = run();
  current.agentContexts = [
    actor(1),
    { ...actor(2), startedAt: '2026-10-21T10:03:00Z', completedAt: '2026-10-21T10:04:00Z' },
    {
      ...actor(3),
      runner: 'claude',
      startedAt: '2026-10-21T10:05:00Z',
      completedAt: '2026-10-21T10:06:00Z',
    },
  ];
  const artifacts = Object.fromEntries(
    [1, 2, 3].map((loop) => [
      `artifacts/review-result-${loop}.json`,
      {
        content: JSON.stringify({
          verdict: loop === 3 ? 'pass' : 'issues',
          issues:
            loop === 3
              ? []
              : [
                  {
                    file: 'order.ts',
                    line: loop === 1 ? 90 : 94,
                    description: `[P${loop}] Preserve the active order. Details.`,
                  },
                ],
        }),
      },
    ]),
  );
  const history = reviewHistoryView(current, artifacts);
  const [first, second] = history.checks[0].rounds;
  assert.equal(first.findings[0].id, second.findings[0].id);
  assert.equal(second.findings[0].status, 'still-open');
  assert.equal(first.findings[0].resolvedBy, null);
  assert.equal(second.findings[0].resolvedBy, null);
});

test('a retained warm startup failure cannot inherit the replacement cold pass at the same start time', () => {
  const current = run();
  const failed = {
    ...actor(3),
    id: 'failed-warm',
    status: 'failed' as const,
    startedAt: '2026-10-21T10:04:43Z',
    completedAt: '2026-10-21T10:05:27Z',
  };
  const replacement = {
    ...failed,
    id: 'replacement',
    status: 'complete' as const,
    completedAt: '2026-10-21T10:31:04Z',
    deliveryBaselineRef: 'new-head',
    reviewFallback: {
      reason: 'session-unavailable' as const,
      detail: 'Native worker launch configuration changed; explicit recovery is required',
      comparedRanges: ['old..new'],
    },
  };
  current.agentContexts = [actor(1), actor(2), failed, replacement];
  current.steps[0].outputs = {
    attempts: [
      {
        loopNumber: 2,
        mode: 'cold',
        verdict: 'pass',
        unresolvedCount: 0,
        issues: [],
        startedAt: failed.startedAt,
        completedAt: '2026-10-21T10:31:00Z',
        reviewSnapshot: { headSha: 'new-head' },
      },
    ],
  };
  const history = reviewHistoryView(current);
  const rows = history.checks[0].rounds;
  assert.equal(rows.length, 4);
  assert.equal(
    rows[1].verdict,
    'Result not recorded',
    "a later pass is not the previous round's result",
  );
  assert.equal(rows[2].verdict, 'failed');
  assert.match(rows[2].failureReason ?? '', /launch configuration changed/);
  assert.equal(rows[3].verdict, 'pass');
  assert.equal(rows[3].mode, 'cold');
});

test('a slot-free review gate uses its saved structured result, frozen source and completed monitor timing', () => {
  const current = run();
  current.flowType = 'review-pr';
  current.status = 'human-gating';
  current.slotId = null;
  current.reviewMode = 'warm';
  current.steps = [{ name: 'monitor', status: 'done', completedAt: '2026-10-21T10:01:00Z' }];
  current.agentContexts = [
    {
      ...actor(1),
      id: 'review',
      reviewLoopNumber: null,
      status: 'waiting',
      slotId: null,
      completedAt: undefined,
      reviewResultFile: undefined,
      artifactScope: '/owned/workspace/task/artifacts',
    },
  ];
  current.reviewResult = {
    recommendation: 'COMMENT',
    reviewMd: 'Review report',
    lineComments: [
      {
        path: 'order.ts',
        line: 479,
        severity: 'MAJOR',
        body: 'Preserve the active order. Full finding text.',
      },
    ],
    reviewSnapshot: {
      source: 'local-git',
      capturedAt: '2026-10-21T10:00:00Z',
      headSha: 'frozen-head',
      diffPath: 'artifacts/review.diff',
    },
  };
  const history = reviewHistoryView(current);
  const round = history.checks[0].rounds[0];
  assert.equal(round.verdict, 'COMMENT');
  assert.equal(round.mode, 'warm');
  assert.equal(round.headSha, 'frozen-head');
  assert.equal(round.durationMs, 60000);
  assert.equal(round.findings[0].severity, 'MAJOR');
  assert.equal(round.findings[0].line, 479);
  assert.deepEqual(reviewHistorySourceRequest(current, round, round.findings[0]), {
    slotId: '',
    runId: current.id,
    ref: 'frozen-head',
    path: 'order.ts',
  });
});

test('a refresh outage keeps already-recorded round data with its visible load error', () => {
  const merged = mergeReviewHistoryArtifacts(
    {
      'artifacts/result.json': { content: '{"verdict":"issues","issues":[]}' },
      'artifacts/old.diff': { content: 'old frozen diff' },
    },
    {
      'artifacts/result.json': { error: 'Gateway unavailable' },
      'artifacts/new.json': { content: 'new round' },
    },
  );
  assert.equal(merged['artifacts/result.json'].content, '{"verdict":"issues","issues":[]}');
  assert.equal(merged['artifacts/result.json'].error, 'Gateway unavailable');
  assert.equal(merged['artifacts/old.diff'].content, 'old frozen diff');
  const fresh = mergeReviewHistoryArtifacts(merged, {
    'artifacts/result.json': { content: 'revised result' },
  });
  assert.equal(fresh['artifacts/result.json'].error, undefined);
  assert.equal(fresh['artifacts/result.json'].content, 'revised result');
});

test('a running reviewer shows its recorded input head while the reused loop snapshot still belongs to the old head', () => {
  const current = run();
  current.status = 'reviewing';
  current.agentContexts = [
    {
      ...actor(1),
      status: 'working',
      completedAt: undefined,
      pipelineVisualReviewInput: {
        headSha: 'current-review-head',
        recipeRunId: 'proof',
        closureIdentity: 'sha256:input',
        artifactPrefix: 'artifacts/proof/',
        claims: [],
      },
    },
  ];
  const round = reviewHistoryView(current, {
    'artifacts/pipeline-review-loop-1/review-diff-stat.json': {
      content: JSON.stringify({ headSha: 'older-head', diffPath: 'artifacts/older.diff' }),
    },
  }).checks[0].rounds[0];
  assert.equal(round.headSha, 'current-review-head');
  assert.equal(round.diffPath, null);
  assert.equal(round.verdict, 'pending');
});

test('overwritten live snapshots recover their original engine-written task range and compare immutable heads', async () => {
  const current = run();
  const base = 'c'.repeat(40),
    firstHead = 'a'.repeat(40),
    nextHead = 'b'.repeat(40);
  const first = { ...actor(1), deliveryBaselineRef: firstHead };
  const next = {
    ...actor(1),
    id: 'replay',
    reviewResultFile: 'artifacts/replayed.json',
    taskFile: 'temp/task/REPLAY.md',
    deliveryBaselineRef: nextHead,
    startedAt: '2026-10-21T10:02:00Z',
    completedAt: '2026-10-21T10:03:00Z',
  };
  current.agentContexts = [first, next];
  const requests: Array<{ base?: string; head?: string }> = [];
  const loaded = await loadReviewHistoryArtifacts(
    current,
    async (path) => {
      if (path.endsWith('review-diff-stat.json'))
        return JSON.stringify({
          source: 'local-git',
          baseSha: base,
          headSha: nextHead,
          diffPath: 'artifacts/shared.diff',
          capturedAt: '2026-10-21T10:02:01Z',
        });
      if (path === first.reviewResultFile)
        return JSON.stringify({
          verdict: 'issues',
          issues: [{ file: 'order.ts', line: 91, description: '[P1] Preserve the order.' }],
        });
      if (path === next.reviewResultFile) return JSON.stringify({ verdict: 'pass', issues: [] });
      assert.notEqual(
        path,
        'artifacts/shared.diff',
        'the mutable diff path is not used for frozen code',
      );
      return null;
    },
    async (params) => {
      assert.equal(params.path, first.taskFile);
      return `## COLD review range\n\nReview the complete PR diff ${base}..${firstHead} in temp/task/artifacts/shared.diff.\n`;
    },
    async (params) => {
      requests.push(params);
      return 'diff --git a/order.ts b/order.ts\n--- a/order.ts\n+++ b/order.ts\n@@ -1 +1 @@\n-old\n+new';
    },
  );
  const rounds = reviewHistoryView(current, loaded).checks[0].rounds;
  assert.equal(rounds[0].reviewBaseSha, base);
  assert.equal(rounds[0].headSha, firstHead);
  assert.equal(rounds[0].diffReconstructed, true);
  assert.match(rounds[0].diffText ?? '', /diff --git/);
  assert.ok(requests.some((request) => request.base === base && request.head === firstHead));
  assert.ok(requests.some((request) => request.base === firstHead && request.head === nextHead));
  assert.equal(requests.length, 3, 'each immutable base/head pair is read once');
  assert.deepEqual(rounds[1].fixFiles, ['order.ts']);
});
