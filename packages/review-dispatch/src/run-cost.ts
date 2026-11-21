import {
  matchesFailedReviewUsageWindow,
  pendingSessionUsageLeaseIds,
  preferRunUsageReceipt,
  recordedSessionCost as recordedCost,
  retainedWorkerLifetimeSessions,
  type ReviewSessionTrace,
  type Run,
  type RunnerSessionUsage,
  verifiedSessionUsageLeaseIds,
} from '@farmslot/protocol';

import { resolveReviewMode } from './catalog.js';
import { pipelineReviewReceipts, type ReviewHistoryRound } from './review-history.js';

const phases = ['Implementation', 'Review', 'Review fix', 'CI fix', 'Unattributed'] as const;
type Phase = (typeof phases)[number];
type CostPhase = Phase | 'Mixed phases';

interface Coverage {
  subtotal: number | null;
  priced: number;
  missing: number;
  unpriced: number;
  shared: number;
  pending: number;
}

interface CostSession {
  receipt: RunnerSessionUsage;
  phases: Set<Phase>;
  contexts: Set<string>;
  leases: Set<string>;
  pendingLeases: Set<string>;
  observedPendingLeases: Set<string>;
}

type SessionIdentity = Pick<
  RunnerSessionUsage,
  'runner' | 'runnerSessionId' | 'requestId' | 'nativeSession'
>;

function sessionKey(row: SessionIdentity): string | null {
  if (!row.runner) return null;
  if (row.runnerSessionId) return JSON.stringify([row.runner, row.runnerSessionId]);
  if (row.requestId) return JSON.stringify([row.runner, 'request', row.requestId]);
  const native = row.nativeSession;
  return native
    ? JSON.stringify([
        row.runner,
        native.executionNodeId,
        native.ownerPrincipalId,
        native.sessionId,
      ])
    : null;
}

function costPhase(role: string | undefined): Phase {
  switch (role) {
    case 'primary':
    case 'dev':
    case 'fix-bug':
      return 'Implementation';
    case 'review':
      return 'Review';
    case 'review-fix':
      return 'Review fix';
    case 'ci-fix':
      return 'CI fix';
    default:
      return 'Unattributed';
  }
}

type CostRun = Pick<
  Run,
  | 'id'
  | 'repeatReviewContext'
  | 'reviewResult'
  | 'engineState'
  | 'agentContexts'
  | 'flowType'
  | 'sessionUsage'
  | 'costAccountingRevision'
> &
  Partial<Pick<Run, 'steps' | 'decisions'>>;

function recordedReviews(run: CostRun) {
  const live = run.engineState?.publishGate?.reviews;
  if (live?.length) return live;
  const decisions = run.decisions ?? [];
  for (let index = decisions.length - 1; index >= 0; index--) {
    const payload = decisions[index]?.payload;
    if (payload?.kind === 'ready') return payload.reviews ?? [];
  }
  return [];
}

const priorSessionCache = new WeakMap<CostRun, ReadonlySet<string>>();
let lastPriorSessions: { runId: string; revision?: string; ids: ReadonlySet<string> } | undefined;

export function priorRunSessions(run: CostRun): ReadonlySet<string> {
  const cached = priorSessionCache.get(run);
  if (cached) return cached;
  const revision = run.costAccountingRevision;
  if (revision && lastPriorSessions?.runId === run.id && lastPriorSessions.revision === revision) {
    priorSessionCache.set(run, lastPriorSessions.ids);
    return lastPriorSessions.ids;
  }
  const ids = new Set<string>();
  function collect(trace: ReviewSessionTrace | undefined, priorRunId = trace?.priorRunId) {
    if (priorRunId && priorRunId !== run.id && trace?.priorSessionId) ids.add(trace.priorSessionId);
  }
  collect(run.repeatReviewContext?.session, run.repeatReviewContext?.priorRunId);
  collect(run.reviewResult?.session);
  for (const review of recordedReviews(run)) {
    collect(review.session);
    for (const attempt of review.attempts ?? []) collect(attempt.session);
  }
  for (const id of retainedWorkerLifetimeSessions(run)) ids.add(id);
  for (const row of [
    ...(run.sessionUsage ?? []),
    ...pipelineReviewReceipts({ id: run.id, steps: run.steps ?? [] }),
  ])
    if (row.includesPriorRunLifetime && row.runnerSessionId) ids.add(row.runnerSessionId);
  const prior = lastPriorSessions;
  const stable =
    prior?.runId === run.id &&
    prior.ids.size === ids.size &&
    [...ids].every((id) => prior.ids.has(id))
      ? prior.ids
      : ids;
  priorSessionCache.set(run, stable);
  lastPriorSessions = { runId: run.id, revision, ids: stable };
  return stable;
}

