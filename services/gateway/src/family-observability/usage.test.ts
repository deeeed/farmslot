import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunnerSessionUsage } from '@farmslot/protocol';

import { buildFamilyObservabilityTokenSummary } from './token-summary.js';
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

test('the family session total keeps its lifetime receipt beside a newer run delta', () => {
  const first = {
    ...makeRun({ id: 'first', createdAt: '2026-11-04T21:00:00Z' }),
    sessionUsage: [receipt({ scope: 'session-total', costUsd: 5 })],
  };
  const next = {
    ...makeRun({ id: 'next', createdAt: '2026-11-05T01:00:00Z' }),
    sessionUsage: [
      receipt({
        scope: 'run-delta',
        costUsd: 1,
        totalTokens: 10,
        measuredAt: '2026-11-05T02:00:00Z',
      }),
    ],
  };
  const view = buildFamilyUsage([first, next]);
  assert.equal(view.sessions[0]?.usage.costUsd, 5);
  assert.equal(view.sessions[0]?.usage.scope, 'session-total');
  assert.equal(view.contributions.find(({ runId }) => runId === 'next')?.usage.costUsd, 1);
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

test('round association follows the canonical promotion of its exact pending native reservation', () => {
  const binding = {
    sessionId: 'native-review',
    leaseId: 'lease',
    generation: 'generation',
    commandId: 'command',
    executionNodeId: 'mini',
    ownerPrincipalId: 'owner',
    stateDirectory: '/fixture/native',
  };
  const pending = makeRun({
    id: 'pending-run',
    flowType: 'review-pr',
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Reviewer',
        status: 'working',
        runId: 'pending-run',
        slotId: null,
        runner: 'codex',
        nativeSession: binding,
      },
    ],
  });
  const peer = makeRun({
    id: 'captured-run',
    createdAt: '2026-11-05T01:00:00Z',
    sessionUsage: [
      receipt({
        runnerSessionId: 'confirmed',
        nativeSession: binding,
        role: 'review',
        roles: ['review'],
        costUsd: 0.25,
      }),
    ],
  });
  const data = buildFamilyUsage([pending, peer]);
  assert.equal(data.sessions.length, 1);
  assert.deepEqual(data.sessions[0].runIds, ['pending-run', 'captured-run']);
  assert.equal(data.rounds[0].usage?.runnerSessionId, 'confirmed');
  assert.equal(data.rounds[0].usage?.costUsd, 0.25);
  assert.equal(data.rounds[0].costScope, 'shared-session');
});

test('a pending reviewer cannot borrow a different native reservation', () => {
  const binding = {
    sessionId: 'current-native',
    leaseId: 'lease',
    commandId: 'command',
    executionNodeId: 'mini',
    ownerPrincipalId: 'owner',
  };
  const run = makeRun({
    id: 'pending',
    flowType: 'review-pr',
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Reviewer',
        status: 'working',
        runId: 'pending',
        slotId: null,
        runner: 'codex',
        nativeSession: binding,
      },
    ],
    sessionUsage: [
      receipt({
        runnerSessionId: 'old-reviewer',
        contextIds: ['review'],
        nativeSession: { ...binding, sessionId: 'old-native' },
        role: 'review',
        roles: ['review'],
        costUsd: 0.25,
      }),
    ],
  });
  const round = buildFamilyUsage([run]).rounds[0];
  assert.equal(round.usage?.runnerSessionId, null);
  assert.equal(round.usage?.nativeSession?.sessionId, 'current-native');
  assert.equal(round.usage?.totalTokens, null);
  assert.equal(round.costScope, 'unavailable');
});

