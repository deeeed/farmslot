// ADR-039 Amendment 10: an episode's label values, read from run-record fields only.
import {
  type AcceptanceStatusLedger,
  primaryRoleForFlow,
  type Run,
  type RunAttemptLogEntry,
  type RunnerSessionArchiveRef,
  type RunnerSessionUsage,
} from '@farmslot/protocol';

import { archiveRefsOf } from '../runners/session-archive.js';

export interface TraceSessionLabel {
  sessionKey: string | null;
  status: RunnerSessionArchiveRef['status'];
  answersRound?: number;
}

export interface TraceCostLabel {
  contextId: string;
  role: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
  usd: number | null;
  /** `recorded` when the run recorded a price; export may price the rest (`export-table`). */
  usdSource: 'recorded' | null;
}

export interface TraceLabels {
  task: {
    lane: Run['lane'] | null;
    variant: string | null;
    familyId: string;
    mode: Run['mode'] | null;
    completionPolicy: Run['completionPolicy'] | null;
    templateId: string | null;
    templateSha256: string | null;
    note: string | null;
    launchPlanId: string | null;
    candidateId: string | null;
  };
  roles: {
    role: string;
    contextId: string;
    runner: string | null;
    model: string | null;
    effort: string | null;
    sessions: TraceSessionLabel[];
  }[];
  cost: TraceCostLabel[];
  acceptance: {
    source: 'registered' | 'derived' | 'none';
    criteria: { id: string; text: string; verdict: string }[];
  };
  reviewRounds: {
    round: number;
    contextId: string;
    sessionKey: string | null;
    reviewer: { runner: string | null; model: string | null };
    verdict: string;
    unresolvedCount: number;
    fix: { contextId: string; sessionKey: string | null } | null;
  }[];
  gate: { outcome: string | null; decision: string | null; decidedAt: string | null } | null;
  attempts: RunAttemptLogEntry[];
  infraOnly: boolean;
  output: Run['gradedOutput'] | null;
  git: {
    startRef: string | null;
    dispatchHead: string | null;
    finalHead: string | null;
    prHead: string | null;
    mergeSha: string | null;
  };
}

/** The same session view the episode lists, legacy archives included. */
const archiveRefs = archiveRefsOf;

function sessions(refs: RunnerSessionArchiveRef[]): TraceSessionLabel[] {
  return refs.map((ref) => ({
    sessionKey: ref.sessionKey ?? null,
    status: ref.status,
    ...(ref.answersRound !== undefined ? { answersRound: ref.answersRound } : {}),
  }));
}