const receiptCache = new WeakMap<CostRun, readonly RunnerSessionUsage[]>();
const noReceipts: readonly RunnerSessionUsage[] = [];
let lastReceipts:
  | { runId: string; revision: string; rows: readonly RunnerSessionUsage[] }
  | undefined;

function accountingFields(row: RunnerSessionUsage | undefined) {
  return (
    row && [
      sessionKey(row),
      row.runner,
      row.runnerSessionId,
      row.runId,
      row.role,
      row.roles,
      row.contextIds,
      row.usageLeaseIds,
      row.usageLeaseIdsVerified,
      row.pendingUsageLeaseIds,
      row.scope,
      row.startedAt,
      row.completedAt,
      row.source,
      Boolean(row.error),
      row.costStatus,
      row.pricingScope,
      row.includesPriorRunLifetime,
      row.costUsd,
      row.totalTokens,
      row.measuredAt,
    ]
  );
}

export function runCostReceipts(run: CostRun): readonly RunnerSessionUsage[] {
  const cached = receiptCache.get(run);
  if (cached) return cached;
  const observedRevision = run.costAccountingRevision;
  if (
    observedRevision &&
    lastReceipts?.runId === run.id &&
    lastReceipts.revision === observedRevision
  ) {
    receiptCache.set(run, lastReceipts.rows);
    return lastReceipts.rows;
  }
  const canonical = run.sessionUsage ?? noReceipts;
  const reviews = recordedReviews(run);
  const pipeline = pipelineReviewReceipts({ id: run.id, steps: run.steps ?? [] });
  // Older gateways have no receipt revision. Compare compact accounting inputs once. Clock ticks reuse
  // the WeakMap, and progress-only refreshes keep the existing cost index.
  const revision =
    observedRevision ??
    JSON.stringify([
      canonical.map(accountingFields),
      pipeline.map(accountingFields),
      reviews.map((review) => [
        review.runner,
        review.reviewerSessionId,
        review.session?.runner,
        review.session?.sessionId,
        accountingFields(review.usage),
        review.attempts?.map((attempt) => [
          attempt.session?.runner,
          attempt.session?.sessionId,
          accountingFields(attempt.usage),
        ]),
      ]),
    ]);
  if (lastReceipts?.runId === run.id && lastReceipts.revision === revision) {
    receiptCache.set(run, lastReceipts.rows);
    return lastReceipts.rows;
  }
  const additional: RunnerSessionUsage[] = [...pipeline];
  const hasReviewer = canonical.some((receipt) => receipt.role === 'review');
  for (const review of reviews) {
    const attempts = (review.attempts ?? []).flatMap((attempt) => {
      if (!attempt.usage) return [];
      const row: RunnerSessionUsage = {
        ...attempt.usage,
        role: 'review',
        runner: attempt.usage.runner ?? attempt.session?.runner ?? review.runner,
        runnerSessionId: attempt.usage.runnerSessionId ?? attempt.session?.sessionId,
      };
      // An attempt without an identity can be the same observation as the final result.
      return sessionKey(row) ? [row] : [];
    });
    additional.push(...attempts);
    if (review.usage) {
      const row: RunnerSessionUsage = {
        ...review.usage,
        role: 'review',
        runner: review.usage.runner ?? review.session?.runner ?? review.runner,
        runnerSessionId:
          review.usage.runnerSessionId ?? review.session?.sessionId ?? review.reviewerSessionId,
      };
      if (sessionKey(row) || (!hasReviewer && !attempts.length)) additional.push(row);
    }
  }
  const rows = additional.length ? [...canonical, ...additional] : canonical;
  receiptCache.set(run, rows);
  lastReceipts = { runId: run.id, revision, rows };
  return rows;
}

function sharedAcrossRuns(row: RunnerSessionUsage, priorSessions?: ReadonlySet<string>): boolean {
  return (
    row.scope !== 'run-delta' &&
    !!row.runnerSessionId &&
    priorSessions?.has(row.runnerSessionId) === true
  );
}

const sessionCache = new WeakMap<
  readonly RunnerSessionUsage[],
  Map<string | number, CostSession>
