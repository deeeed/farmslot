import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run, RunDecision, RunnerSessionUsage } from '@farmslot/protocol';
import { type ReviewHistoryRound, reviewHistoryView } from '@farmslot/review-dispatch';

import { litText } from '../../testing/lit-text.js';

import * as costModel from './run-detail-cost.js';
const { renderRunCost, reviewRoundCosts, runCostBreakdown, runCostReceipts, priorRunSessions } =
  costModel;

function receipt(
  runnerSessionId: string,
  role: string,
  costUsd: number | null,
  overrides: Partial<RunnerSessionUsage> = {},
): RunnerSessionUsage {
  return {
    runner: 'pi',
    runnerSessionId,
    role,
    costUsd,
    source: 'runner-transcript',
    scope: 'session-total',
    measuredAt: '2026-11-19T18:00:00Z',
    ...overrides,
  };
}

type Round = Pick<ReviewHistoryRound, 'key' | 'mode' | 'usage'>;

test('TAT-4707 receipt pattern counts shared review once and keeps mixed cost out of phase subtotals', () => {
  const rows = [
    receipt('worker', 'fix-bug', 0.386113502),
    receipt('reviewer', 'review', 2.293315, { measuredAt: '2026-11-19T17:00:00Z' }),
    receipt('reviewer', 'review', 5.6972894),
    receipt('repair', 'review-fix', 0.148654264, { roles: ['review-fix', 'fix-bug', 'ci-fix'] }),
    receipt('repair-ci', 'ci-fix', 0.01676658, { roles: ['ci-fix', 'fix-bug'] }),
    receipt('grade1', 'grade', null, { source: 'unavailable' }),
    receipt('grade2', 'grade', null, { source: 'unavailable' }),
    receipt('summary', 'summary', null, { source: 'unavailable' }),
  ];
  const cost = runCostBreakdown(rows);
  assert.equal(cost.priced, 4);
  assert.equal(cost.missing, 3);
  assert.equal(cost.unpriced, 0);
  assert.equal(cost.subtotal?.toFixed(9), '6.248823746');
  assert.equal(cost.byPhase.get('Review')?.subtotal, 5.6972894);
  assert.equal(cost.byPhase.get('Mixed phases')?.subtotal?.toFixed(9), '0.165420844');
  assert.equal(cost.byPhase.get('Review fix')?.subtotal, undefined);
  assert.match(
    litText(renderRunCost(rows)),
    /Known subtotal.*\$6\.25.*4 of 7 priced.*3 missing usage/s,
  );
  assert.match(litText(renderRunCost(rows)), /Mixed phases.*Implementation.*Review fix.*CI fix/s);
});

test('TAT-4708 receipt pattern exposes unpriced implementation and keeps $0 distinct from missing', () => {
  const rows = [
    receipt('worker', 'fix-bug', null, { costStatus: 'unpriced', totalTokens: 500 }),
    receipt('reviewer', 'review', 11.5681024),
    receipt('final-reviewer', 'review', 3.2337886),
    receipt('repair-one', 'review-fix', 0.241849174, { roles: ['fix-bug', 'review-fix'] }),
    receipt('repair-two', 'review-fix', 0.160202948, { roles: ['fix-bug', 'review-fix'] }),
    receipt('summary', 'summary', null, { source: 'unavailable' }),
  ];
  assert.equal(runCostBreakdown(rows).subtotal?.toFixed(9), '15.203943122');
  assert.match(litText(renderRunCost(rows)), /Implementation.*Cost unavailable.*1 unpriced/s);
  assert.equal(runCostBreakdown([receipt('zero', 'dev', 0)]).subtotal, 0);
  assert.equal(runCostBreakdown([]).subtotal, null);
});

test('TAT-4727 receipt pattern leaves shared rounds unknown and displays only the dedicated cold cost', () => {
  const cold = receipt('cold', 'review', 2.2465074, { scope: 'run-delta' });
  const warm = receipt('shared', 'review', 5.4976178, {
    scope: 'run-delta',
    contextIds: ['one', 'three'],
    usageLeaseIds: ['first-lease', 'warm-lease'],
  });
  const rounds: Round[] = [
    { key: 'one', mode: 'cold', usage: { ...warm, costUsd: 3.1803942 } },
    { key: 'three', mode: 'warm', usage: warm },
    { key: 'four', mode: 'cold', usage: cold },
  ];
  const costs = reviewRoundCosts([warm, cold], rounds);
  assert.match(costs.get('one') ?? '', /Round cost unavailable.*shared session/);
  assert.match(costs.get('three') ?? '', /Round cost unavailable.*shared session/);
  assert.equal(costs.get('four'), 'Round cost $2.25');
});

