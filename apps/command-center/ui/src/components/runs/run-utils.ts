// Shared utilities for run components — status colors, duration formatting, flow labels
import type {
  FamilyChangeLedgerEntry,
  FamilyObservabilityArtifact,
  FlowType,
  Run,
  RunFamilyReadinessSummary,
  RunProjectAnalyticsSummary,
  RunSelfLearningEligibilityState,
  RunStatus,
  RunStepStatus,
  WorkerTerminalDisposition,
} from '@farmslot/protocol';
import { buildFamilySummary, githubPullUrl, parseGitHubRef } from '@farmslot/protocol';
import { flowColor as _flowColor, flowLabel as _flowLabel } from '@farmslot/theme';

import { colors } from '../../styles/theme-tokens.js';

export interface RunFamilyGroup {
  familyId: string;
  familyRootTicketOrPr: string;
  rootRun: Run | null;
  // Run that drives header linkage (PR/Jira/branch). Falls back to the newest
  // run when no production root exists (comparison-only families).
  representativeRun: Run;
  // Deterministic family-level summary, computed via the shared protocol helper
  // so `#runs` family-group headers and the family deep-dive snapshot agree.
  familySummary: string;
  runs: Run[];
  latestCreatedAt: string;
  activeCount: number;
  comparisonCount: number;
  variants: string[];
}

