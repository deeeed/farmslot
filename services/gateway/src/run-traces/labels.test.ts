import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run, RunDecision } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

import { buildTraceLabels } from './labels.js';

function context(
  overrides: Partial<AgentContext> & Pick<AgentContext, 'id' | 'role'>,
): AgentContext {
  return {
    label: overrides.id,
    status: 'complete',
    runId: 'run-1',
    slotId: 'slot-1',
    ...overrides,
  };
}

function gradedRun(): Run {
  const base = makeRun({ id: 'run-1', flowType: 'dev', status: 'done' });
  const gate: RunDecision = {
    id: 'gate-1',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Ready for review',
    actions: [],
    createdAt: '2026-11-24T10:00:00Z',
    resolvedAt: '2026-11-24T10:05:00Z',
    resolvedAction: 'approve',
  };
  return {
    ...base,
    lane: 'production',
    variant: null,
    mode: 'autonomous',
    completionPolicy: 'default',
    taskNote: 'Open the order book first.',
    launchPlanId: 'lp-1',
    launchCandidateId: 'baseline',
    executionTemplate: {
      id: 'dev/default',
      sourceId: 'farm',
      flow: 'dev',
      platforms: [],
      labels: [],
      relativePath: 'templates/dev.md',
      sha256: 'a'.repeat(64),
    },
    acceptanceRegistration: undefined,
    completionAcceptance: {
      schemaVersion: 1,
      criteria: [
        {
          id: 'ac-1',
          text: 'Order book opens by default',
          verdict: 'proven',
          evidence: [],
          recipeNodes: [],
        },
      ],
    },
    metrics: { ...base.metrics, outcome: 'success', costEstimate: 1.25 },
    startRef: { requestedRef: 'main', resolvedSha: 'b'.repeat(40) },
    worktreeHeadAtDispatch: 'c'.repeat(40),
    finalHead: 'd'.repeat(40),
    prHead: 'e'.repeat(40),
    mergeSha: 'f'.repeat(40),
    gradedOutput: {
      diffSha256: '1'.repeat(64),
      source: 'committed',
      ref: 'd'.repeat(40),
      path: 'output/graded.diff',
      sizeBytes: 120,
      recordedAt: '2026-11-24T10:01:00Z',
    },
    agentContexts: [
      context({
        id: 'dev',
        role: 'dev',
        runner: 'claude',
        model: 'opus',
        effort: 'high',
        usage: {
          measuredAt: '2026-11-24T10:00:00Z',
          source: 'runner-transcript',
          inputTokens: 100,
          outputTokens: 50,
          cacheRead: 10,
          totalTokens: 160,
        },
        runnerSessionArchives: [{ status: 'captured', sessionKey: 'w1' }],
      }),
      context({
        id: 'review-fix',
        role: 'review-fix',
        runner: 'claude',
        model: 'opus',
        runnerSessionArchives: [{ status: 'captured', sessionKey: 'f1', answersRound: 1 }],
      }),
    ],
    decisions: [gate],
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'review',
            runner: 'codex',
            model: 'gpt-6.2-sol',
            mode: 'warm',
            loopNumber: 2,
            verdict: 'pass',
            unresolvedCount: 0,
            attempts: [
              {
                mode: 'cold',
                loopNumber: 1,
                verdict: 'issues',
                unresolvedCount: 2,
                session: { mode: 'warm', continuity: 'resumed', sessionId: 'r1' },
              },
              {
                mode: 'warm',
                loopNumber: 2,
                verdict: 'pass',
                unresolvedCount: 0,
                session: { mode: 'warm', continuity: 'resumed', sessionId: 'r1' },
              },
            ],
          },
        ],
      },
    },
  };
}

test('labels carry the task identity from existing run fields', () => {
  const labels = buildTraceLabels(gradedRun());
  assert.deepEqual(labels.task, {
    lane: 'production',
    variant: null,
    familyId: 'family-1',
    mode: 'autonomous',
    completionPolicy: 'default',
    templateId: 'dev/default',
    templateSha256: 'a'.repeat(64),
    note: 'Open the order book first.',
    launchPlanId: 'lp-1',
    candidateId: 'baseline',
  });
});