test('a warm lifetime snapshot and an unbound run delta stay unknown', () => {
  const warm = receipt('warm', 'review', 2.5);
  const rounds: Round[] = [
    { key: 'warm', mode: 'warm', usage: warm },
    { key: 'delta', mode: 'warm', usage: receipt('delta', 'review', 2.6, { scope: 'run-delta' }) },
  ];
  const costs = reviewRoundCosts([warm], rounds);
  assert.match(costs.get('warm') ?? '', /Round cost unavailable/);
  assert.match(costs.get('delta') ?? '', /Round cost unavailable/);
});

test('a run delta with one recorded lease still leaves the warm round cost unavailable', () => {
  const usage = receipt('warm', 'review', 1.25, {
    scope: 'run-delta',
    startedAt: '2026-11-19T17:30:00Z',
  });
  const row = { ...usage, contextIds: ['round'], usageLeaseIds: ['lease'] };
  assert.equal(runCostBreakdown([row]).subtotal, 1.25);
  assert.equal(
    reviewRoundCosts([row], [{ key: 'round', mode: 'warm', usage }]).get('round'),
    'Round cost unavailable',
  );
  assert.equal(
    reviewRoundCosts([row], [{ key: 'other', mode: 'warm', usage }]).get('other'),
    'Round cost unavailable',
  );
});

test('resumed lifetime spend has no run subtotal without a run-scoped receipt', () => {
  const row = receipt('previous-conversation', 'review', 8);
  const prior = new Set(['previous-conversation']);
  const lifetime = runCostBreakdown([row], prior);
  assert.equal(lifetime.subtotal, null);
  assert.equal(lifetime.shared, 1);
  assert.equal(runCostBreakdown([{ ...row, scope: 'run-delta', costUsd: 5 }], prior).subtotal, 5);
});

test('the most complete verified capture survives a newer failed or smaller read', () => {
  const priced = receipt('same', 'review', 4, { totalTokens: 100 });
  const newerTime = '2026-11-19T19:00:00Z';
  assert.equal(
    runCostBreakdown([
      priced,
      { ...priced, costUsd: null, source: 'unavailable', measuredAt: newerTime },
      { ...priced, costUsd: 1, totalTokens: 25, measuredAt: newerTime },
    ]).subtotal,
    4,
  );
});

test('a legacy worker estimate is visible beside review receipts and outside the subtotal', () => {
  const rows = [receipt('review', 'review', 3)];
  const view = litText(renderRunCost(rows, 0.4));
  assert.match(view, /Known subtotal.*\$3\.00.*Worker estimate.*\$0\.4000/s);
});

test('a standalone review can price its current context from an exact session receipt', () => {
  const row = receipt('current', 'review', 2.25, { contextIds: ['actor'] });
  const run = {
    id: 'run',
    flowType: 'review-pr' as const,
    agentContexts: [
      {
        id: 'actor',
        runId: 'run',
        role: 'review' as const,
        label: 'Reviewer',
        slotId: 'slot',
        status: 'complete' as const,
        runner: 'pi',
        runnerSessionId: 'current',
        target: { session: 'farm', window: 'review', pane: null, target: 'farm:review' },
      },
    ],
  };
  const rounds: Round[] = [{ key: 'actor', mode: 'cold' }];
  assert.equal(reviewRoundCosts([row], rounds, run).get('actor'), 'Round cost $2.25');
  assert.equal(
    reviewRoundCosts([{ ...row, runnerSessionId: 'older' }], rounds, run).get('actor'),
    'Round cost unavailable',
  );
});

test('a priced review result supplies a missing canonical receipt without duplicating a shared one', () => {
  const worker = receipt('worker', 'fix-bug', 1);
  const usage = receipt('review', 'review', 2.25);
  const result = {
    id: 'run',
    flowType: 'fix-bug' as const,
    sessionUsage: [worker],
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'review',
            loopNumber: 1,
            unresolvedCount: 0,
            mode: 'cold' as const,
            verdict: 'pass' as const,
            usage,
          },
        ],
      },
    },
  };
  assert.equal(runCostBreakdown(runCostReceipts(result)).subtotal, 3.25);
  assert.equal(
    runCostBreakdown(
      runCostReceipts({
        ...result,
        sessionUsage: [worker, usage],
      }),
    ).subtotal,
    3.25,
  );
});