export function formatCompletionPercent(percent: number): string {
  if (!Number.isFinite(percent)) return '0%';
  return `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}

export function familyCompletionLabel(
  summary: Pick<RunFamilyReadinessSummary, 'completionState' | 'completionPercent'>,
): string {
  return `${summary.completionState} ${formatCompletionPercent(summary.completionPercent)}`;
}

export function familyCompletionColor(state: RunFamilyReadinessSummary['completionState']): string {
  switch (state) {
    case 'complete':
      return colors.statusOk;
    case 'active':
      return '#3b82f6';
    case 'mixed':
      return colors.statusWarn;
    case 'failed':
      return colors.statusFail;
    default:
      return colors.textMuted;
  }
}

export function eligibilityLabel(state: RunSelfLearningEligibilityState): string {
  switch (state) {
    case 'eligible':
      return 'learning eligible';
    case 'blocked':
      return 'learning blocked';
    case 'unknown':
      return 'learning unknown';
    default:
      return 'learning unknown';
  }
}

export function eligibilityColor(state: RunSelfLearningEligibilityState): string {
  switch (state) {
    case 'eligible':
      return colors.statusOk;
    case 'blocked':
      return colors.statusFail;
    case 'unknown':
      return colors.statusWarn;
    default:
      return colors.textMuted;
  }
}

export function summarizeEligibilityReasons(summary: RunFamilyReadinessSummary): string {
  const reasons = [...summary.eligibility.reasons, ...summary.eligibility.missingSignals];
  return reasons.length ? reasons.join(', ') : 'ready';
}

export function sortProjectAnalyticsForDisplay(
  projects: RunProjectAnalyticsSummary[],
): RunProjectAnalyticsSummary[] {
  return [...projects].sort(
    (a, b) => b.latestRunAt.localeCompare(a.latestRunAt) || a.project.localeCompare(b.project),
  );
}

export function stepStatusIcon(status: RunStepStatus): string {
  switch (status) {
    case 'done':
      return 'v';
    case 'running':
      return '*';
    case 'failed':
      return 'x';
    case 'skipped':
      return '-';
    case 'pending':
      return '.';
    default:
      return '?';
  }
}

export function effectiveStepStatus(
  stepStatus: RunStepStatus,
  runStatus: RunStatus | string,
): RunStepStatus {
  if (runStatus === 'cancelled' && (stepStatus === 'running' || stepStatus === 'pending')) {
    return 'skipped';
  }
  return stepStatus;
}

export function stepStatusColor(status: RunStepStatus): string {
  switch (status) {
    case 'done':
      return colors.statusOk;
    case 'running':
      return '#3b82f6';
    case 'failed':
      return colors.statusFail;
    case 'skipped':
      return colors.textMuted;
    case 'pending':
      return colors.textMuted;
    default:
      return colors.textMuted;
  }
}

export function runStatusColor(status: RunStatus | string): string {
  switch (status) {
    case 'created':
      return colors.textMuted;
    case 'grading':
    case 'writing-task':
    case 'slot-finding':
    case 'preparing':
    case 'dispatching':
      return '#3b82f6';
    case 'monitoring':
    case 'self-reviewing':
      return '#818cf8';
    case 'completing':
    case 'ci-watching':
    case 'human-gating':
      return '#a78bfa';
    case 'done':
      return colors.statusOk;
    case 'failed':
      return colors.statusFail;
    case 'cancelled':
      return colors.statusWarn;
    case 'blocked':
    case 'paused':
      return colors.statusWarn;
    default:
      return colors.textMuted;
  }
}

export function dispositionLabel(
  disposition: WorkerTerminalDisposition | null | undefined,
): string {
  switch (disposition) {
    case 'already_fixed':
      return 'already fixed';
    case 'not_reproducible':
      return 'not reproducible';
    case 'fixed':
      return 'fixed';
    case 'blocked':
      return 'blocked disposition';
    case 'failed':
      return 'failed disposition';
    default:
      return '';
  }
}

export function dispositionColor(
  disposition: WorkerTerminalDisposition | null | undefined,
): string {
  switch (disposition) {
    case 'already_fixed':
    case 'not_reproducible':
      return colors.statusOk;
    case 'blocked':
      return colors.statusWarn;
    case 'failed':
      return colors.statusFail;
    default:
      return colors.textMuted;
  }
}

export function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function formatElapsed(startedAt?: string): string {
  if (!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function flowLabel(flow: FlowType): string {
  return _flowLabel(flow);
}

type EvalRunDisplayInput = Pick<Run, 'flowType' | 'lane' | 'ticketOrPr'> &
  Partial<Pick<Run, 'completionPolicy' | 'engineState' | 'mode'>>;

export function isEvalCandidateRun(
  run: Pick<Run, 'lane' | 'ticketOrPr'> & Partial<Pick<Run, 'completionPolicy' | 'engineState'>>,
): boolean {
  return (
    Boolean(run.engineState?.evalExperiment) ||
    (run.lane === 'comparison' && /^EVAL-/i.test(run.ticketOrPr))
  );
}

export function runDisplayLabel(run: EvalRunDisplayInput): string {
  if (isEvalCandidateRun(run)) return 'EVAL';
  return flowLabel(run.flowType);
}

export function runModeLabel(run: Partial<Pick<Run, 'flowType' | 'mode'>>): string | null {
  if (run.flowType === 'dev' && run.mode) return run.mode;
  return null;
}

export function runDisplayColor(run: EvalRunDisplayInput): string {
  return isEvalCandidateRun(run) ? colors.accent : flowColor(run.flowType);
}

export function runDisplayTitle(run: EvalRunDisplayInput): string {
  if (isEvalCandidateRun(run)) return 'Eval Candidate · dev carrier · artifact-only';
  if (run.flowType === 'dev' && run.mode) return `${run.flowType} · ${run.mode}`;
  return run.flowType;
}

export function flowColor(flow: FlowType): string {
  return _flowColor(flow);
}

export function familyLedgerTurnLabel(entry: FamilyChangeLedgerEntry): string {
  if (entry.flowType === 'review-pr') {
    if (entry.inputDiff?.available) return 'Reviewed PR input';
    if (entry.inputDiff) return 'Missing reviewed input';
    return 'Review turn';
  }
  if (entry.flowType === 'pr-complete')
    return entry.contributionDiff.available ? 'Follow-up code delta' : 'No code change';
  if (entry.contributionDiff.available) return 'Produced code delta';
  if (entry.changeKind === 'legacy') return 'Legacy diff';
  return 'No code change';
}

const PR_RECOMMENDATION_LABEL: Record<string, string> = {
  WORKING: 'In progress',
  NEEDS_ATTENTION: 'Needs attention',
  IN_REVIEW: 'In review',
  READY: 'Ready to merge',
  READY_TO_MERGE: 'Ready to merge',
  WAITING_FOR_MERGE: 'Waiting to merge',
  MERGED: 'Merged',
  CLOSED_WITHOUT_MERGE: 'Closed',
};

/**
 * Humanize a raw PR recommendation enum for display outside the PR dashboard,
 * e.g. the ci-watch banner on run-detail. Unknown values fall through so a
 * new recommendation doesn't silently render as blank.
 */
export function prRecommendationLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  return PR_RECOMMENDATION_LABEL[raw] ?? raw;
}

export function isCIWatchWorkerFixActive(phase: unknown, fixInProgress: unknown): boolean {
  return fixInProgress === true && (phase === 'fixing' || phase === 'waiting_for_worker');
}

export function elapsed(createdAt: string, completedAt?: string): string {
  const start = new Date(createdAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${date} ${time}`;
}

