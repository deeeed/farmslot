import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunnerSessionUsage } from '@farmslot/protocol';

import { buildFamilyUsage } from './usage.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'usage-run',
    familyId: 'family',
    parentRunId: null,
    familyRootTicketOrPr: 'USAGE',
    lane: 'production',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    status: 'done',
    project: 'fixture',
    ticketOrPr: 'USAGE',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-04T21:00:00Z',
    updatedAt: '2026-11-04T23:00:00Z',
    ...overrides,
  };
}

function receipt(overrides: Partial<RunnerSessionUsage> = {}): RunnerSessionUsage {
  return {
    runner: 'codex',
    runnerSessionId: 'shared-worker',
    actualModel: 'gpt-6.1-sol',
    source: 'runner-transcript',
    measuredAt: '2026-11-04T23:00:00Z',
    totalTokens: 100,
    role: 'dev',
    roles: ['dev'],
    costUsd: null,
    ...overrides,
  };
}

test('F411 projects shared receipts once, preserves missing sessions and uses canonical deltas', () => {
  const first = {
    ...makeRun({ id: 'root', createdAt: '2026-11-04T21:00:00Z' }),
    sessionUsage: [
      receipt(),
      receipt({
        runnerSessionId: 'missing',
        source: 'unavailable',
        totalTokens: null,
        role: 'grade',
        roles: ['grade'],
      }),
    ],
  };
  const next = {
    ...makeRun({ id: 'next', createdAt: '2026-11-05T01:00:00Z' }),
    sessionUsage: [
      receipt({
        totalTokens: 160,
        role: 'review-fix',
        roles: ['review-fix'],
        measuredAt: '2026-11-05T02:00:00Z',
      }),
      receipt({
        runner: 'api:provider',
        runnerSessionId: 'helper-request',
        role: 'helper',
        roles: ['helper'],
        kind: 'helper',
        identityKind: 'request',
        totalTokens: 10,
        costUsd: 0.01,
      }),
    ],
  };
  const before = JSON.stringify([first, next]);
  const data = buildFamilyUsage([next, first]);
  assert.equal(data.sessions.length, 3);
  const shared = data.sessions.find((row) => row.usage.runnerSessionId === 'shared-worker');
  assert.deepEqual(shared?.runIds, ['root', 'next']);
  assert.deepEqual(shared?.usage.roles, ['dev', 'review-fix']);
  assert.equal(shared?.usage.totalTokens, 160);
  assert.equal(
    data.sessions.find((row) => row.usage.runnerSessionId === 'missing')?.usage.source,
    'unavailable',
  );
  assert.deepEqual(
    data.contributions.map((row) => [row.runId, row.usage.totalTokens]),
    [
      ['root', 100],
      ['next', 60],
      ['next', 10],
    ],
  );
  assert.equal(
    JSON.stringify([first, next]),
    before,
    'read projection does not change stored receipts',
  );
});

test('shared review conversations are not presented as the cost of each warm round', () => {
  const run = makeRun({ id: 'reviews' });
  const usage = receipt({
    runnerSessionId: 'warm-review',
    role: 'review',
    roles: ['review'],
    totalTokens: 200,
    costUsd: 0.02,
  });
  run.engineState = {
    publishGate: {
      reviews: [
        {
          id: 'check',
          mode: 'warm',
          loopNumber: 2,
          verdict: 'pass',
          unresolvedCount: 0,
          runner: 'codex',
          model: 'gpt-6.1-sol',
          reviewerSessionId: 'warm-review',
          usage,
          attempts: [
            {
              mode: 'cold',
              loopNumber: 1,
              verdict: 'issues',
              unresolvedCount: 1,
              usage: { ...usage, totalTokens: 100, costUsd: 0.01 },
              startedAt: '2026-11-04T22:00:00Z',
              completedAt: '2026-11-04T22:01:00Z',
            },
            {
              mode: 'warm',
              loopNumber: 2,
              verdict: 'pass',
              unresolvedCount: 0,
              usage,
              startedAt: '2026-11-04T22:02:00Z',
              completedAt: '2026-11-04T22:03:00Z',
            },
          ],
        },
      ],
    },
  };
  const data = buildFamilyUsage([run]);
  assert.equal(data.rounds.length, 2);
  assert.deepEqual(
    data.rounds.map((round) => round.costScope),
    ['shared-session', 'shared-session'],
  );
  assert.deepEqual(
    data.rounds.map((round) => round.usage?.totalTokens),
    [100, 200],
  );
});