test('successful warm worker handoff leaves lifetime spend unallocated', () => {
  const run = {
    id: 'child',
    flowType: 'fix-bug' as const,
    engineState: { flags: { warmHandoffSucceeded: true } },
    sessionUsage: [
      receipt('inherited-worker', 'fix-bug', 10),
      receipt('own-review', 'review', 2, { scope: 'run-delta' }),
    ],
  };
  const cost = runCostBreakdown(run.sessionUsage, priorRunSessions(run));
  assert.equal(cost.subtotal, 2);
  assert.equal(cost.shared, 1);
});

test('a successful retained nudge excludes only the accepting worker conversation', () => {
  const nudged = receipt('inherited', 'fix-bug', 10);
  const fresh = receipt('fresh', 'primary', 2);
  const run = {
    id: 'child',
    flowType: 'pr-complete' as const,
    engineState: { flags: { nudgeReuse: true } },
    steps: [
      {
        name: 'dispatch',
        status: 'done' as const,
        outputs: { success: true, nudged: true, workerTarget: 'slot:1' },
      },
    ],
    agentContexts: [
      {
        id: 'fix-bug',
        runId: 'child',
        role: 'fix-bug' as const,
        label: 'Worker',
        slotId: 'slot',
        status: 'complete' as const,
        runner: 'pi',
        runnerSessionId: 'inherited',
        target: { session: 'slot', window: '1', pane: null, target: 'slot:1' },
      },
    ],
    sessionUsage: [nudged, fresh],
  };
  const inherited = priorRunSessions(run);
  assert.deepEqual([...inherited], ['inherited']);
  assert.equal(runCostBreakdown(run.sessionUsage, inherited).subtotal, 2);
  assert.equal(
    runCostBreakdown([{ ...nudged, scope: 'run-delta', costUsd: 1 }, fresh], inherited).subtotal,
    3,
  );
  const replayed = { ...run, steps: [], agentContexts: [] };
  const replayCost = runCostBreakdown(replayed.sessionUsage, priorRunSessions(replayed));
  assert.equal(replayCost.subtotal, null);
  assert.equal(replayCost.shared, 2);
});

test('a priced review receipt replaces a missing observation and earlier conversations count once', () => {
  const earlier = receipt('old', 'review', 1);
  const later = receipt('new', 'review', 3);
  const missing = { ...later, source: 'unavailable' as const, costUsd: null };
  const run = {
    id: 'run',
    flowType: 'fix-bug' as const,
    sessionUsage: [missing],
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'review',
            loopNumber: 3,
            unresolvedCount: 0,
            mode: 'cold' as const,
            verdict: 'pass' as const,
            reviewerSessionId: 'new',
            usage: later,
            attempts: [
              {
                loopNumber: 1,
                mode: 'cold' as const,
                verdict: 'issues' as const,
                unresolvedCount: 1,
                usage: earlier,
              },
              {
                loopNumber: 2,
                mode: 'warm' as const,
                verdict: 'issues' as const,
                unresolvedCount: 1,
                usage: { ...earlier, measuredAt: '2026-11-19T19:00:00Z', costUsd: 2 },
              },
              {
                loopNumber: 3,
                mode: 'cold' as const,
                verdict: 'pass' as const,
                unresolvedCount: 0,
                usage: later,
              },
            ],
          },
        ],
      },
    },
  };
  const cost = runCostBreakdown(runCostReceipts(run));
  assert.equal(cost.subtotal, 5);
  assert.equal(cost.receiptCount, 2);
  assert.equal(cost.priced, 2);
  assert.equal(cost.missing, 0);
});

test('an inherited lifetime receipt keeps its estimate unavailable', () => {
  const shared = receipt('prior-conversation', 'review', 10);
  const priorSessions = new Set(['prior-conversation']);
  const html = litText(renderRunCost([shared], 1.25, priorSessions, 'Review'));
  assert.match(html, /Known subtotal unavailable.*lifetime cost unallocated/s);
  assert.doesNotMatch(html, /Review estimate/);
  assert.doesNotMatch(
    litText(
      renderRunCost(
        [{ ...shared, scope: 'run-delta', costUsd: 1.25 }],
        1.25,
        priorSessions,
        'Review',
      ),
    ),
    /Review estimate/,
  );
});