test('a failed pipeline capture uses only its matching recovered Family receipt', () => {
  const failed = receipt({
    runnerSessionId: 'selected',
    role: 'review',
    roles: ['review'],
    source: 'unavailable',
    error: 'Capture failed',
    costUsd: null,
  });
  const recovered = receipt({
    runnerSessionId: 'selected',
    role: 'review',
    roles: ['review'],
    contextIds: ['actor'],
    scope: 'run-delta',
    costUsd: 4,
  });
  const unrelated = { ...recovered, runnerSessionId: 'replacement', costUsd: 9 };
  const run = makeRun({
    sessionUsage: [unrelated, recovered],
    agentContexts: [
      {
        id: 'actor',
        role: 'review',
        runId: 'usage-run',
        label: 'Review',
        slotId: null,
        status: 'complete',
        runner: 'codex',
        runnerSessionId: 'selected',
        reviewId: 'pipeline-review-usage-run',
        reviewLoopNumber: 1,
      },
    ],
    steps: [
      {
        name: 'review',
        status: 'done',
        outputs: { attempts: [{ loopNumber: 1, mode: 'cold', verdict: 'pass', usage: failed }] },
      },
    ],
  });
  const [round] = buildFamilyUsage([run]).rounds;
  assert.equal(round?.usage?.costUsd, 4);
  assert.equal(round?.usage?.scope, 'run-delta');
  assert.equal(round?.usageOrigin, 'associated-session');
});

test('a Family round keeps its own run delta when its conversation continues elsewhere', () => {
  const first = receipt({
    runnerSessionId: 'continued-review',
    role: 'review',
    roles: ['review'],
    contextIds: ['check:1'],
    scope: 'run-delta',
    usageLeaseIds: ['first-window'],
    runId: 'first',
    totalTokens: 100,
    costUsd: 1,
  });
  const later = {
    ...first,
    runId: 'later',
    usageLeaseIds: ['later-window'],
    measuredAt: '2026-11-05T02:00:00Z',
    totalTokens: 800,
    costUsd: 8,
  };
  const original = makeRun({
    id: 'first',
    sessionUsage: [first],
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviews: [
          {
            id: 'check',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            usage: first,
          },
        ],
      },
    },
  });
  const next = makeRun({ id: 'later', createdAt: '2026-11-05T01:00:00Z', sessionUsage: [later] });
  const data = buildFamilyUsage([original, next]);
  assert.equal(data.rounds[0]?.usage?.costUsd, 1);
  assert.equal(data.rounds[0]?.usage?.totalTokens, 100);
  assert.deepEqual(data.rounds[0]?.usage?.usageLeaseIds, ['first-window']);
  assert.equal(data.rounds[0]?.usageOrigin, 'round-receipt');
  assert.equal(data.sessions[0]?.usage.costUsd, 8);
});

test('a recovered delta must match the recorded lease window within the owning run', () => {
  const captured = receipt({
    role: 'review',
    roles: ['review'],
    runnerSessionId: 'review',
    contextIds: ['review:1'],
    scope: 'run-delta',
    usageLeaseIds: ['first-window'],
    costUsd: 1,
  });
  const expanded = {
    ...captured,
    usageLeaseIds: ['first-window', 'second-window'],
    totalTokens: 200,
    costUsd: 5,
  };
  const original = makeRun({
    sessionUsage: [expanded],
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviews: [
          {
            id: 'review',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            usage: captured,
          },
        ],
      },
    },
  });
  assert.equal(buildFamilyUsage([original]).rounds[0]?.usage?.costUsd, 1);
});

test('Family cannot recover a failed round from a different context on the same conversation', () => {
  const failed = receipt({
    runnerSessionId: 'same',
    role: 'review',
    roles: ['review'],
    source: 'unavailable',
    error: 'Capture failed',
    costUsd: null,
    contextIds: ['earlier:1'],
  });
  const later = receipt({
    runnerSessionId: 'same',
    role: 'review',
    roles: ['review'],
    contextIds: ['replacement'],
    scope: 'run-delta',
    costUsd: 8,
    totalTokens: 800,
  });
  const run = makeRun({
    sessionUsage: [later],
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviews: [
          {
            id: 'earlier',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            usage: failed,
          },
        ],
      },
    },
  });
  assert.equal(buildFamilyUsage([run]).rounds[0]?.usage?.source, 'unavailable');
  assert.equal(buildFamilyUsage([run]).rounds[0]?.usage?.costUsd, null);
  run.sessionUsage = [{ ...later, contextIds: ['earlier:1', 'replacement'] }];
  assert.equal(buildFamilyUsage([run]).rounds[0]?.usage?.source, 'unavailable');
  run.sessionUsage = [{ ...later, contextIds: ['earlier:1'] }];
  assert.equal(buildFamilyUsage([run]).rounds[0]?.usage?.costUsd, 8);
});