test('roles list every session, and cost is keyed per context with the worker USD', () => {
  const labels = buildTraceLabels(gradedRun());
  assert.deepEqual(labels.roles[1].sessions, [
    { sessionKey: 'f1', status: 'captured', answersRound: 1 },
  ]);
  const worker = labels.cost.find((entry) => entry.contextId === 'dev')!;
  assert.equal(worker.usd, 1.25);
  assert.equal(worker.usdSource, 'recorded');
  assert.equal(worker.totalTokens, 160);
  assert.ok(labels.cost.some((entry) => entry.contextId === 'review' && entry.role === 'review'));
});

test('review rounds link the fix that answered them', () => {
  const rounds = buildTraceLabels(gradedRun()).reviewRounds;
  assert.deepEqual(
    rounds.map(({ round, verdict, unresolvedCount, fix }) => ({
      round,
      verdict,
      unresolvedCount,
      fix,
    })),
    [
      {
        round: 1,
        verdict: 'issues',
        unresolvedCount: 2,
        fix: { contextId: 'review-fix', sessionKey: 'f1' },
      },
      { round: 2, verdict: 'pass', unresolvedCount: 0, fix: null },
    ],
  );
});

test('acceptance, gate, output and git come from the run record', () => {
  const labels = buildTraceLabels(gradedRun());
  assert.deepEqual(labels.acceptance, {
    source: 'derived',
    criteria: [{ id: 'ac-1', text: 'Order book opens by default', verdict: 'proven' }],
  });
  assert.deepEqual(labels.gate, {
    outcome: 'success',
    decision: 'approve',
    decidedAt: '2026-11-24T10:05:00Z',
  });
  assert.equal(labels.output?.path, 'output/graded.diff');
  assert.deepEqual(labels.git, {
    startRef: 'b'.repeat(40),
    dispatchHead: 'c'.repeat(40),
    finalHead: 'd'.repeat(40),
    prHead: 'e'.repeat(40),
    mergeSha: 'f'.repeat(40),
  });
});

test('a run that ended on infra failures alone is infraOnly; unknown values are null', () => {
  const base = makeRun({ id: 'run-2', status: 'failed' });
  const labels = buildTraceLabels({
    ...base,
    attemptLog: [
      { kind: 'infra-failure', step: 'prepare', at: '2026-11-24T09:00:00Z', error: 'node offline' },
    ],
  });
  assert.equal(labels.infraOnly, true);
  assert.equal(labels.output, null);
  assert.equal(labels.gate, null);
  assert.deepEqual(labels.acceptance, { source: 'none', criteria: [] });
  assert.equal(labels.git.finalHead, null);
});

test('a reviewer costs the sum of its attempts and each round names its archived session', () => {
  const run = gradedRun();
  const usage = (tokens: number, usd: number) => ({
    measuredAt: '2026-11-24T10:00:00Z',
    source: 'runner-transcript' as const,
    inputTokens: tokens,
    outputTokens: tokens,
    totalTokens: tokens * 2,
    costUsd: usd,
  });
  const reviews = run.engineState!.publishGate!.reviews!;
  reviews[0]!.attempts![0]!.usage = usage(100, 0.5);
  reviews[0]!.attempts![1]!.usage = usage(50, 0.25);
  run.agentContexts!.push(
    context({
      id: 'review',
      role: 'review',
      runnerSessionArchives: [
        { status: 'captured', sessionKey: 'r1-r1', round: 1 },
        { status: 'captured', sessionKey: 'r1-r2', round: 2 },
      ],
    }),
  );
  const labels = buildTraceLabels(run);
  const cost = labels.cost.find((entry) => entry.contextId === 'review' && entry.role === 'review');
  assert.equal(cost?.inputTokens, 150);
  assert.equal(cost?.usd, 0.75);
  assert.deepEqual(
    labels.reviewRounds.map((round) => round.sessionKey),
    ['r1-r1', 'r1-r2'],
  );
});

test('a legacy archive reads as session legacy in labels, as in the episode', () => {
  const run = gradedRun();
  run.agentContexts = [
    context({ id: 'dev', role: 'dev', runnerSessionArchive: { status: 'captured' } }),
  ];
  assert.deepEqual(buildTraceLabels(run).roles[0]!.sessions, [
    { sessionKey: 'legacy', status: 'captured' },
  ]);
});