test('a replacement on the retained target leaves both lifetime receipts unallocated', () => {
  const inherited = receipt('worker', 'fix-bug', 10, { contextIds: ['fix-bug'] });
  const replacement = receipt('replacement', 'fix-bug', 3, { contextIds: ['fix-bug'] });
  const unrelated = receipt('other', 'ci-fix', 2, { contextIds: ['ci-fix'] });
  const run = {
    id: 'child',
    flowType: 'pr-complete' as const,
    engineState: { flags: { warmHandoffSucceeded: true } },
    steps: [
      {
        name: 'dispatch',
        status: 'done' as const,
        outputs: { success: true, warmHandoff: true, workerTarget: 'slot:bugfix' },
      },
    ],
    agentContexts: [
      {
        id: 'fix-bug',
        runId: 'child',
        role: 'fix-bug' as const,
        label: 'Worker',
        slotId: 'slot',
        status: 'complete' as const,
        runner: 'pi',
        runnerSessionId: 'replacement',
        target: { session: 'slot', window: 'bugfix', pane: null, target: 'slot:bugfix' },
      },
    ],
    sessionUsage: [inherited, replacement, unrelated],
  };
  const cost = runCostBreakdown(run.sessionUsage, priorRunSessions(run));
  assert.equal(cost.subtotal, 2);
  assert.equal(cost.shared, 2);
  const scoped = { ...replacement, scope: 'run-delta' as const };
  assert.equal(runCostBreakdown([inherited, scoped, unrelated], priorRunSessions(run)).subtotal, 5);
});

test('later recovery prices the same dedicated round after the attempt capture failed', () => {
  const recovered = receipt('reviewer', 'review', 3, { contextIds: ['actor'] });
  const failed = { ...recovered, source: 'unavailable' as const, costUsd: null };
  const round = { key: 'actor', mode: 'cold' as const, usage: failed };
  const run = {
    id: 'run',
    flowType: 'fix-bug' as const,
    agentContexts: [
      {
        id: 'actor',
        runId: 'run',
        role: 'review' as const,
        label: 'Reviewer',
        slotId: 'slot',
        status: 'complete' as const,
        runner: 'pi',
        runnerSessionId: 'reviewer',
        target: null,
      },
    ],
  };
  assert.equal(reviewRoundCosts([recovered], [round], run).get('actor'), 'Round cost $3.00');
  assert.equal(
    reviewRoundCosts(
      [recovered],
      [{ ...round, usage: { ...failed, runnerSessionId: 'prior' } }],
      run,
    ).get('actor'),
    'Round cost unavailable',
  );
});

test('an equally complete unpriced recapture leaves the verified price intact', () => {
  const priced = receipt('reviewer', 'review', 3, { totalTokens: 100 });
  const unpriced = {
    ...priced,
    costUsd: null,
    costStatus: 'unpriced' as const,
    measuredAt: '2026-11-20T18:00:00Z',
  };
  assert.equal(runCostBreakdown([priced, unpriced]).subtotal, 3);
  assert.equal(runCostBreakdown([priced, { ...unpriced, totalTokens: 101 }]).subtotal, null);
});

test('an omitted scope is a lifetime receipt for the priced tie-breaker', () => {
  const priced = receipt('reviewer', 'review', 3, { scope: undefined, totalTokens: 100 });
  const unpriced = receipt('reviewer', 'review', null, {
    totalTokens: 100,
    costStatus: 'unpriced',
    measuredAt: '2026-11-20T18:00:00Z',
  });
  assert.equal(runCostBreakdown([priced, unpriced]).subtotal, 3);
  assert.equal(runCostBreakdown([unpriced, priced]).subtotal, 3);
});

test('an unpriced worker receipt leaves a separate estimate, while inherited lifetime spend does not', () => {
  const row = receipt('worker', 'fix-bug', null, { costStatus: 'unpriced' });
  assert.match(litText(renderRunCost([row], 0.5)), /Worker estimate.*\$0\.5000/s);
  assert.doesNotMatch(litText(renderRunCost([row], 0.5, new Set(['worker']))), /Worker estimate/);
});

test('equivalent receipt refreshes reuse the accounting index across changed run progress', () => {
  const run = {
    id: 'refresh-control',
    flowType: 'fix-bug' as const,
    sessionUsage: [receipt('worker', 'fix-bug', 1)],
    steps: [{ name: 'monitor', status: 'running' as const, outputs: { progress: 2 } }],
  };
  const initial = runCostReceipts(run);
  const refreshed = structuredClone(run);
  refreshed.steps[0]!.outputs.progress = 3;
  assert.equal(runCostReceipts(refreshed), initial);
  assert.equal(priorRunSessions(refreshed), priorRunSessions(run));
  const repriced = { ...refreshed, sessionUsage: [receipt('worker', 'fix-bug', 2)] };
  assert.equal(runCostBreakdown(runCostReceipts(repriced)).subtotal, 2);
});