/** A reviewer's cost summed over its attempts; a total is null when no attempt recorded it. */
function reviewCost(contextId: string, usages: (RunnerSessionUsage | undefined)[]): TraceCostLabel {
  const recorded = usages.filter((usage): usage is RunnerSessionUsage => Boolean(usage));
  const sum = (pick: (usage: RunnerSessionUsage) => number | null | undefined) => {
    const values = recorded.map(pick).filter((value): value is number => typeof value === 'number');
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const usd = sum((usage) => usage.costUsd);
  return {
    contextId,
    role: 'review',
    inputTokens: sum((usage) => usage.inputTokens),
    outputTokens: sum((usage) => usage.outputTokens),
    cacheReadTokens: sum((usage) => usage.cacheRead),
    totalTokens: sum((usage) => usage.totalTokens),
    usd,
    usdSource: usd === null ? null : 'recorded',
  };
}

function usageCost(contextId: string, role: string, usage?: RunnerSessionUsage): TraceCostLabel {
  const recorded = typeof usage?.costUsd === 'number';
  return {
    contextId,
    role,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheRead ?? null,
    totalTokens: usage?.totalTokens ?? null,
    usd: recorded ? usage!.costUsd! : null,
    usdSource: recorded ? 'recorded' : null,
  };
}

/** The gate's acceptance ledger, else the completion snapshot. */
function acceptanceLedger(run: Run): AcceptanceStatusLedger | undefined {
  for (const decision of [...(run.decisions ?? [])].reverse()) {
    const payload = decision.payload;
    if (payload?.kind === 'ready' && payload.acceptanceStatus) return payload.acceptanceStatus;
  }
  return run.completionAcceptance;
}

function attempts(run: Run): TraceLabels['attempts'] {
  const fromSteps: TraceLabels['attempts'] = run.steps
    .filter((step) => step.name === 'dispatch' && step.startedAt)
    .map((step) => ({ kind: 'dispatch', step: step.name, at: step.startedAt! }));
  const replays: TraceLabels['attempts'] = (run.recoveryAttempts ?? []).map((attempt) => ({
    kind: attempt.triggeredBy === 'operator' ? 'replay' : 'recovery',
    step: attempt.stepName,
    at: attempt.startedAt,
    ...(attempt.status === 'failed' ? { error: 'replay failed' } : {}),
  }));
  return [...fromSteps, ...replays, ...(run.attemptLog ?? [])].sort((a, b) =>
    a.at.localeCompare(b.at),
  );
}

/** Builds the `labels.*` values of a run's episode (ADR-039 Amendment 10). */
export function buildTraceLabels(run: Run): TraceLabels {
  const contexts = run.agentContexts ?? [];
  const reviews = run.engineState?.publishGate?.reviews ?? [];
  const fixContext = contexts.find((context) => context.role === 'review-fix');
  const fixRefs = fixContext
    ? archiveRefs(fixContext.runnerSessionArchives, fixContext.runnerSessionArchive)
    : [];
  const ledger = acceptanceLedger(run);
  const gateDecision = [...(run.decisions ?? [])]
    .reverse()
    .find((decision) => decision.type === 'engine_human_gate' && decision.resolvedAt);
  const allAttempts = attempts(run);
  const ended = ['failed', 'blocked', 'cancelled'].includes(run.status);

  return {
    task: {
      lane: run.lane ?? null,
      variant: run.variant ?? null,
      familyId: run.familyId,
      mode: run.mode ?? null,
      completionPolicy: run.completionPolicy ?? null,
      templateId: run.executionTemplate?.id ?? null,
      templateSha256: run.executionTemplate?.sha256 ?? null,
      note: run.taskNote ?? null,
      launchPlanId: run.launchPlanId ?? null,
      candidateId: run.launchCandidateId ?? null,
    },
    roles: contexts.map((context) => ({
      role: context.role,
      contextId: context.id,
      runner: context.runner ?? null,
      model: context.model ?? null,
      effort: context.effort ?? null,
      sessions: sessions(archiveRefs(context.runnerSessionArchives, context.runnerSessionArchive)),
    })),
    cost: [
      ...contexts
        .filter((context) => context.role !== 'review')
        .map((context) => {
          const primary = context.role === primaryRoleForFlow(run.flowType);
          const cost = usageCost(context.id, context.role, context.usage);
          // The worker's USD lives on run metrics.
          if (primary && cost.usd === null && typeof run.metrics.costEstimate === 'number')
            return { ...cost, usd: run.metrics.costEstimate, usdSource: 'recorded' as const };
          return cost;
        }),
      ...reviews.map((review) =>
        reviewCost(
          review.id,
          review.attempts?.length
            ? review.attempts.map((attempt) => attempt.usage)
            : [review.usage],
        ),
      ),
    ],
    acceptance: ledger
      ? {
          source: run.acceptanceRegistration ? 'registered' : 'derived',
          criteria: ledger.criteria.map((criterion) => ({
            id: criterion.id,
            text: criterion.text,
            verdict: criterion.verdict,
          })),
        }
      : { source: 'none', criteria: [] },
    reviewRounds: reviews.flatMap((review) =>
      (review.attempts?.length ? review.attempts : [review]).map((attempt) => {
        const fix = fixRefs.find((ref) => ref.answersRound === attempt.loopNumber);
        const reviewer = contexts.find((context) => context.id === review.id);
        const archived = reviewer
          ? archiveRefs(reviewer.runnerSessionArchives, reviewer.runnerSessionArchive).find(
              (ref) => ref.round === attempt.loopNumber,
            )
          : undefined;
        return {
          round: attempt.loopNumber,
          contextId: review.id,
          // The archived session of this round, else the runner session it reported.
          sessionKey:
            archived?.sessionKey ?? attempt.session?.sessionId ?? review.reviewerSessionId ?? null,
          reviewer: { runner: review.runner ?? null, model: review.model ?? null },
          verdict: attempt.verdict,
          unresolvedCount: attempt.unresolvedCount,
          fix:
            fix && fixContext
              ? { contextId: fixContext.id, sessionKey: fix.sessionKey ?? null }
              : null,
        };
      }),
    ),
    gate: gateDecision
      ? {
          outcome: run.metrics.outcome ?? null,
          decision: gateDecision.resolvedAction ?? null,
          decidedAt: gateDecision.resolvedAt ?? null,
        }
      : null,
    attempts: allAttempts,
    infraOnly:
      ended &&
      !run.metrics.outcome &&
      allAttempts.some((attempt) => attempt.kind === 'infra-failure'),
    output: run.gradedOutput ?? null,
    git: {
      startRef: run.startRef?.resolvedSha ?? run.startRef?.requestedRef ?? null,
      dispatchHead: run.worktreeHeadAtDispatch ?? null,
      finalHead: run.finalHead ?? null,
      prHead: run.prHead ?? null,
      mergeSha: run.mergeSha ?? null,
    },
  };
}
