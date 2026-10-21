import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import {
  loadReviewHistoryArtifacts,
  reviewArtifactDir,
  reviewHistoryIdentity,
  reviewHistoryView,
} from '../src/review-history.js';

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
  assert.ok(rounds.every((round) => round.resolution === 'Not recorded'));
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
    fixed.resolution,
    'Not recorded',
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
  assert.equal(round.findingsLabel, 'Findings not recorded');
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
  assert.equal(history.roundCount, 1, 'a retry does not invent another charged round');
  const row = history.checks[0].rounds[0];
  assert.equal(row.verdict, 'pending');
  assert.equal(row.startedAt, '2026-10-21T11:00:00Z');
  assert.equal(row.unresolvedCount, null);
  assert.equal(row.findingsLabel, 'Review is running. Findings appear when it finishes.');
  assert.equal(row.earlierAttempts[0].status, 'failed');
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