>();

function costSessions(rows: readonly RunnerSessionUsage[]): Map<string | number, CostSession> {
  const cached = sessionCache.get(rows);
  if (cached) return cached;
  const sessions = new Map<string | number, CostSession>();
  for (const [index, row] of rows.entries()) {
    const key = sessionKey(row) ?? index;
    let session = sessions.get(key);
    if (!session) {
      session = {
        receipt: row,
        phases: new Set(),
        contexts: new Set(),
        leases: new Set(),
        pendingLeases: new Set(),
        observedPendingLeases: new Set(),
      };
      sessions.set(key, session);
    }
    // These rows are observations of one conversation, including cumulative warm snapshots.
    session.receipt = preferRunUsageReceipt(session.receipt, row);
    const roles = new Set([row.role, ...(row.roles ?? [])].filter(Boolean));
    for (const role of roles) session.phases.add(costPhase(role));
    for (const id of row.contextIds ?? []) session.contexts.add(id);
    for (const id of row.usageLeaseIds ?? []) session.leases.add(id);
    for (const id of pendingSessionUsageLeaseIds(row)) session.pendingLeases.add(id);
    for (const id of row.pendingUsageLeaseIds ?? []) session.observedPendingLeases.add(id);
  }
  for (const session of sessions.values()) {
    for (const id of verifiedSessionUsageLeaseIds(session.receipt)) {
      session.pendingLeases.delete(id);
      session.observedPendingLeases.delete(id);
    }
  }
  sessionCache.set(rows, sessions);
  return sessions;
}

function usageMissing(row: RunnerSessionUsage): boolean {
  return row.source === 'unavailable' || Boolean(row.error);
}

function emptyCoverage(): Coverage {
  return { subtotal: null, priced: 0, missing: 0, unpriced: 0, shared: 0, pending: 0 };
}

function tally(coverage: Coverage, { receipt, pendingLeases }: CostSession, shared: boolean) {
  coverage.pending += pendingLeases.size;
  if (shared) {
    coverage.shared++;
    return;
  }
  const price = recordedCost(receipt);
  if (price !== null) {
    coverage.subtotal = (coverage.subtotal ?? 0) + price;
    coverage.priced++;
  } else if (usageMissing(receipt)) {
    coverage.missing++;
  } else {
    coverage.unpriced++;
  }
}

interface CostBreakdown extends Coverage {
  receiptCount: number;
  byPhase: Map<CostPhase, Coverage>;
  mixedPhases: Set<Phase>;
  pricedPhases: Set<Phase>;
  unallocatedPhases: Set<Phase>;
  authoritativeUnpricedPhases: Set<Phase>;
}

interface CostBreakdownCacheEntry {
  priorSessions: ReadonlySet<string> | undefined;
  value: CostBreakdown;
}

const breakdownCache = new WeakMap<readonly RunnerSessionUsage[], CostBreakdownCacheEntry>();

export function runCostBreakdown(
  rows: readonly RunnerSessionUsage[],
  priorSessions?: ReadonlySet<string>,
): CostBreakdown {
  const cached = breakdownCache.get(rows);
  if (cached && cached.priorSessions === priorSessions) return cached.value;
  const total = emptyCoverage();
  const byPhase = new Map<CostPhase, Coverage>();
  const mixedPhases = new Set<Phase>();
  const pricedPhases = new Set<Phase>();
  const unallocatedPhases = new Set<Phase>();
  const authoritativeUnpricedPhases = new Set<Phase>();
  const sessions = costSessions(rows);
  for (const session of sessions.values()) {
    const phase =
      session.phases.size > 1 ? 'Mixed phases' : ([...session.phases][0] ?? 'Unattributed');
    if (phase === 'Mixed phases') for (const member of session.phases) mixedPhases.add(member);
    const entry = byPhase.get(phase) ?? emptyCoverage();
    const shared = sharedAcrossRuns(session.receipt, priorSessions);
    tally(total, session, shared);
    tally(entry, session, shared);
    if (shared) for (const member of session.phases) unallocatedPhases.add(member);
    else if (recordedCost(session.receipt) !== null)
      for (const member of session.phases) pricedPhases.add(member);
    if (
      session.receipt.pricingScope === 'remote-tmux-pi' &&
      session.receipt.source === 'runner-transcript' &&
      !session.receipt.error &&
      session.receipt.costStatus === 'unpriced'
    )
      for (const member of session.phases) authoritativeUnpricedPhases.add(member);
    byPhase.set(phase, entry);
  }
  const value = {
    ...total,
    receiptCount: sessions.size,
    byPhase,
    mixedPhases,
    pricedPhases,
    unallocatedPhases,
    authoritativeUnpricedPhases,
  };
  breakdownCache.set(rows, { priorSessions, value });
  return value;
}

