// change-ledger.ts — Family change ledger diff, review-signal, and footprint projection

import path from 'node:path';

import {
  type FamilyArtifactBucketSummary,
  type FamilyArtifactFootprint,
  type FamilyChangeLedger,
  type FamilyChangeLedgerEntry,
  type FamilyDiffProvenance,
  type FamilyInputCommitMetadata,
  type FamilyObservabilityArtifact,
  type FamilyObservabilityRunSummary,
  isFamilyDiffProvenance,
  type Run,
} from '@farmslot/protocol';

import { diffKindForFlow } from '../core/diff-kind.js';
import { readCommentsTriageSummary } from '../run-completion/orchestrator.js';

import { dedupeArtifacts } from './artifacts.js';
import { readJsonIfExists, statIfPresent } from './io.js';

const TASK_INPUT_LEDGER_PURPOSES = new Set([
  'input-commit',
  'input-diff',
  'input-diff-stat',
  'ticket-data',
]);

function artifactExtension(artifactPath: string): string {
  const ext = path.extname(artifactPath).toLowerCase();
  return ext || '(none)';
}

function bucketArtifacts(
  artifacts: FamilyObservabilityArtifact[],
  keyFor: (artifact: FamilyObservabilityArtifact) => string,
): FamilyArtifactBucketSummary[] {
  const buckets = new Map<string, { count: number; bytes: number }>();
  for (const artifact of artifacts) {
    const key = keyFor(artifact);
    const current = buckets.get(key) ?? { count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += artifact.sizeBytes ?? 0;
    buckets.set(key, current);
  }
  return [...buckets.entries()]
    .map(([key, value]) => ({ key, count: value.count, bytes: value.bytes }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count || a.key.localeCompare(b.key));
}

export function buildArtifactFootprint(
  artifacts: FamilyObservabilityArtifact[],
): FamilyArtifactFootprint {
  return {
    count: artifacts.length,
    bytes: artifacts.reduce((total, artifact) => total + (artifact.sizeBytes ?? 0), 0),
    byPurpose: bucketArtifacts(artifacts, (artifact) => artifact.purpose || 'unknown'),
    bySource: bucketArtifacts(artifacts, (artifact) => artifact.source),
    byExtension: bucketArtifacts(artifacts, (artifact) => artifactExtension(artifact.path)),
  };
}

function mergeArtifactFootprints(
  runSummaries: FamilyObservabilityRunSummary[],
): FamilyArtifactFootprint {
  return buildArtifactFootprint(
    dedupeArtifacts(runSummaries.flatMap((summary) => summary.artifacts)),
  );
}

export function isExpectedNoSourceDiff(diff: FamilyDiffProvenance): boolean {
  return diff.missingReason === 'no-source-diff';
}

function expectsReviewInputArtifacts(flowType: Run['flowType']): boolean {
  return flowType === 'review-pr';
}

export function isExpectedAbsentContributionDiff(
  flowType: Run['flowType'],
  diff: FamilyDiffProvenance,
): boolean {
  return flowType === 'review-pr' && diff.missingReason === 'missing-diff-stat-artifact';
}

export function isPrReviewDiffAuthoritative(
  flowType: Run['flowType'],
  inputDiff: FamilyDiffProvenance | undefined,
  parentRunId?: string | null,
): boolean {
  // Follow-up pr-complete runs should surface iteration/contribution delta, not
  // the full GitHub PR input diff on every round.
  if (flowType === 'pr-complete' && parentRunId) return false;
  return Boolean(inputDiff?.available && (flowType === 'pr-complete' || flowType === 'review-pr'));
}

export async function readDiffProvenance(
  taskDir: string | null,
  completeOutputs: Record<string, unknown>,
  flowType?: Run['flowType'],
): Promise<FamilyDiffProvenance> {
  const missingKind = diffKindForFlow(flowType);
  if (taskDir) {
    const raw = await readJsonIfExists<unknown>(path.join(taskDir, 'artifacts', 'diff-stat.json'));
    if (isFamilyDiffProvenance(raw)) {
      // Slot-tree artifacts/diff-stat.json on review-pr runs describes the
      // reviewed HEAD; do not double-count it as contribution.
      if (raw.kind === 'review-input') {
        return {
          source: 'unavailable',
          available: false,
          files: 0,
          additions: 0,
          deletions: 0,
          kind: missingKind,
          missingReason: 'missing-diff-stat-artifact',
        };
      }
      return raw;
    }
    if (await statIfPresent(path.join(taskDir, 'artifacts', 'diff-stat.json'))) {
      return {
        source: 'unavailable',
        available: false,
        files: 0,
        additions: 0,
        deletions: 0,
        kind: missingKind,
        missingReason: 'malformed-diff-stat-artifact',
      };
    }
  }
  const diffStatRaw =
    completeOutputs.diffStat && typeof completeOutputs.diffStat === 'object'
      ? (completeOutputs.diffStat as Record<string, unknown>)
      : null;
  if (diffStatRaw) {
    return {
      source: 'legacy-step-output',
      available: true,
      files: typeof diffStatRaw.files === 'number' ? diffStatRaw.files : 0,
      additions: typeof diffStatRaw.additions === 'number' ? diffStatRaw.additions : 0,
      deletions: typeof diffStatRaw.deletions === 'number' ? diffStatRaw.deletions : 0,
      kind: 'legacy',
    };
  }
  return {
    source: 'unavailable',
    available: false,
    files: 0,
    additions: 0,
    deletions: 0,
    kind: missingKind,
    missingReason: 'missing-diff-stat-artifact',
  };
}

export async function readInputDiffProvenance(
  taskDir: string | null,
): Promise<FamilyDiffProvenance | undefined> {
  if (!taskDir) return undefined;
  const raw = await readJsonIfExists<unknown>(path.join(taskDir, 'inputs', 'diff-stat.json'));
  if (isFamilyDiffProvenance(raw)) return raw;
  if (await statIfPresent(path.join(taskDir, 'inputs', 'diff-stat.json'))) {
    return {
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'review-input',
      missingReason: 'malformed-input-diff-stat',
    };
  }
  if (await statIfPresent(path.join(taskDir, 'inputs', 'diff.txt'))) {
    return {
      source: 'artifact',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'review-input',
      artifactPath: 'inputs/diff.txt',
      missingReason: 'missing-input-diff-stat',
    };
  }
  return undefined;
}

export async function readInputCommit(
  taskDir: string | null,
): Promise<FamilyInputCommitMetadata | undefined> {
  if (!taskDir) return undefined;
  const raw = await readJsonIfExists<FamilyInputCommitMetadata>(
    path.join(taskDir, 'inputs', 'commit.json'),
  );
  return raw ?? undefined;
}

export async function readIterationDiffProvenance(
  taskDir: string | null,
): Promise<FamilyDiffProvenance | undefined> {
  if (!taskDir) return undefined;
  const raw = await readJsonIfExists<unknown>(
    path.join(taskDir, 'artifacts', 'iteration-diff-stat.json'),
  );
  if (isFamilyDiffProvenance(raw) && raw.kind === 'iteration') return raw;
  return undefined;
}

function ledgerContributionStat(entry: FamilyChangeLedgerEntry): FamilyDiffProvenance | undefined {
  if (entry.iterationDiff?.available) return entry.iterationDiff;
  if (entry.contributionDiff.available) return entry.contributionDiff;
  if (entry.contributionDiff.partialStat) return entry.contributionDiff;
  if (entry.legacyDiffFallback?.available) return entry.legacyDiffFallback;
  return undefined;
}

export async function buildFamilyChangeLedger(
  runs: Run[],
  runSummaries: FamilyObservabilityRunSummary[],
  familyRootTicketOrPr: string,
): Promise<FamilyChangeLedger> {
  const byRunId = new Map(runs.map((run) => [run.id, run]));
  const entries: FamilyChangeLedgerEntry[] = await Promise.all(
    runSummaries.map(async (summary): Promise<FamilyChangeLedgerEntry> => {
      const run = byRunId.get(summary.runId);
      const taskDir = run?.taskFile ? path.dirname(run.taskFile) : null;
      const completeOutputs = (run?.steps.find((step) => step.name === 'complete')?.outputs ??
        {}) as Record<string, unknown>;
      const contributionDiff = await readDiffProvenance(taskDir, completeOutputs, summary.flowType);
      const iterationDiff = await readIterationDiffProvenance(taskDir);
      const inputDiff = await readInputDiffProvenance(taskDir);
      const authoritativeInputDiff = isPrReviewDiffAuthoritative(
        summary.flowType,
        inputDiff,
        summary.parentRunId,
      );
      const inputCommit = await readInputCommit(taskDir);
      const reviewSignalsRaw = taskDir ? await readCommentsTriageSummary(taskDir) : null;
      const reviewSignals = reviewSignalsRaw
        ? {
            total: reviewSignalsRaw.total,
            real: reviewSignalsRaw.real,
            fixed: reviewSignalsRaw.fixed,
            botAddressed: reviewSignalsRaw.botAddressed ?? 0,
            humanReviewersRequestingChanges: reviewSignalsRaw.humanReviewersRequestingChanges ?? 0,
            humanCommentsAddressed: reviewSignalsRaw.humanCommentsAddressed ?? 0,
            unknownSource: reviewSignalsRaw.unknownSource ?? 0,
          }
        : undefined;
      const taskInputArtifacts = summary.artifacts.filter(
        (artifact) =>
          artifact.source === 'task-input' && TASK_INPUT_LEDGER_PURPOSES.has(artifact.purpose),
      );
      const artifactFootprint = buildArtifactFootprint(summary.artifacts);
      const missingData = new Set<string>();
      const expectsReviewInput = expectsReviewInputArtifacts(summary.flowType);
      if (
        !authoritativeInputDiff &&
        !isExpectedAbsentContributionDiff(summary.flowType, contributionDiff) &&
        !contributionDiff.available &&
        !isExpectedNoSourceDiff(contributionDiff)
      ) {
        missingData.add(contributionDiff.missingReason ?? 'diff-artifact');
      }
      if (contributionDiff.configFallbackReason || inputDiff?.configFallbackReason)
        missingData.add('project-config-fallback');
      if (!authoritativeInputDiff && contributionDiff.source === 'legacy-step-output')
        missingData.add('diff-artifact');
      if (expectsReviewInput && !inputDiff) missingData.add('input-diff');
      if (inputDiff && !inputDiff.available && !isExpectedNoSourceDiff(inputDiff)) {
        missingData.add(inputDiff.missingReason ?? 'input-diff-unavailable');
      }
      if (expectsReviewInput && !inputCommit) missingData.add('commit-metadata');
      if (reviewSignalsRaw?.unknownSource) missingData.add('review-source-classification');
      const hasEmptyReviewInput =
        summary.flowType === 'review-pr' && inputDiff != null && isExpectedNoSourceDiff(inputDiff);
      return {
        runId: summary.runId,
        familyId: summary.familyId,
        parentRunId: summary.parentRunId ?? null,
        familyRootTicketOrPr,
        lane: summary.lane,
        variant: summary.variant ?? null,
        flowType: summary.flowType,
        project: summary.project,
        ticketOrPr: summary.ticketOrPr,
        branch: summary.branch,
        prNumber: summary.prNumber,
        createdAt: summary.createdAt,
        completedAt: summary.completedAt,
        changeKind: authoritativeInputDiff
          ? 'review-input'
          : iterationDiff?.available || contributionDiff.available
            ? summary.parentRunId
              ? 'follow-up'
              : 'contribution'
            : hasEmptyReviewInput
              ? 'review-input'
              : inputDiff?.available
                ? 'review-input'
                : contributionDiff.source === 'legacy-step-output'
                  ? 'legacy'
                  : 'none',
        contributionDiff,
        ...(iterationDiff ? { iterationDiff } : {}),
        ...(inputDiff ? { inputDiff } : {}),
        ...(contributionDiff.source === 'legacy-step-output'
          ? { legacyDiffFallback: contributionDiff }
          : {}),
        ...(inputCommit ? { inputCommit } : {}),
        ...(reviewSignals ? { reviewSignals } : {}),
        artifactFootprint,
        taskInputArtifacts,
        missingData: [...missingData],
      };
    }),
  );
  const summary = entries.reduce(
    (acc, entry) => {
      const hasPartialContributionDiff =
        entry.contributionDiff.missingReason === 'diff-artifact-too-large' &&
        entry.contributionDiff.partialStat;
      if (
        entry.contributionDiff.available ||
        entry.iterationDiff?.available ||
        hasPartialContributionDiff ||
        entry.inputDiff?.available
      ) {
        acc.runsWithDiff += 1;
      } else if (!entry.inputDiff && entry.flowType !== 'review-pr') {
        acc.runsMissingDiff += 1;
      }
      const contributionDiffIsCanonical = !isPrReviewDiffAuthoritative(
        entry.flowType,
        entry.inputDiff,
        entry.parentRunId,
      );
      const contributionStat = ledgerContributionStat(entry);
      if (
        contributionDiffIsCanonical &&
        contributionStat &&
        (contributionStat.available || contributionStat.partialStat)
      ) {
        acc.runsWithContributionDiff += 1;
        const stat = contributionStat.available ? contributionStat : contributionStat.partialStat!;
        acc.totalContributionFiles += stat.files;
        acc.totalContributionAdditions += stat.additions;
        acc.totalContributionDeletions += stat.deletions;
      }
      if (entry.inputDiff?.available) acc.runsWithReviewInputDiff += 1;
      else if (entry.inputDiff && isExpectedNoSourceDiff(entry.inputDiff))
        acc.runsWithEmptyReviewInputDiff += 1;
      else if (entry.inputDiff) acc.runsWithUnavailableReviewInputDiff += 1;
      if (entry.reviewSignals) {
        acc.reviewRounds += 1;
        acc.bugbotFindingsAddressed += entry.reviewSignals.botAddressed;
        acc.humanReviewersRequestingChanges += entry.reviewSignals.humanReviewersRequestingChanges;
        acc.humanCommentsAddressed += entry.reviewSignals.humanCommentsAddressed;
      }
      return acc;
    },
    {
      runsWithDiff: 0,
      runsMissingDiff: 0,
      runsWithContributionDiff: 0,
      runsWithReviewInputDiff: 0,
      runsWithEmptyReviewInputDiff: 0,
      runsWithUnavailableReviewInputDiff: 0,
      totalContributionFiles: 0,
      totalContributionAdditions: 0,
      totalContributionDeletions: 0,
      reviewRounds: 0,
      bugbotFindingsAddressed: 0,
      humanReviewersRequestingChanges: 0,
      humanCommentsAddressed: 0,
    },
  );
  return {
    summary: { ...summary, artifactFootprint: mergeArtifactFootprints(runSummaries) },
    entries,
  };
}