test('Family preserves a recorded lifetime price when its receipt covers a different window', () => {
  const recorded = receipt({
    role: 'review',
    roles: ['review'],
    runnerSessionId: 'timed-review',
    contextIds: ['timed:1'],
    startedAt: '2026-11-04T22:00:00Z',
    completedAt: '2026-11-04T22:08:00Z',
    totalTokens: 800,
    costUsd: 8,
  });
  const shorter = {
    ...recorded,
    completedAt: '2026-11-04T22:01:00Z',
    totalTokens: 100,
    costUsd: 1,
    pricingScope: 'remote-tmux-pi' as const,
  };
  const run = makeRun({
    sessionUsage: [shorter],
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviews: [
          {
            id: 'timed',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            usage: recorded,
          },
        ],
      },
    },
  });
  assert.equal(buildFamilyUsage([run]).rounds[0]?.usage?.costUsd, 8);
  run.sessionUsage = [{ ...recorded, pricingScope: 'remote-tmux-pi', costUsd: 7 }];
  assert.equal(buildFamilyUsage([run]).rounds[0]?.usage?.costUsd, 7);
});

test('matching context does not recover a failed Family capture with conflicting bounds', () => {
  const failed = receipt({
    runnerSessionId: 'same',
    role: 'review',
    roles: ['review'],
    source: 'unavailable',
    error: 'Capture failed',
    costUsd: null,
    contextIds: ['earlier:1'],
    startedAt: '2026-11-04T22:00:00Z',
    completedAt: '2026-11-04T22:01:00Z',
  });
  const later = receipt({
    runnerSessionId: 'same',
    role: 'review',
    roles: ['review'],
    contextIds: ['earlier:1'],
    scope: 'run-delta',
    costUsd: 8,
    totalTokens: 800,
    startedAt: '2026-11-04T22:00:00Z',
    completedAt: '2026-11-04T22:08:00Z',
  });
  const run = makeRun({
    sessionUsage: [later],
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviews: [
          {
            id: 'earlier',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            usage: failed,
          },
        ],
      },
    },
  });
  assert.equal(buildFamilyUsage([run]).rounds[0]?.usage?.source, 'unavailable');
  run.sessionUsage = [{ ...later, completedAt: failed.completedAt }];
  assert.equal(buildFamilyUsage([run]).rounds[0]?.usage?.costUsd, 8);
});

test('a pipeline-only review contributes to Family totals and coverage once', () => {
  const usage = receipt({
    runnerSessionId: 'pipeline-only',
    role: 'review',
    roles: ['review'],
    costUsd: 4,
  });
  const run = makeRun({
    steps: [
      {
        name: 'review',
        status: 'done',
        outputs: {
          runner: 'codex',
          usage,
          attempts: [{ loopNumber: 1, mode: 'cold', verdict: 'pass', usage }],
        },
      },
    ],
  });
  for (const source of [run, { ...run, sessionUsage: [usage] }]) {
    const view = buildFamilyUsage([source]);
    const tokens = buildFamilyObservabilityTokenSummary([source], source.id);
    assert.equal(tokens.runPoints[0]?.stepCostEstimate, 4);
    assert.equal(view.rounds[0]?.usage?.costUsd, 4);
    assert.equal(view.runCoverage[0]?.receipts, 1);
    assert.equal(view.runCoverage[0]?.costCaptures, 1);
    assert.deepEqual(
      view.contributions.map(({ usage }) => usage.costUsd),
      [4],
    );
  }
});