function matchesRecordedRoundWindow(
  recorded: RunnerSessionUsage,
  candidate: RunnerSessionUsage,
): boolean {
  if ((recorded.scope ?? 'session-total') !== (candidate.scope ?? 'session-total')) return false;
  const leases = new Set(recorded.usageLeaseIds);
  const candidateLeases = new Set(candidate.usageLeaseIds);
  if (leases.size !== candidateLeases.size || [...leases].some((id) => !candidateLeases.has(id)))
    return false;
  if (
    (recorded.startedAt && recorded.startedAt !== candidate.startedAt) ||
    (recorded.completedAt && recorded.completedAt !== candidate.completedAt)
  )
    return false;
  if (recorded.startedAt && recorded.completedAt) return true;
  if (recorded.totalTokens != null && candidate.totalTokens != null)
    return (
      recorded.totalTokens === candidate.totalTokens &&
      (recorded.scope !== 'run-delta' || recorded.measuredAt === candidate.measuredAt)
    );
  return (
    recorded.measuredAt === candidate.measuredAt && recorded.totalTokens === candidate.totalTokens
  );
}

type CostedRound = Pick<ReviewHistoryRound, 'key' | 'mode' | 'usage' | 'sessionIdentity'>;

export function reviewRoundCosts(
  rows: readonly RunnerSessionUsage[],
  rounds: readonly CostedRound[],
  run?: CostRun,
): Map<string, string> {
  const sessions = costSessions(rows);
  const priorSessions = run ? priorRunSessions(run) : undefined;
  const actors = new Map(run?.agentContexts?.map((actor) => [actor.id, actor]));
  const sources = rounds.map((round) => {
    if (recordedCost(round.usage) !== null) return round;
    const actor = actors.get(round.key);
    const identity =
      (round.usage && sessionKey(round.usage)) ??
      (round.sessionIdentity && sessionKey(round.sessionIdentity)) ??
      (actor?.role === 'review' && actor.runnerSessionId ? sessionKey(actor) : null);
    const session = identity ? sessions.get(identity) : undefined;
    if (
      !session?.contexts.has(round.key) ||
      (run && session.receipt.runId && session.receipt.runId !== run.id)
    )
      return round;
    if (round.usage) {
      const matches = usageMissing(round.usage)
        ? round.mode === 'cold' &&
          matchesFailedReviewUsageWindow(round.usage, session.receipt, round.key)
        : matchesRecordedRoundWindow(round.usage, session.receipt);
      if (!matches) return round;
    }
    return { ...round, usage: session.receipt };
  });
  const identities = sources.map(({ key, usage, sessionIdentity }) => {
    const actor = actors.get(key);
    return (
      (usage && sessionKey(usage)) ??
      (sessionIdentity && sessionKey(sessionIdentity)) ??
      (actor?.role === 'review' ? sessionKey(actor) : null)
    );
  });
  const counts = new Map<string, number>();
  for (const identity of identities)
    if (identity) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  return new Map(
    sources.map(({ key, mode, usage }, index) => {
      const identity = identities[index];
      const session = identity ? sessions.get(identity) : undefined;
      const shared =
        (identity ? (counts.get(identity) ?? 0) > 1 : false) ||
        (session?.contexts.size ?? 0) > 1 ||
        (session?.leases.size ?? 0) > 1 ||
        (session?.phases.size ?? 0) > 1 ||
        (usage?.contextIds?.length ?? 0) > 1 ||
        (usage?.usageLeaseIds?.length ?? 0) > 1;
      const verified = session?.receipt;
      const sameWindow = usage && verified && matchesRecordedRoundWindow(usage, verified);
      const measuredLeases = sameWindow ? verifiedSessionUsageLeaseIds(verified) : [];
      const roundPending = pendingSessionUsageLeaseIds(usage).some(
        (lease) => !measuredLeases.includes(lease),
      );
      const pending = Boolean(session?.pendingLeases.size) || roundPending;
      const ownReceipt =
        usage === rounds[index]?.usage && recordedCost(usage) !== null && !roundPending;
      const cost = recordedCost(sameWindow && !pending ? verified : usage);
      if (shared || (usage && sharedAcrossRuns(usage, priorSessions)))
        return [key, 'Round cost unavailable · shared session'];
      // A dedicated recorded attempt can still price itself when a legacy ledger has lease hints.
      // A recorded pending retry, or a missing round receipt, cannot certify a complete round.
      if (session?.observedPendingLeases.size || (pending && !ownReceipt))
        return [key, 'Round cost unavailable · pending usage'];
      // A warm attempt needs its own usage window. Run deltas cover the owning run.
      return [
        key,
        cost !== null && identity && mode === 'cold'
          ? `Round cost ${formatUsageCost(cost)}`
          : 'Round cost unavailable',
      ];
    }),
  );
}