test('historical ready decisions supply review receipts and prior-conversation provenance', () => {
  const decision: RunDecision = {
    id: 'saved-gate',
    type: 'engine_human_gate',
    title: 'Ready',
    description: '',
    actions: [],
    createdAt: '2026-11-19T18:00:00Z',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: { files: 0, additions: 0, deletions: 0 },
      workerReport: '',
      branch: 'review',
      reviews: [
        {
          id: 'prior',
          mode: 'warm',
          verdict: 'pass',
          loopNumber: 1,
          unresolvedCount: 0,
          session: {
            mode: 'warm',
            continuity: 'resumed',
            priorRunId: 'earlier',
            priorSessionId: 'old',
          },
          usage: receipt('old', 'review', 10),
        },
        {
          id: 'cold',
          mode: 'cold',
          verdict: 'pass',
          loopNumber: 1,
          unresolvedCount: 0,
          usage: receipt('new', 'review', 3),
        },
      ],
    },
  };
  const run = { id: 'current', flowType: 'fix-bug' as const, decisions: [decision] };
  const cost = runCostBreakdown(runCostReceipts(run), priorRunSessions(run));
  assert.equal(cost.subtotal, 3);
  assert.equal(cost.shared, 1);
  assert.equal(cost.receiptCount, 2);
});

test('a dedicated cold review uses the exact attempt session when the usage row omits it', () => {
  const usage = receipt('round', 'review', 3, { runnerSessionId: null, runner: null });
  const run: Run = {
    id: 'standalone-result',
    familyId: 'standalone-result',
    parentRunId: null,
    familyRootTicketOrPr: 'COST',
    flowType: 'review-pr',
    lane: 'production',
    variant: null,
    mode: 'interactive',
    status: 'done',
    project: 'fixture',
    ticketOrPr: 'COST',
    slotId: null,
    branch: null,
    taskFile: null,
    createdAt: '2026-11-20T00:00:00Z',
    updatedAt: '2026-11-20T00:01:00Z',
    decisions: [],
    steps: [],
    metrics: { nudgeCount: 0, runner: 'pi', model: null },
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviews: [
          {
            id: 'review',
            mode: 'cold',
            verdict: 'pass',
            loopNumber: 1,
            unresolvedCount: 0,
            runner: 'pi',
            reviewerSessionId: 'earlier',
            attempts: [
              {
                mode: 'cold',
                verdict: 'failed',
                loopNumber: 1,
                unresolvedCount: 0,
                startedAt: '2026-11-20T00:01:00Z',
                session: { mode: 'cold', continuity: 'fresh', runner: 'pi', sessionId: 'earlier' },
              },
              {
                mode: 'cold',
                verdict: 'pass',
                loopNumber: 1,
                unresolvedCount: 0,
                startedAt: '2026-11-20T00:02:00Z',
                issues: [],
                session: { mode: 'cold', continuity: 'fresh', runner: 'pi', sessionId: 'round' },
                usage,
              },
            ],
          },
        ],
      },
    },
  };
  const rows = runCostReceipts(run);
  const rounds = reviewHistoryView(run).cards.map(({ round }) => round);
  assert.equal(rounds[0]?.usage?.runnerSessionId, 'round');
  assert.deepEqual([...reviewRoundCosts(rows, rounds, run).values()], ['Round cost $3.00']);
  assert.equal(runCostBreakdown(rows, priorRunSessions(run)).subtotal, 3);
});

test('the gateway revision reuses cost projections without examining receipt history', () => {
  const run = {
    id: 'server-revision',
    flowType: 'fix-bug' as const,
    costAccountingRevision: 'a',
    sessionUsage: [receipt('worker', 'fix-bug', 1)],
  };
  const rows = runCostReceipts(run);
  const inherited = priorRunSessions(run);
  const progress = {
    ...run,
    get sessionUsage(): RunnerSessionUsage[] {
      throw new Error('Progress refresh should reuse the accepted receipt revision');
    },
  };
  assert.equal(runCostReceipts(progress), rows);
  assert.equal(priorRunSessions(progress), inherited);
  const updated = {
    ...run,
    costAccountingRevision: 'b',
    sessionUsage: [receipt('worker', 'fix-bug', 2)],
  };
  assert.equal(runCostBreakdown(runCostReceipts(updated)).subtotal, 2);
});

