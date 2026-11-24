// ADR-039 Amendment 10: an episode's label values, read from run-record fields only.
import {
  type AcceptanceStatusLedger,
  primaryRoleForFlow,
  type Run,
  type RunAttemptLogEntry,
  type RunnerSessionArchiveRef,
  type RunnerSessionUsage,
} from '@farmslot/protocol';

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
  attempts: (RunAttemptLogEntry & { kind: RunAttemptLogEntry['kind'] })[];
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

const archiveRefs = (
  list: RunnerSessionArchiveRef[] | undefined,
  single: RunnerSessionArchiveRef | undefined,
): RunnerSessionArchiveRef[] => (list?.length ? list : single ? [single] : []);

function sessions(refs: RunnerSessionArchiveRef[]): TraceSessionLabel[] {
  return refs.map((ref) => ({
    sessionKey: ref.sessionKey ?? null,
    status: ref.status,
    ...(ref.answersRound !== undefined ? { answersRound: ref.answersRound } : {}),
  }));
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
        usageCost(review.id, 'review', review.attempts?.at(-1)?.usage ?? review.usage),
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
        return {
          round: attempt.loopNumber,
          contextId: review.id,
          sessionKey: attempt.session?.sessionId ?? review.reviewerSessionId ?? null,
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