function gaps(coverage: Coverage): string[] {
  return [
    ...(coverage.pending
      ? [
          coverage.pending +
            (coverage.pending === 1 ? ' pending usage capture' : ' pending usage captures'),
        ]
      : []),
    ...(coverage.unpriced ? [`${coverage.unpriced} unpriced`] : []),
    ...(coverage.missing ? [`${coverage.missing} missing usage`] : []),
    ...(coverage.shared ? [`${coverage.shared} lifetime cost unallocated`] : []),
  ];
}

export function formatUsageCost(value: number | null | undefined, reason?: string): string {
  if (value == null) return reason ?? 'Unpriced';
  return `$${value.toFixed(value !== 0 && value < 1 ? 4 : 2)}`;
}

export function runCostSummary(
  rows: readonly RunnerSessionUsage[],
  legacyEstimate?: number | null,
  priorSessions?: ReadonlySet<string>,
  estimatePhase: 'Implementation' | 'Review' = 'Implementation',
) {
  const cost = runCostBreakdown(rows, priorSessions);
  const estimate =
    legacyEstimate != null &&
    !cost.pricedPhases.has(estimatePhase) &&
    !cost.unallocatedPhases.has(estimatePhase) &&
    !cost.authoritativeUnpricedPhases.has(estimatePhase)
      ? (estimatePhase === 'Review' ? 'Review' : 'Worker') +
        ' estimate ' +
        formatUsageCost(legacyEstimate)
      : null;
  if (!cost.receiptCount && !estimate) return undefined;
  const phaseOrder: readonly CostPhase[] = [
    'Implementation',
    'Review',
    'Review fix',
    'CI fix',
    'Mixed phases',
    'Unattributed',
  ];
  return {
    subtotal: 'Known subtotal ' + formatUsageCost(cost.subtotal, 'unavailable'),
    coverage: cost.receiptCount
      ? [cost.priced + ' of ' + cost.receiptCount + ' priced', ...gaps(cost)].join(' · ')
      : 'No session receipts',
    estimate,
    phases: cost.receiptCount
      ? phaseOrder.flatMap((phase) => {
          const value = cost.byPhase.get(phase);
          if (!value && (phase === 'Mixed phases' || phase === 'Unattributed')) return [];
          const included = phase !== 'Mixed phases' && cost.mixedPhases.has(phase);
          return [
            {
              phase,
              label: value
                ? [formatUsageCost(value.subtotal, 'Cost unavailable'), ...gaps(value)].join(' · ')
                : included
                  ? 'Included in mixed'
                  : 'No receipt',
              detail:
                phase === 'Mixed phases'
                  ? phases.filter((part) => cost.mixedPhases.has(part)).join(' / ')
                  : value && included
                    ? 'also in mixed'
                    : undefined,
            },
          ];
        })
      : [],
  };
}

export function runCostSummaryForRun(run: Run) {
  const review = run.flowType === 'review-pr';
  const reviewMode = run.reviewResult?.session?.mode ?? resolveReviewMode({ run });
  const priorSessions = priorRunSessions(run);
  // Warm generation estimates can be differences of cumulative transcript totals.
  const scopedEstimate =
    run.metrics.sessionUsageScope !== 'review-chain-total' &&
    (review
      ? reviewMode === 'cold'
      : !run.engineState?.flags?.warmHandoffSucceeded &&
        !run.engineState?.flags?.nudgeReuse &&
        !priorSessions.has(run.metrics.runnerSessionId ?? ''));
  return runCostSummary(
    runCostReceipts(run),
    scopedEstimate ? run.metrics.costEstimate : undefined,
    priorSessions,
    review ? 'Review' : 'Implementation',
  );
}