export function canCompareRuns(a: Run, b: Run): boolean {
  return a.familyId === b.familyId;
}

export function collectRunEvidenceArtifacts(run: Run): FamilyObservabilityArtifact[] {
  const seen = new Set<string>();
  const artifacts: FamilyObservabilityArtifact[] = [];

  for (const step of run.steps) {
    const rawArtifacts = step.outputs?.artifacts;
    if (!Array.isArray(rawArtifacts)) continue;

    for (const raw of rawArtifacts) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as {
        path?: unknown;
        purpose?: unknown;
        sizeBytes?: unknown;
        sha256?: unknown;
        maxFps?: unknown;
      };
      if (typeof row.path !== 'string' || !row.path.trim()) continue;
      const key = `${step.name}:${row.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push({
        runId: run.id,
        familyId: run.familyId,
        stepName: step.name,
        path: row.path,
        purpose:
          typeof row.purpose === 'string' && row.purpose.trim()
            ? row.purpose
            : purposeForArtifactPath(row.path),
        sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : undefined,
        sha256: typeof row.sha256 === 'string' ? row.sha256 : undefined,
        maxFps:
          typeof row.maxFps === 'number' && Number.isFinite(row.maxFps) ? row.maxFps : undefined,
        source: 'step-output',
      });
    }
  }

  return artifacts;
}

function purposeForArtifactPath(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? path.toLowerCase();
  if (/\.(mp4|mov|webm)$/.test(name))
    return name.includes('before') ? 'video-before' : 'video-after';
  if (/\.(png|jpg|jpeg|gif)$/.test(name))
    return name.includes('before') ? 'screenshot-before' : 'screenshot-after';
  if (name === 'report.md' || name.includes('report')) return 'report';
  if (name === 'recipe.json' || name.includes('recipe')) return 'recipe';
  if (name.includes('manifest')) return 'manifest';
  if (name.includes('log')) return 'log';
  return 'other';
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

export function routeForRun(run: Pick<Run, 'id' | 'familyId' | 'status'>): string {
  return isTerminalRunStatus(run.status)
    ? `family/${run.familyId}?run=${encodeURIComponent(run.id)}`
    : `run/${run.id}`;
}

export interface GitHubPrLink {
  label: string;
  url: string;
  ref: string;
}

export function prLinkForRun(
  run: Pick<Run, 'flowType' | 'ticketOrPr' | 'ticketData' | 'links'>,
): GitHubPrLink | null {
  if (run.flowType !== 'review-pr') return null;

  const existingPrLink = run.links?.find(
    (link) => /^pr$/i.test(link.label) && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(link.url),
  );
  if (existingPrLink) {
    const match = existingPrLink.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    const ref = match ? `${match[1]}#${match[2]}` : existingPrLink.url;
    return { label: 'PR', url: existingPrLink.url, ref };
  }

  const parsed = parseGitHubRef(run.ticketOrPr) ?? parseGitHubRef(run.ticketData?.githubIssue);
  if (!parsed) return null;
  return {
    label: 'PR',
    url: githubPullUrl(parsed),
    ref: `${parsed.repo}#${parsed.number}`,
  };
}

