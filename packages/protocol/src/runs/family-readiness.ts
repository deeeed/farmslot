import {
  hasLiveRecipeEvidence,
  type Run,
  RUN_SELF_LEARNING_MISSING_SIGNALS,
  type RunDecisionPayload,
  type RunFamilyCompletionState,
  type RunFamilyReadinessSummary,
  type RunProjectAnalyticsSummary,
  type RunSelfLearningBlockReason,
  type RunSelfLearningEligibility,
} from '../contracts/index.js';
import type { RunListResult } from '../rpc/index.js';

const TERMINAL_STATUSES = new Set<Run['status']>(['done', 'failed', 'cancelled']);

function isTerminalRun(run: Run): boolean {
  return TERMINAL_STATUSES.has(run.status);
}

function isSuccessfulRun(run: Run): boolean {
  return run.status === 'done' && run.metrics.outcome !== 'failure';
}

function hasPendingDecision(run: Run): boolean {
  return (run.decisions ?? []).some((decision) => !decision.resolvedAt);
}

function latestRun(runs: Run[]): Run {
  if (runs.length === 0) throw new Error('Cannot summarize an empty run family');
  return runs.reduce((latest, run) => {
    const latestTime = latest.updatedAt || latest.createdAt;
    const runTime = run.updatedAt || run.createdAt;
    return runTime > latestTime ? run : latest;
  }, runs[0]);
}

function completionState(
  runCount: number,
  activeCount: number,
  failedCount: number,
): RunFamilyCompletionState {
  if (activeCount > 0 && failedCount > 0) return 'mixed';
  if (activeCount > 0) return 'active';
  if (failedCount === runCount) return 'failed';
  if (failedCount > 0) return 'mixed';
  return 'complete';
}

function hasPayloadWorkerLearnings(payload: RunDecisionPayload | undefined): boolean {
  return Boolean(
    payload &&
    'workerLearnings' in payload &&
    typeof payload.workerLearnings === 'string' &&
    payload.workerLearnings.trim(),
  );
}

function hasPayloadRecipe(payload: RunDecisionPayload | undefined): boolean {
  return (
    Boolean(
      payload &&
      'recipeJson' in payload &&
      typeof payload.recipeJson === 'string' &&
      payload.recipeJson.trim(),
    ) || Boolean(payload && 'recipeQualityArtifact' in payload && payload.recipeQualityArtifact)
  );
}

function hasPayloadEvidence(payload: RunDecisionPayload | undefined): boolean {
  return (
    Boolean(
      payload &&
      'artifactManifest' in payload &&
      Array.isArray(payload.artifactManifest) &&
      payload.artifactManifest.length > 0,
    ) ||
    Boolean(
      payload &&
      'evidenceMarkdown' in payload &&
      typeof payload.evidenceMarkdown === 'string' &&
      payload.evidenceMarkdown.trim(),
    ) ||
    Boolean(payload && 'qualityReport' in payload && payload.qualityReport)
  );
}

function hasPayloadDiff(payload: RunDecisionPayload | undefined): boolean {
  return Boolean(
    payload && 'diffStat' in payload && payload.diffStat && payload.diffStat.files > 0,
  );
}