test('a known native handoff leaves unrelated reviewer receipts eligible', () => {
  const actor: AgentContext = {
    id: 'worker',
    runId: 'current',
    role: 'primary',
    label: 'Worker',
    slotId: 'slot',
    status: 'working',
    runner: 'pi',
    runnerSessionId: 'inherited',
    target: null,
    nativeSession: {
      sessionId: 'native',
      ownerPrincipalId: 'operator',
      executionNodeId: 'mini',
      leaseId: 'current',
      commandId: 'send',
      handoffFrom: { runId: 'previous', contextId: 'worker', leaseId: 'earlier' },
    },
  };
  const run = {
    id: 'current',
    flowType: 'pr-complete' as const,
    agentContexts: [actor],
    engineState: { flags: { nudgeReuse: true } },
    steps: [{ name: 'dispatch', status: 'done' as const, outputs: { nudged: true } }],
    sessionUsage: [
      receipt('inherited', 'primary', 10, { contextIds: ['worker'] }),
      receipt('review', 'review', 2),
    ],
  };
  const cost = runCostBreakdown(runCostReceipts(run), priorRunSessions(run));
  assert.equal(cost.subtotal, 2);
  assert.equal(cost.shared, 1);
});

test('a replayed lifetime receipt with retained provenance stays out of the subtotal', () => {
  const old = receipt('retained', 'primary', 10, { includesPriorRunLifetime: true });
  const newWorker = receipt('fresh', 'primary', 2);
  const run = { id: 'replayed', flowType: 'pr-complete' as const, sessionUsage: [old, newWorker] };
  const cost = runCostBreakdown(runCostReceipts(run), priorRunSessions(run));
  assert.equal(cost.subtotal, 2);
  assert.equal(cost.shared, 1);
});

test('pipeline receipts are available before the gate and deduplicated against retained receipts', () => {
  const usage = receipt('pipeline', 'review', 2);
  const run = {
    id: 'pipeline-run',
    flowType: 'fix-bug' as const,
    steps: [
      {
        name: 'review',
        status: 'done' as const,
        outputs: { usage, attempts: [{ loopNumber: 1, mode: 'cold', usage }] },
      },
    ],
  };
  assert.equal(runCostBreakdown(runCostReceipts(run)).subtotal, 2);
  assert.equal(
    runCostBreakdown(runCostReceipts({ ...run, sessionUsage: [usage] })).receiptCount,
    1,
  );
});

test('a token-only observation preserves verified USD at the same scope', () => {
  const usd = receipt('worker', 'fix-bug', 2, { totalTokens: null });
  const tokens = receipt('worker', 'fix-bug', null, { totalTokens: 100, costStatus: 'unpriced' });
  assert.equal(runCostBreakdown([usd, tokens]).subtotal, 2);
});

test('remote pricing corrects older review totals and per-round prices, including an unpriced result', () => {
  const old = receipt('dedicated', 'review', 4, { totalTokens: 100 });
  const corrected = receipt('dedicated', 'review', 2, {
    pricingScope: 'remote-tmux-pi',
    measuredAt: '2026-11-20T18:00:00Z',
    totalTokens: 100,
  });
  const unpriced = { ...corrected, costUsd: null, costStatus: 'unpriced' as const };
  const round: Round = { key: 'dedicated', mode: 'cold', usage: old };
  assert.equal(runCostBreakdown([corrected, old]).subtotal, 2);
  assert.equal(reviewRoundCosts([corrected, old], [round]).get(round.key), 'Round cost $2.00');
  assert.equal(runCostBreakdown([unpriced, old]).subtotal, null);
  assert.equal(reviewRoundCosts([unpriced, old], [round]).get(round.key), 'Round cost unavailable');
});

test('a confirmed cold review stays priced if a legacy retained worker has no target', () => {
  const reviewed = receipt('independent-review', 'review', 3);
  const run = {
    id: 'legacy-handoff',
    flowType: 'fix-bug' as const,
    sessionUsage: [receipt('worker', 'fix-bug', 10), reviewed],
    engineState: {
      flags: { warmHandoffSucceeded: true },
      publishGate: {
        publicationStatus: 'not_published' as const,
        reviews: [
          {
            id: 'review',
            mode: 'cold' as const,
            verdict: 'pass' as const,
            loopNumber: 1,
            unresolvedCount: 0,
            usage: reviewed,
          },
        ],
      },
    },
  };
  assert.deepEqual([...priorRunSessions(run)], ['worker']);
  assert.equal(runCostBreakdown(runCostReceipts(run), priorRunSessions(run)).subtotal, 3);
});

test('a dedicated cold pipeline receipt is independent of a retained worker without a target', () => {
  const cold = receipt('cold-pipeline', 'review', 3);
  const warm = receipt('warm-pipeline', 'review', 8);
  const run = {
    id: 'legacy-pipeline',
    flowType: 'fix-bug' as const,
    engineState: { flags: { warmHandoffSucceeded: true } },
    sessionUsage: [receipt('worker', 'fix-bug', 10), cold, warm],
    steps: [
      {
        name: 'review',
        status: 'done' as const,
        outputs: {
          attempts: [
            { mode: 'cold', verdict: 'pass', usage: cold },
            { mode: 'warm', verdict: 'pass', usage: warm },
          ],
        },
      },
    ],
  };
  assert.deepEqual([...priorRunSessions(run)], ['worker', 'warm-pipeline']);
  assert.equal(runCostBreakdown(runCostReceipts(run), priorRunSessions(run)).subtotal, 3);
});