function sortByCreatedAtDesc(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function isFamilyRoot(run: Run): boolean {
  return run.id === run.familyId || run.parentRunId == null;
}

export function sortRunsForFamilyView(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => {
    if (isFamilyRoot(a) !== isFamilyRoot(b)) return isFamilyRoot(a) ? -1 : 1;
    if ((a.variant ?? null) !== (b.variant ?? null)) {
      return (a.variant ?? '').localeCompare(b.variant ?? '');
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function pickFamilyComparePair(runs: Run[]): [Run, Run] | null {
  const comparisonRuns = sortByCreatedAtDesc(runs.filter((run) => run.lane === 'comparison'));
  if (comparisonRuns.length < 2) return null;

  const newest = comparisonRuns[0];
  const distinctVariantPeer = comparisonRuns.find(
    (run) => run.id !== newest.id && (run.variant ?? null) !== (newest.variant ?? null),
  );

  return distinctVariantPeer
    ? [newest, distinctVariantPeer]
    : [comparisonRuns[0], comparisonRuns[1]];
}

export function pickComparisonPartner(currentRun: Run, runs: Run[]): Run | null {
  if (currentRun.lane !== 'comparison') return null;
  const familyPair = pickFamilyComparePair([currentRun, ...runs]);
  if (!familyPair) return null;
  if (familyPair[0].id === currentRun.id) return familyPair[1];
  if (familyPair[1].id === currentRun.id) return familyPair[0];
  const fallback = sortByCreatedAtDesc(
    runs.filter(
      (run) =>
        run.id !== currentRun.id &&
        run.lane === 'comparison' &&
        run.familyId === currentRun.familyId,
    ),
  )[0];
  return fallback ?? null;
}

export function isSameFamilyComparisonPair(a: Run, b: Run): boolean {
  if (a.familyId !== b.familyId) return false;
  return a.lane === 'comparison' && b.lane === 'comparison';
}

export function groupRunsByFamily(runs: readonly Run[]): RunFamilyGroup[] {
  const grouped = new Map<string, Run[]>();
  for (const run of runs) {
    const familyId = run.familyId || run.id;
    const current = grouped.get(familyId);
    if (current) current.push(run);
    else grouped.set(familyId, [run]);
  }

  return [...grouped.entries()]
    .map(([familyId, familyRuns]) => {
      const orderedRuns = sortRunsForFamilyView(familyRuns);
      const rootRun = orderedRuns.find(isFamilyRoot) ?? null;
      // sortRunsForFamilyView keeps the family root first; for the
      // representative-run / family-summary computations we want the genuinely
      // newest run, which is sortByCreatedAtDesc[0].
      const newestByCreatedAt = sortByCreatedAtDesc(orderedRuns)[0];
      const representativeRun = rootRun ?? newestByCreatedAt;
      const latestCreatedAt = orderedRuns.reduce(
        (latest, run) => (run.createdAt > latest ? run.createdAt : latest),
        orderedRuns[0]?.createdAt ?? '',
      );
      const variants = [
        ...new Set(
          orderedRuns
            .map((run) => run.variant)
            .filter((variant): variant is string => Boolean(variant)),
        ),
      ];
      return {
        familyId,
        familyRootTicketOrPr:
          rootRun?.familyRootTicketOrPr ?? orderedRuns[0]?.familyRootTicketOrPr ?? familyId,
        rootRun,
        representativeRun,
        familySummary: buildFamilySummary(rootRun, newestByCreatedAt, orderedRuns),
        runs: orderedRuns,
        latestCreatedAt,
        activeCount: orderedRuns.filter(
          (run) => !['done', 'failed', 'cancelled'].includes(run.status),
        ).length,
        comparisonCount: orderedRuns.filter((run) => run.lane === 'comparison').length,
        variants,
      };
    })
    .sort((a, b) => b.latestCreatedAt.localeCompare(a.latestCreatedAt));
}

export const GRADE_COLORS: Record<string, string> = {
  low: colors.statusOk,
  medium: colors.statusWarn,
  high: '#f97316',
  extreme: colors.statusFail,
};
