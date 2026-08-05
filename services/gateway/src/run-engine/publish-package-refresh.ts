// publish-package-refresh.ts — Ready-gate package refresh and evidence-selection preservation

import {
  type DecisionAction,
  Events,
  GATE_SUMMARY_KINDS,
  type IndependentReviewStatus,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import { getProjectField, loadProjectVars, loadSlotVars } from '../core/config.js';
import {
  effectiveRequiredReviewCount,
  independentReviewPolicySatisfied,
} from '../quality/review-policy.js';
import { evidenceKeyVariants } from '../run-completion/evidence-paths.js';
import {
  prepareCompletionPackage,
  publicationStatusForRun,
} from '../run-completion/orchestrator.js';
import { computeReadyGateReviewSubjectHash } from '../run-completion/ready-gate-package.js';
import { getRun, updateRun } from '../runs/store.js';

import {
  applyBranchFreshnessToReadyGatePayload,
  probeSlotBranchFreshness,
  resolveBranchUpdateStrategy,
} from './branch-freshness.js';
import {
  buildEvidenceRefreshAction,
  countStalePublicationReviews,
  reviewFinalSnapshotMatchesPreparedPackage,
  stampPublishGateReviewStatusForPackage,
} from './gate-policy.js';
import { buildGateSummary } from './gate-summary.js';
import { readyGateReviewSubjectMatches } from './post-dispatch-steps.js';
import { publicationReviewPolicyForRun } from './publication-policy.js';
import { getDiffStat } from './task-artifacts.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};

export function setPublishPackageRefreshBroadcast(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

export function summarizePublishPackageRefreshEvidence(
  oldPackage: Pick<ReadyGatePrPackage, 'evidenceManifest'> | undefined,
  refreshedPackage: Pick<ReadyGatePrPackage, 'evidenceManifest'>,
  selectedBefore: string[],
): {
  preservedEvidenceKeys: string[];
  droppedEvidence: { key: string; reason: string }[];
  droppedEvidenceKeys: string[];
  addedEvidenceKeys: string[];
} {
  const oldEvidence = oldPackage?.evidenceManifest ?? [];
  const newEvidence = refreshedPackage.evidenceManifest ?? [];
  const oldEvidenceVariants = new Set(oldEvidence.flatMap((a) => evidenceKeyVariants(a.path)));
  const newEvidenceVariants = new Set(newEvidence.flatMap((a) => evidenceKeyVariants(a.path)));
  const keyInNewEvidence = (key: string): boolean =>
    evidenceKeyVariants(key).some((variant) => newEvidenceVariants.has(variant));
  const pathInOldEvidence = (key: string): boolean =>
    evidenceKeyVariants(key).some((variant) => oldEvidenceVariants.has(variant));
  const canonicalNewEvidencePath = (key: string): string | null =>
    newEvidence.find((artifact) =>
      evidenceKeyVariants(key).some((variant) =>
        evidenceKeyVariants(artifact.path).includes(variant),
      ),
    )?.path ?? null;
  const preservedEvidenceKeys = [
    ...new Set(
      selectedBefore
        .map((key) => canonicalNewEvidencePath(key))
        .filter((key): key is string => typeof key === 'string'),
    ),
  ];
  const droppedEvidenceKeys = [...new Set(selectedBefore.filter((key) => !keyInNewEvidence(key)))];
  const droppedEvidence = droppedEvidenceKeys.map((key) => ({
    key,
    reason: 'missing from refreshed package evidence manifest',
  }));
  const addedEvidenceKeys = newEvidence.map((a) => a.path).filter((key) => !pathInOldEvidence(key));
  return { preservedEvidenceKeys, droppedEvidence, droppedEvidenceKeys, addedEvidenceKeys };
}

export function reviewDepthForPublishPackageRefresh(
  run: Run,
  projectConfig: Parameters<typeof publicationReviewPolicyForRun>[1],
  oldPayload: Pick<ReadyGatePayload, 'reviewDepth'>,
): ReadyGatePayload['reviewDepth'] {
  if (oldPayload.reviewDepth?.requestedBy !== 'human-gate') return oldPayload.reviewDepth;
  return publicationReviewPolicyForRun(run, projectConfig);
}

function reviewWasStampedForPackage(
  review: IndependentReviewStatus,
  reviewedPackage: ReadyGatePrPackage,
): boolean {
  const reviewedHeadSha = review.reviewedHeadSha ?? review.reviewSnapshot?.headSha ?? null;
  if (!reviewedHeadSha || reviewedHeadSha !== reviewedPackage.headSha) return false;
  const subjectStamps = new Set(
    [reviewedPackage.reviewSubjectHash, computeReadyGateReviewSubjectHash(reviewedPackage)].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
  if (review.reviewedReviewSubjectHash && subjectStamps.has(review.reviewedReviewSubjectHash)) {
    return true;
  }
  return (
    !!review.reviewedPackageInputHash &&
    !!reviewedPackage.packageInputHash &&
    review.reviewedPackageInputHash === reviewedPackage.packageInputHash
  );
}

function restampReviewsForRefreshedPackage(
  independentReviews: IndependentReviewStatus[],
  reviewedPackages: Array<ReadyGatePrPackage | undefined>,
  refreshedPackage: ReadyGatePrPackage,
): IndependentReviewStatus[] {
  return independentReviews.map((review) => {
    if (!reviewFinalSnapshotMatchesPreparedPackage(review, refreshedPackage)) return review;
    const canRestamp =
      review.source === 'dispatch' ||
      review.source === 'human-gate' ||
      reviewedPackages.some(
        (reviewedPackage) =>
          reviewedPackage &&
          readyGateReviewSubjectMatches(reviewedPackage, refreshedPackage) &&
          reviewWasStampedForPackage(review, reviewedPackage),
      );
    return canRestamp ? stampPublishGateReviewStatusForPackage(review, refreshedPackage) : review;
  });
}

export async function refreshPublishPackage(params: {
  runId: string;
  decisionId?: string;
  selectedEvidenceKeys?: string[];
  publicationTarget?: 'draft' | 'ready';
}): Promise<{
  run: Run;
  packageId: string;
  packageHash: string;
  packageHeadSha?: string;
  packageInputHash?: string;
  reviewSubjectHash?: string;
  preservedEvidenceKeys: string[];
  droppedEvidence: { key: string; reason: string }[];
  droppedEvidenceKeys: string[];
  addedEvidenceKeys: string[];
}> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  const decision = run.decisions.find(
    (d) =>
      d.type === 'engine_human_gate' &&
      !d.resolvedAt &&
      (!params.decisionId || d.id === params.decisionId) &&
      (d.payload as ReadyGatePayload | undefined)?.kind === 'ready' &&
      Boolean((d.payload as ReadyGatePayload | undefined)?.prPackage),
  );
  if (!decision) throw new Error('No pending ready publish package decision to refresh');
  const status = publicationStatusForRun(run);
  if (status !== 'not_published') {
    throw new Error(`Cannot refresh publish package while publication status is ${status}`);
  }

  const oldPayload = decision.payload as ReadyGatePayload;
  const selectedBefore =
    params.selectedEvidenceKeys ??
    oldPayload.prPackage?.selectedEvidenceKeys ??
    oldPayload.prPackage?.evidenceManifest?.map((artifact) => artifact.path) ??
    [];
  const target =
    params.publicationTarget === 'draft' || params.publicationTarget === 'ready'
      ? params.publicationTarget
      : (oldPayload.publicationTarget ?? oldPayload.prPackage?.publicationTarget ?? 'ready');
  let reviewDepthForRefresh = oldPayload.reviewDepth;
  if (oldPayload.reviewDepth?.requestedBy === 'human-gate') {
    const projectVars = await loadProjectVars(run.project);
    reviewDepthForRefresh = reviewDepthForPublishPackageRefresh(
      run,
      projectVars.projectJson,
      oldPayload,
    );
  }

  // A refresh must describe the current HEAD, not the durable snapshot captured
  // before later review-fix commits changed the contribution.
  const diffStat = await getDiffStat(run, { fresh: true });
  const prepared = await prepareCompletionPackage(params.runId, {
    diffStat,
    publicationTarget: target,
    reviewDepth: reviewDepthForRefresh,
    selectedEvidenceKeys: selectedBefore,
    priorEvidenceManifest: oldPayload.prPackage?.evidenceManifest,
    stampReviews: false,
    requireArtifactMirror: Boolean(run.slotId),
    headSha: run.slotId ? undefined : oldPayload.prPackage?.headSha,
  });
  const refreshedRun = getRun(params.runId)!;
  const prPackage = prepared.prPackage;
  const { preservedEvidenceKeys, droppedEvidence, droppedEvidenceKeys, addedEvidenceKeys } =
    summarizePublishPackageRefreshEvidence(oldPayload.prPackage, prPackage, selectedBefore);
  const reviewDepth =
    prPackage.reviewDepth ?? reviewDepthForRefresh ?? publicationReviewPolicyForRun(refreshedRun);
  const historicalReadyGatePackages = refreshedRun.decisions
    .map((entry) => (entry.payload as ReadyGatePayload | undefined)?.prPackage)
    .filter((entry): entry is ReadyGatePrPackage => Boolean(entry));
  const independentReviews = restampReviewsForRefreshedPackage(
    refreshedRun.engineState?.publishGate?.independentReviews ?? [],
    [oldPayload.prPackage, ...historicalReadyGatePackages],
    prPackage,
  );
  const requiredReviewCount = effectiveRequiredReviewCount(reviewDepth);
  const staleReviewCount =
    requiredReviewCount > 0
      ? countStalePublicationReviews(independentReviews, prPackage, {
          requireCrossRunnerCertification: reviewDepth?.requireCrossRunner,
        })
      : 0;
  const reviewSatisfied =
    independentReviewPolicySatisfied(reviewDepth, independentReviews) && staleReviewCount === 0;
  // Offer the human evidence-refresh override only when the refresh regenerated
  // evidence digests but the reviewed HEAD is unchanged — never on code drift.
  const evidenceRefreshAction = buildEvidenceRefreshAction(
    independentReviews,
    prPackage,
    reviewDepth,
  );
  const actions: DecisionAction[] = [
    ...(reviewSatisfied
      ? [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }]
      : []),
    ...(evidenceRefreshAction ? [evidenceRefreshAction] : []),
    { id: 'hold', label: 'Hold', style: 'secondary' },
    { id: 'request-extra-review', label: 'Request Independent Review', style: 'secondary' },
    {
      id: 'request-cross-runner-review',
      label: 'Request Independent Review (runner diversity)',
      style: 'secondary',
    },
  ];
  const nextEngineState = {
    ...refreshedRun.engineState,
    publishGate: {
      ...refreshedRun.engineState?.publishGate,
      independentReviews,
    },
  };
  // Soft gate chip: re-probe behind-main + merge-tree on package refresh so the
  // operator sees staleness before more review loops. Never auto-rebases.
  // Always replace (not partial-spread) freshness keys so stale mergeConflictPaths
  // / hints cannot survive a clean or failed probe via ...oldPayload.
  let freshness: Awaited<ReturnType<typeof probeSlotBranchFreshness>> = null;
  let freshnessLine = '';
  if (refreshedRun.slotId) {
    try {
      const vars = await loadSlotVars(refreshedRun.slotId);
      const projectVars = await loadProjectVars(refreshedRun.project);
      const defaultBranch = getProjectField(projectVars.projectJson, 'default_branch') || 'main';
      const strategy = resolveBranchUpdateStrategy(projectVars.projectJson);
      freshness = await probeSlotBranchFreshness(vars, String(defaultBranch), strategy);
      if (freshness) {
        const behindLabel =
          typeof freshness.behindMain === 'number' ? String(freshness.behindMain) : 'unknown';
        const conflictLabel =
          typeof freshness.mergeConflicts === 'boolean'
            ? String(freshness.mergeConflicts)
            : 'unknown';
        const detail =
          freshness.mergeConflicts === true ||
          (typeof freshness.behindMain === 'number' && freshness.behindMain > 0) ||
          !freshness.remoteRefOk
            ? ` — ${freshness.hint}`
            : '';
        freshnessLine = `\n**Branch freshness:** behindMain=${behindLabel}, mergeConflicts=${conflictLabel}${detail}`;
      }
    } catch (err) {
      console.warn(
        `[run-engine] package-refresh branch-freshness probe failed for ${params.runId.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
      );
      freshness = null;
    }
  }
  const nextPayload: ReadyGatePayload = applyBranchFreshnessToReadyGatePayload(
    {
      ...oldPayload,
      diffStat: prPackage.diffStat,
      branch: prPackage.branch,
      headSha: prPackage.headSha,
      artifactManifest: prPackage.evidenceManifest,
      prPackage,
      reviewDepth,
      independentReviews,
      gatePolicy: prPackage.gatePolicy,
      gateSummary: buildGateSummary(
        { ...refreshedRun, engineState: nextEngineState },
        GATE_SUMMARY_KINDS.publication,
        { gatePolicy: prPackage.gatePolicy, preparedPackage: prPackage },
      ),
      validationSummary: prPackage.validationSummaryPath ?? undefined,
      publicationTarget: prPackage.publicationTarget,
      publicationStatus: publicationStatusForRun(refreshedRun),
      stale: staleReviewCount > 0,
      draftEdits: {
        ...(oldPayload.draftEdits ?? {}),
        selectedEvidenceKeys: prPackage.selectedEvidenceKeys,
      },
    },
    freshness,
  );
  const nextDecision: RunDecision = {
    ...decision,
    actions,
    payload: nextPayload,
    description: `**Package:** ${prPackage.id}\n**Target:** ${prPackage.publicationTarget}\n**Branch:** ${prPackage.branch || refreshedRun.branch || 'unknown'}\n**Files:** ${prPackage.diffStat.files} (+${prPackage.diffStat.additions} -${prPackage.diffStat.deletions})${freshnessLine}\n\nPackage refreshed. Review the local package before public PR publication.`,
  };
  updateRun(params.runId, {
    engineState: nextEngineState,
    decisions: refreshedRun.decisions.map((entry) =>
      entry.id === nextDecision.id ? nextDecision : entry,
    ),
  });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(params.runId) });
  console.log(
    `[run-engine] run ${params.runId.slice(0, 8)} — publish package refreshed (${prPackage.id}/${prPackage.packageHash.slice(0, 12)})`,
  );

  return {
    run: getRun(params.runId)!,
    packageId: prPackage.id,
    packageHash: prPackage.packageHash,
    packageHeadSha: prPackage.headSha,
    packageInputHash: prPackage.packageInputHash,
    reviewSubjectHash: prPackage.reviewSubjectHash,
    preservedEvidenceKeys,
    droppedEvidence,
    droppedEvidenceKeys,
    addedEvidenceKeys,
  };
}