function eligibilityForFamily(runs: Run[]): RunSelfLearningEligibility {
  const reasons: RunSelfLearningBlockReason[] = [];
  if (runs.some((run) => !isTerminalRun(run))) reasons.push('active-runs');
  if (runs.some(hasPendingDecision)) reasons.push('pending-decisions');
  if (!runs.some(isSuccessfulRun)) reasons.push('no-successful-run');

  if (reasons.length > 0) {
    return { state: 'blocked', reasons, missingSignals: [] };
  }

  // Self-learning signals must come from a SUCCESSFUL run — a failed sibling
  // carrying recipeJson or evidence is not training material. Restrict the
  // signal scan to successful runs (the eligibility guard above already
  // ensures at least one exists).
  const successfulRuns = runs.filter(isSuccessfulRun);
  const payloads = successfulRuns.flatMap((run) =>
    (run.decisions ?? []).map((decision) => decision.payload),
  );
  const hasEvidence =
    successfulRuns.some(
      (run) => run.liveRecipeContext && hasLiveRecipeEvidence(run.liveRecipeContext),
    ) || payloads.some(hasPayloadEvidence);
  const hasLearnings =
    successfulRuns.some((run) => Boolean(run.liveRecipeContext?.workerLearnings?.trim())) ||
    payloads.some(hasPayloadWorkerLearnings);
  const hasRecipe =
    successfulRuns.some((run) =>
      Boolean(
        run.liveRecipeContext?.recipeJson?.trim() || run.liveRecipeContext?.recipeQualityArtifact,
      ),
    ) || payloads.some(hasPayloadRecipe);
  const hasDiff = payloads.some(hasPayloadDiff);

  const missingSignals = RUN_SELF_LEARNING_MISSING_SIGNALS.filter((signal) => {
    switch (signal) {
      case 'missing-evidence-signal':
        return !hasEvidence;
      case 'missing-learnings-signal':
        return !hasLearnings;
      case 'missing-recipe-signal':
        return !hasRecipe;
      case 'missing-diff-signal':
        return !hasDiff;
      default: {
        // Compile-time exhaustiveness: if a 5th signal is added to the protocol
        // without updating this switch, TS rejects the assignment below.
        const _exhaustive: never = signal;
        void _exhaustive;
        return false;
      }
    }
  });

  return {
    state: missingSignals.length === 0 ? 'eligible' : 'unknown',
    reasons: [],
    missingSignals,
  };
}

export function buildRunFamilyReadinessSummaries(runs: Run[]): RunFamilyReadinessSummary[] {
  const grouped = new Map<string, Run[]>();
  for (const run of runs) {
    const familyId = run.familyId || run.id;
    const current = grouped.get(familyId);
    if (current) current.push(run);
    else grouped.set(familyId, [run]);
  }

  return [...grouped.entries()]
    .map(([familyId, familyRuns]) => {
      const latest = latestRun(familyRuns);
      const terminalRunCount = familyRuns.filter(isTerminalRun).length;
      const activeRunCount = familyRuns.length - terminalRunCount;
      const failedRunCount = familyRuns.filter(
        (run) => run.status === 'failed' || run.status === 'cancelled',
      ).length;
      const root =
        familyRuns.find((run) => run.id === familyId || run.parentRunId == null) ?? familyRuns[0];
      return {
        familyId,
        familyRootTicketOrPr: root.familyRootTicketOrPr ?? root.ticketOrPr ?? familyId,
        project: root.project,
        latestRunId: latest.id,
        latestRunAt: latest.updatedAt || latest.createdAt,
        runCount: familyRuns.length,
        terminalRunCount,
        activeRunCount,
        failedRunCount,
        completionPercent:
          familyRuns.length === 0 ? 0 : Math.round((terminalRunCount / familyRuns.length) * 100),
        completionState: completionState(familyRuns.length, activeRunCount, failedRunCount),
        eligibility: eligibilityForFamily(familyRuns),
      } satisfies RunFamilyReadinessSummary;
    })
    .sort((a, b) => b.latestRunAt.localeCompare(a.latestRunAt));
}