test('a receipt-less warm round prevents pricing its shared cold conversation', () => {
  const paid = receipt('shared', 'review', 4);
  const rounds = [
    { key: 'cold', mode: 'cold' as const, usage: paid },
    {
      key: 'warm',
      mode: 'warm' as const,
      sessionIdentity: { runner: 'pi', runnerSessionId: 'shared' },
    },
  ];
  const costs = reviewRoundCosts([paid], rounds);
  assert.equal(costs.get('cold'), 'Round cost unavailable · shared session');
  assert.equal(costs.get('warm'), 'Round cost unavailable · shared session');
});

test('a receipt-less round cannot borrow a rebound actor price', () => {
  const later = receipt('replacement', 'review', 9, { contextIds: ['actor'] });
  const run = {
    id: 'r',
    flowType: 'fix-bug' as const,
    agentContexts: [
      {
        id: 'actor',
        role: 'review' as const,
        runId: 'r',
        slotId: null,
        label: 'Review',
        status: 'complete' as const,
        runner: 'pi',
        runnerSessionId: 'replacement',
      },
    ],
  };
  const [label] = reviewRoundCosts(
    [later],
    [
      {
        key: 'actor',
        mode: 'cold',
        sessionIdentity: { runner: 'pi', runnerSessionId: 'retained' },
      },
    ],
    run,
  ).values();
  assert.equal(label, 'Round cost unavailable');
});

test('a cold round keeps its recorded price when a later lifetime receipt has more work', () => {
  const first = receipt('reviewer', 'review', 1, {
    totalTokens: 100,
    usageLeaseIds: ['owning-lease'],
  });
  const later = { ...first, totalTokens: 800, costUsd: 8, measuredAt: '2026-11-20T18:00:00Z' };
  const [label] = reviewRoundCosts(
    [first, later],
    [{ key: 'cold', mode: 'cold', usage: first }],
  ).values();
  assert.equal(label, 'Round cost $1.00');
});

test('an authoritative unpriced receipt suppresses the stale worker estimate', () => {
  const remote = receipt('worker', 'fix-bug', null, {
    totalTokens: 10,
    pricingScope: 'remote-tmux-pi',
    costStatus: 'unpriced',
  });
  assert.doesNotMatch(litText(renderRunCost([remote], 1.25)), /Worker estimate/);
  assert.match(
    litText(renderRunCost([{ ...remote, pricingScope: undefined }], 1.25)),
    /Worker estimate/,
  );
});

test('an unpriced round can use only a recovery from its recorded time window', () => {
  const priced = receipt('reviewer', 'review', 4, {
    startedAt: '2026-11-20T00:00:00Z',
    completedAt: '2026-11-20T00:02:00Z',
    contextIds: ['attempt'],
    totalTokens: 100,
  });
  const unpriced = { ...priced, costUsd: null, costStatus: 'unpriced' as const };
  const round = { key: 'attempt', mode: 'cold' as const, usage: unpriced };
  assert.equal(reviewRoundCosts([priced], [round]).get(round.key), 'Round cost $4.00');
  const later = { ...priced, completedAt: '2026-11-20T00:03:00Z' };
  assert.equal(reviewRoundCosts([later], [round]).get(round.key), 'Round cost unavailable');
  const snapshot = {
    id: 'r',
    flowType: 'fix-bug' as const,
    sessionUsage: [priced],
  };
  const before = runCostReceipts(snapshot);
  assert.notEqual(runCostReceipts({ ...snapshot, sessionUsage: [later] }), before);
});

test('a gate summary joins its ledger receipt using the runner in its recorded trace', () => {
  const unpriced = receipt('gate-review', 'review', null, {
    totalTokens: 100,
    costStatus: 'unpriced',
  });
  const priced = receipt('gate-review', 'review', 2, { runner: undefined, totalTokens: 100 });
  const review = {
    id: 'gate',
    mode: 'cold' as const,
    loopNumber: 1,
    verdict: 'pass' as const,
    unresolvedCount: 0,
    usage: priced,
    session: {
      mode: 'cold' as const,
      continuity: 'fresh' as const,
      sessionId: 'gate-review',
    },
  };
  const snapshot = {
    id: 'gate-runner',
    flowType: 'fix-bug' as const,
    sessionUsage: [unpriced],
    engineState: {
      publishGate: { publicationStatus: 'not_published' as const, reviews: [review] },
    },
  };
  assert.equal(runCostBreakdown(runCostReceipts(snapshot)).subtotal, null);
  const qualified = {
    ...snapshot,
    engineState: {
      publishGate: {
        ...snapshot.engineState.publishGate,
        reviews: [{ ...review, session: { ...review.session, runner: 'pi' } }],
      },
    },
  };
  const cost = runCostBreakdown(runCostReceipts(qualified));
  assert.equal(cost.subtotal, 2);
  assert.equal(cost.receiptCount, 1);
});