test('receipt-less runs remain explicit in family coverage', () => {
  const data = buildFamilyUsage([makeRun({ id: 'missing' })]);
  assert.deepEqual(data.runCoverage, [
    { runId: 'missing', receipts: 0, tokenCaptures: 0, costCaptures: 0 },
  ]);
});

test('pending native identity migrates through the shared merge across family runs', () => {
  const nativeSession = {
    sessionId: 'native',
    executionNodeId: 'mini',
    ownerPrincipalId: 'owner',
    stateDirectory: '/fixture/native',
  };
  const first = makeRun({
    id: 'first',
    sessionUsage: [
      receipt({
        runnerSessionId: null,
        nativeSession,
        source: 'unavailable',
        totalTokens: null,
        contextIds: ['dev-context'],
      }),
    ],
  });
  const next = makeRun({
    id: 'next',
    createdAt: '2026-11-05T01:00:00Z',
    sessionUsage: [
      receipt({
        runnerSessionId: 'confirmed',
        nativeSession,
        role: 'review-fix',
        roles: ['review-fix'],
        contextIds: ['fix-context'],
      }),
    ],
  });
  const data = buildFamilyUsage([first, next]);
  assert.equal(data.sessions.length, 1);
  assert.deepEqual(data.sessions[0].runIds, ['first', 'next']);
  assert.deepEqual(
    data.sessions[0].participations.map((p) => p.roles),
    [['dev'], ['review-fix']],
  );
});

test('a unique surviving review card is still a session-total capture, not a round delta', () => {
  const run = makeRun();
  run.engineState = {
    publishGate: {
      reviews: [
        {
          id: 'review',
          mode: 'cold',
          loopNumber: 1,
          verdict: 'pass',
          unresolvedCount: 0,
          usage: receipt({ role: 'review', roles: ['review'], costUsd: 0.25 }),
        },
      ],
    },
  };
  assert.equal(buildFamilyUsage([run]).rounds[0].costScope, 'session-total');
});

test('known USD survives missing tokens and shared review participation across runs', () => {
  const usage = receipt({ role: 'review', roles: ['review'], totalTokens: null, costUsd: 0.25 });
  const earlier = makeRun({ id: 'earlier', sessionUsage: [usage] });
  const later = makeRun({ id: 'later', createdAt: '2026-11-05T01:00:00Z' });
  later.engineState = {
    publishGate: {
      reviews: [
        { id: 'review', mode: 'cold', loopNumber: 1, verdict: 'pass', unresolvedCount: 0, usage },
      ],
    },
  };
  const projection = buildFamilyUsage([earlier, later]);
  assert.equal(projection.rounds[0].costScope, 'shared-session');
  assert.equal(projection.rounds[0].usage?.costUsd, 0.25);
  assert.equal(
    projection.contributions.reduce((sum, row) => sum + (row.usage.costUsd ?? 0), 0),
    0.25,
  );
  assert.equal(projection.contributions[0].usage.totalTokens, null);
});

test('a relaunched static reviewer never borrows an old conversation receipt', () => {
  const run = makeRun({
    flowType: 'review-pr',
    sessionUsage: [
      receipt({
        runnerSessionId: 'old-reviewer',
        contextIds: ['review'],
        role: 'review',
        roles: ['review'],
        costUsd: 0.25,
      }),
    ],
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        status: 'working',
        runId: 'usage-run',
        slotId: null,
        runner: 'codex',
        runnerSessionId: 'replacement',
        model: 'gpt-6.1-sol',
      },
    ],
  });
  const round = buildFamilyUsage([run]).rounds[0];
  assert.ok(round);
  assert.equal(round.usage?.runnerSessionId, 'replacement');
  assert.equal(round.usage?.totalTokens, null);
  assert.equal(round.costScope, 'unavailable');
});

test('a missing owner and ambiguous retained identities leave round accounting unavailable', () => {
  const run = makeRun({
    sessionUsage: [
      receipt({ runnerSessionId: 'old', contextIds: ['check:1'] }),
      receipt({ runnerSessionId: 'replacement', contextIds: ['check:1'] }),
    ],
    engineState: {
      publishGate: {
        reviews: [
          { id: 'check', mode: 'cold', loopNumber: 1, verdict: 'pass', unresolvedCount: 0 },
        ],
      },
    },
  });
  const round = buildFamilyUsage([run]).rounds[0];
  assert.equal(round.usage, undefined);
  assert.equal(round.costScope, 'unavailable');
});