export function buildRunProjectAnalyticsSummaries(
  familySummaries: RunFamilyReadinessSummary[],
): RunProjectAnalyticsSummary[] {
  const byProject = new Map<string, RunFamilyReadinessSummary[]>();
  for (const summary of familySummaries) {
    const current = byProject.get(summary.project);
    if (current) current.push(summary);
    else byProject.set(summary.project, [summary]);
  }

  return [...byProject.entries()]
    .map(([project, summaries]) => ({
      project,
      familyCount: summaries.length,
      runCount: summaries.reduce((count, summary) => count + summary.runCount, 0),
      activeFamilyCount: summaries.filter((summary) => summary.activeRunCount > 0).length,
      completedFamilyCount: summaries.filter((summary) => summary.completionState === 'complete')
        .length,
      eligibleFamilyCount: summaries.filter((summary) => summary.eligibility.state === 'eligible')
        .length,
      blockedFamilyCount: summaries.filter((summary) => summary.eligibility.state === 'blocked')
        .length,
      unknownFamilyCount: summaries.filter((summary) => summary.eligibility.state === 'unknown')
        .length,
      latestRunAt: summaries.reduce(
        (latest, summary) => (summary.latestRunAt > latest ? summary.latestRunAt : latest),
        '',
      ),
    }))
    .sort(
      (a, b) => b.latestRunAt.localeCompare(a.latestRunAt) || a.project.localeCompare(b.project),
    );
}

/**
 * Deterministic family summary used by both the `#runs` family-group header and
 * the family deep-dive snapshot. Pure, no I/O — safe to call client-side per group.
 *
 * Rule:
 * - No rootRun (e.g. comparison-only family): return the latest run's summary.
 * - Single-run family or root.summary equals latest.summary → return that summary.
 * - Otherwise → "<root summary> · latest follow-up: <latest summary>".
 * - Fallbacks: `Run.summary` → `familyRootTicketOrPr` → `ticketOrPr` → "<n> runs in family <id>".
 *
 * Trade-off vs the previous gateway-only synthesis: the gateway previously
 * preferred `runSummaries[i].summary`, which `buildRunSummary` derives as
 * `run.summary ?? workerReport?.trim().split('\n')[0] ?? null`. This shared
 * helper takes `Run` directly and uses `Run.summary` only — no on-disk
 * worker-report fallback. The deep-dive snapshot therefore renders the ticket
 * id (instead of a worker-report first line) on runs whose `Run.summary` is
 * null. Acceptable because (a) the per-run cards already render `Run.summary`
 * with the same fallback semantics, so all three surfaces now agree, and
 * (b) the worker-report side-channel is recoverable on the deep-dive page
 * via the runs list and the LLM `family.report.generate` button.
 */
export function buildFamilySummary(
  rootRun: Run | null,
  latestRun: Run | null,
  runs: Run[],
): string {
  if (runs.length === 0) return '';
  const reference = latestRun ?? rootRun ?? runs[0];
  const fallback = (
    reference.familyRootTicketOrPr ||
    reference.ticketOrPr ||
    reference.familyId
  ).trim();
  const latestSummary = (latestRun?.summary ?? rootRun?.summary ?? '').trim() || fallback;
  // Comparison-only families have no production root: surface the newest variant's
  // summary so the header reflects what the operator most recently produced.
  if (!rootRun) return latestSummary;
  const rootSummary = (rootRun.summary ?? '').trim() || fallback;
  if (runs.length === 1 || rootSummary === latestSummary) {
    return rootSummary || `${runs.length} runs in family ${fallback}`;
  }
  return `${rootSummary} · latest follow-up: ${latestSummary}`;
}

export function attachRunListSummaries(
  result: Pick<RunListResult, 'runs' | 'totalCount'>,
  options: { includeFamilySummaries?: boolean; includeProjectAnalytics?: boolean },
): RunListResult {
  if (!options.includeFamilySummaries && !options.includeProjectAnalytics) return result;

  const familySummaries = buildRunFamilyReadinessSummaries(result.runs);
  return {
    ...result,
    summaryMeta: {
      scope: 'returned-runs',
      summaryRunCount: result.runs.length,
      totalCount: result.totalCount,
      isTruncated: result.runs.length < result.totalCount,
    },
    ...(options.includeFamilySummaries ? { familySummaries } : {}),
    ...(options.includeProjectAnalytics
      ? { projectAnalytics: buildRunProjectAnalyticsSummaries(familySummaries) }
      : {}),
  };
}