test('a fuller lifetime receipt wins over a smaller repriced snapshot in either order', () => {
  const small = receipt('reviewer', 'review', 1, {
    totalTokens: 100,
    pricingScope: 'remote-tmux-pi',
  });
  const full = receipt('reviewer', 'review', 8, {
    totalTokens: 800,
    measuredAt: '2026-11-20T18:00:00Z',
  });
  for (const [first, next] of [
    [small, full],
    [full, small],
  ] as const)
    assert.equal(runCostBreakdown([first, next]).subtotal, 8);
  assert.equal(
    runCostBreakdown([small, { ...full, costUsd: null, costStatus: 'unpriced' }]).subtotal,
    null,
  );
});

test('a conflicting partial time bound forbids recovering an unpriced round', () => {
  const priced = receipt('reviewer', 'review', 4, {
    contextIds: ['attempt'],
    totalTokens: 100,
    startedAt: '2026-11-20T00:00:00Z',
    completedAt: '2026-11-20T00:02:00Z',
  });
  const unpriced = {
    ...priced,
    costUsd: null,
    costStatus: 'unpriced' as const,
    startedAt: '2026-11-20T00:01:00Z',
    completedAt: undefined,
  };
  const round = { key: 'attempt', mode: 'cold' as const, usage: unpriced };
  assert.equal(reviewRoundCosts([priced], [round]).get(round.key), 'Round cost unavailable');
  const recovered = { ...priced, startedAt: unpriced.startedAt };
  assert.equal(reviewRoundCosts([recovered], [round]).get(round.key), 'Round cost $4.00');
});

test('pending native captures keep the known subtotal and mark incomplete coverage', () => {
  const first = receipt('retry', 'review', 2, {
    scope: 'run-delta',
    usageLeaseIds: ['first'],
    contextIds: ['reviewer'],
  });
  const pending = { ...first, pendingUsageLeaseIds: ['retry', 'retry'] };
  const run = { id: 'native-pending', flowType: 'fix-bug' as const, sessionUsage: [first] };
  const before = runCostReceipts(run);
  const after = runCostReceipts({ ...run, sessionUsage: [pending] });
  assert.notEqual(after, before);
  const text = litText(renderRunCost([first, pending]));
  assert.match(text, /Known subtotal \$2\.00/);
  assert.match(text, /1 pending usage capture/);
  const round = { key: 'reviewer', mode: 'cold' as const, usage: first };
  assert.equal(
    reviewRoundCosts([first, pending], [round]).get(round.key),
    'Round cost unavailable · pending usage',
  );
  const settled = { ...first, costUsd: 3, totalTokens: 50, usageLeaseIds: ['first', 'retry'] };
  assert.doesNotMatch(litText(renderRunCost([pending, settled])), /pending usage capture/);
});

test('a failed cold capture can recover an exactly owned native round price', () => {
  const startedAt = '2026-11-19T17:59:00Z';
  const failed = receipt('native', 'review', null, {
    source: 'unavailable',
    scope: undefined,
    startedAt,
  });
  const recovered = receipt('native', 'review', 4, {
    scope: 'run-delta',
    usageLeaseIds: ['lease'],
    contextIds: ['actor'],
    startedAt,
  });
  const round = { key: 'actor', mode: 'cold' as const, usage: failed };
  assert.equal(reviewRoundCosts([recovered], [round]).get(round.key), 'Round cost $4.00');
  for (const wrong of [
    { ...recovered, contextIds: ['other'] },
    { ...recovered, startedAt: '2026-11-19T17:59:05Z' },
    { ...recovered, usageLeaseIds: ['lease', 'retry'] },
  ]) {
    assert.match(
      reviewRoundCosts([wrong], [round]).get(round.key) ?? '',
      /^Round cost unavailable/,
    );
  }
  assert.equal(
    reviewRoundCosts([recovered], [{ ...round, mode: 'warm' }]).get(round.key),
    'Round cost unavailable',
  );
});
