// publish-package-refresh.ts — Ready-gate package refresh and evidence-selection preservation

import {
  DEFAULT_BRANCH,
  effectiveRequiredReviewCount,
  Events,
  GATE_SUMMARY_KINDS,
  isPublishApprovalAction,
  latestExhaustedReview,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  reviewPolicySatisfied,
  reviewRetryCapReason,
  type ReviewStatus,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import { getProjectField, loadProjectVars, loadSlotVars, SlotConfigError } from '../core/config.js';
import { reviewedInputsChanged } from '../review/reviewed-inputs.js';
import { evidenceKeyVariants } from '../run-completion/evidence-paths.js';
import {
  prepareCompletionPackageTransitionLocked,
  publicationStatusForRun,
} from '../run-completion/orchestrator.js';
import { capturePublicationSource } from '../run-completion/publication-source.js';
import {
  computeReadyGateReviewSubjectHash,
  readReadyGatePreparedPackage,
} from '../run-completion/ready-gate-package.js';
import { withRunTransition } from '../run-lifecycle/transition-coordinator.js';
import { readRunProgress, type RunProgressObservation } from '../runners/run-progress.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import {
  applyBranchFreshnessToReadyGatePayload,
  probeSlotBranchFreshness,
  resolveBranchUpdateStrategy,
} from './branch-freshness.js';
import { BlockedRunError } from './errors.js';
import {
  buildEvidenceRefreshAction,
  countStalePublicationReviews,
  pendingReviewContinuation,
  publicationGateDecisionActions,
  reviewerIsActiveForReview,
  reviewFinalSnapshotMatchesPreparedPackage,
  stampPublishGateReviewStatusForPackage,
} from './gate-policy.js';
import { refreshRunGateReadiness } from './gate-prerequisites.js';
import { buildGateSummary } from './gate-summary.js';
import { readyGateReviewSubjectMatches } from './post-dispatch-steps.js';
import { publicationReviewPolicyForRun } from './publication-policy.js';
import { refreshReviewDiffIdentities } from './review-diff-refresh.js';
import { getDiffStat } from './task-artifacts.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};

export function setPublishPackageRefreshBroadcast(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

async function currentPublicationHead(run: Run): Promise<string | null> {
  return (await capturePublicationSource(run)).headSha;
}

/** The gate loop and inspection share the existing package writer. */
export async function ensureCurrentPublishPackage(
  runId: string,
): Promise<ReadyGatePrPackage | undefined> {
  return withRunTransition(runId, async () => {
    const run = getRun(runId);
    if (!run || publicationStatusForRun(run) !== 'not_published') return undefined;
    const prepared = await readReadyGatePreparedPackage(run);
    const head = await currentPublicationHead(run);
    if (!head)
      throw new BlockedRunError(
        'Publication source HEAD is unavailable; restore the owned source before approval',
      );
    const ids = (run.engineState?.publishGate?.reviews ?? [])
      .flatMap((review) => review.artifactPaths ?? [review.id])
      .sort();
    if (
      prepared?.headSha === head &&
      JSON.stringify([...prepared.reviewArtifactIds].sort()) === JSON.stringify(ids)
    )
      return prepared;
    await refreshPublishPackageTransitionLocked({ runId }, true);
    return readReadyGatePreparedPackage(getRun(runId)!);
  });
}

interface PublicationInspectionReaders {
  head: typeof currentPublicationHead;
  progress: (run: Run) => Promise<RunProgressObservation>;
  refresh: (runId: string, decisionId: string) => Promise<Run>;
}

const inspectionRefreshes = new Map<string, Promise<Run>>();

/** Coalesce polling readers, and never snapshot a worker that is still progressing. */
export function reconcilePublicationPackageForInspection(
  run: Run,
  overrides: Partial<PublicationInspectionReaders> = {},
): Promise<Run> {
  const pending = run.decisions.find(
    (entry) => !entry.resolvedAt && entry.payload?.kind === 'ready',
  );
  if (
    !pending ||
    !['dev', 'fix-bug'].includes(run.flowType) ||
    run.readOnly ||
    publicationStatusForRun(run) !== 'not_published'
  )
    return Promise.resolve(run);
  const existing = inspectionRefreshes.get(run.id);
  if (existing) return existing;
  const readers: PublicationInspectionReaders = {
    head: currentPublicationHead,
    progress: readRunProgress,
    refresh: async (runId, decisionId) => (await refreshPublishPackage({ runId, decisionId })).run,
    ...overrides,
  };
  const collecting = (message: string, head?: string | null): Run => ({
    ...(getRun(run.id) ?? run),
    decisions: (getRun(run.id) ?? run).decisions.map((entry) =>
      entry.id !== pending.id || entry.resolvedAt || entry.payload?.kind !== 'ready'
        ? entry
        : {
            ...entry,
            actions: entry.actions.filter((action) => !isPublishApprovalAction(action.id)),
            description: message,
            payload: {
              ...entry.payload,
              headSha: head ?? entry.payload.headSha,
              stale: true,
              gateReadiness: {
                state: 'collecting',
                identity: { runId: run.id, generation: run.engineState?.generation ?? 0 },
                reasons: [
                  {
                    code: 'publication-package-refresh-pending',
                    prerequisite: 'lifecycle',
                    message,
                    actionId: 'hold',
                  },
                ],
              },
            },
          },
    ),
  });
  const operation = (async () => {
    try {
      const head = await readers.head(run);
      if (!head)
        return collecting(
          'Publication source HEAD is unavailable; retain the gate and restore source access.',
        );
      if (pending.payload?.kind === 'ready' && pending.payload.prPackage?.headSha === head)
        return getRun(run.id) ?? run;
      const progress = await readers.progress(getRun(run.id) ?? run);
      if (progress.kind !== 'idle')
        return collecting(
          'Publication HEAD changed; waiting for the owned worker to be idle before refreshing its package.',
          head,
        );
      return await readers.refresh(run.id, pending.id);
    } catch (error) {
      return collecting(
        `Publication package refresh could not finish: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      inspectionRefreshes.delete(run.id);
    }
  })();
  inspectionRefreshes.set(run.id, operation);
  return operation;
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

export function reviewPolicyForPublishPackageRefresh(
  run: Run,
  projectConfig: Parameters<typeof publicationReviewPolicyForRun>[1],
  oldPayload: Pick<ReadyGatePayload, 'reviewPolicy'>,
): ReadyGatePayload['reviewPolicy'] {
  const reviewPolicy =
    oldPayload.reviewPolicy?.requestedBy === 'human-gate'
      ? publicationReviewPolicyForRun(run, projectConfig)
      : oldPayload.reviewPolicy;
  return reviewPolicy;
}

function reviewWasStampedForPackage(
  review: ReviewStatus,
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
  reviews: ReviewStatus[],
  reviewedPackages: Array<ReadyGatePrPackage | undefined>,
  refreshedPackage: ReadyGatePrPackage,
): ReviewStatus[] {
  return reviews.map((review) => {
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

export function refreshPublishPackage(
  params: Parameters<typeof refreshPublishPackageTransitionLocked>[0],
  readers: { progress?: typeof readRunProgress; source?: typeof capturePublicationSource } = {},
): ReturnType<typeof refreshPublishPackageTransitionLocked> {
  return withRunTransition(params.runId, () =>
    refreshPublishPackageTransitionLocked(params, false, readers.progress, readers.source),
  );
}

async function refreshPublishPackageTransitionLocked(
  params: {
    runId: string;
    decisionId?: string;
    selectedEvidenceKeys?: string[];
    publicationTarget?: 'draft' | 'ready';
  },
  allowHistorical = false,
  progressReader: typeof readRunProgress = readRunProgress,
  sourceReader: typeof capturePublicationSource = capturePublicationSource,
): Promise<{
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
      (d.payload as ReadyGatePayload | undefined)?.kind === 'ready',
  );
  if (!decision && !allowHistorical)
    throw new Error(
      'No pending ready publish package decision; replay complete on this run to restore its gate',
    );
  const status = publicationStatusForRun(run);
  if (status !== 'not_published') {
    throw new Error(`Cannot refresh publish package while publication status is ${status}`);
  }

  const oldPayload: ReadyGatePayload =
    decision?.payload?.kind === 'ready'
      ? decision.payload
      : {
          kind: 'ready',
          prNumber: null,
          repo: null,
          branch: run.branch ?? '',
          diffStat: { files: 0, additions: 0, deletions: 0 },
          workerReport: '',
          prPackage: await readReadyGatePreparedPackage(run),
          reviewPolicy: run.engineState?.publishGate?.reviewPolicy,
        };
  let slotAvailable = false;
  if (run.slotId) {
    try {
      await loadSlotVars(run.slotId);
      slotAvailable = true;
    } catch (error) {
      if (!(error instanceof SlotConfigError) || error.code !== 'SLOT_NOT_FOUND') throw error;
    }
  }
  const generation = run.engineState?.generation ?? 0;
  const source = slotAvailable ? await sourceReader(run) : null;
  const head = source?.headSha ?? oldPayload.prPackage?.headSha;
  if (!head)
    throw new Error(
      'Current publication HEAD is unknown; retain the gate and restore source access',
    );
  const progress = slotAvailable ? await progressReader(run) : null;
  if (progress && progress.kind !== 'idle')
    throw new BlockedRunError(
      'Wait for the owned worker to be idle before refreshing its publication package',
    );
  const selectedBefore =
    params.selectedEvidenceKeys ??
    oldPayload.prPackage?.selectedEvidenceKeys ??
    oldPayload.prPackage?.evidenceManifest?.map((artifact) => artifact.path) ??
    [];
  const target =
    params.publicationTarget === 'draft' || params.publicationTarget === 'ready'
      ? params.publicationTarget
      : (oldPayload.publicationTarget ?? oldPayload.prPackage?.publicationTarget ?? 'ready');
  const projectConfig =
    oldPayload.reviewPolicy?.requestedBy === 'human-gate'
      ? (await loadProjectVars(run.project)).projectJson
      : undefined;
  const reviewPolicyForRefresh = reviewPolicyForPublishPackageRefresh(
    run,
    projectConfig,
    oldPayload,
  );

  // A refresh must describe the current HEAD, not the durable snapshot captured
  // before later review-fix commits changed the contribution.
  const diffStat = await getDiffStat(run, { fresh: true });
  const prepared = await prepareCompletionPackageTransitionLocked(params.runId, {
    diffStat,
    publicationTarget: target,
    reviewPolicy: reviewPolicyForRefresh,
    selectedEvidenceKeys: selectedBefore,
    priorEvidenceManifest: oldPayload.prPackage?.evidenceManifest,
    stampReviews: false,
    requireArtifactMirror: slotAvailable,
    ...(slotAvailable ? { expectedHeadSha: head } : { headSha: head }),
    deferCommit: true,
    assertSourceCurrent: async () => {
      const current = getRun(params.runId);
      if (
        !current ||
        (current.engineState?.generation ?? 0) !== generation ||
        current.slotId !== run.slotId ||
        current.branch !== run.branch
      )
        throw new Error('Run ownership changed during gate refresh');
      if (source && JSON.stringify(await sourceReader(current)) !== JSON.stringify(source))
        throw new Error('Run ownership or HEAD changed during gate refresh');
    },
  });
  const refreshedRun = getRun(params.runId)!;
  const prPackage = prepared.prPackage;
  const { preservedEvidenceKeys, droppedEvidence, droppedEvidenceKeys, addedEvidenceKeys } =
    summarizePublishPackageRefreshEvidence(oldPayload.prPackage, prPackage, selectedBefore);
  const reviewPolicy =
    prPackage.reviewPolicy ?? reviewPolicyForRefresh ?? publicationReviewPolicyForRun(refreshedRun);
  const historicalReadyGatePackages = refreshedRun.decisions
    .map((entry) => (entry.payload as ReadyGatePayload | undefined)?.prPackage)
    .filter((entry): entry is ReadyGatePrPackage => Boolean(entry));
  const reviews = restampReviewsForRefreshedPackage(
    await refreshReviewDiffIdentities(
      refreshedRun,
      refreshedRun.engineState?.publishGate?.reviews ?? [],
    ),
    [oldPayload.prPackage, ...historicalReadyGatePackages],
    prPackage,
  );
  const requiredReviewCount = effectiveRequiredReviewCount(reviewPolicy);
  const staleReviewCount =
    requiredReviewCount > 0 ? countStalePublicationReviews(reviews, prPackage) : 0;
  // A refresh after the evidence or HEAD changed needs a new review; a
  // description edit does not.
  const reviewedInputsStale = await reviewedInputsChanged(refreshedRun);
  const reviewSatisfied =
    reviewPolicySatisfied(reviewPolicy, reviews) && staleReviewCount === 0 && !reviewedInputsStale;
  // Offer the human evidence-refresh override only when the refresh regenerated
  // evidence digests but the reviewed HEAD is unchanged — never on code drift,
  // and never when what the last review judged has changed since.
  const evidenceRefreshAction = reviewedInputsStale
    ? null
    : buildEvidenceRefreshAction(reviews, prPackage);
  const exhaustedReview = latestExhaustedReview(reviews);
  const pendingReview = pendingReviewContinuation(reviews);
  const actions = publicationGateDecisionActions({
    reviewSatisfied,
    evidenceRefreshAction,
    pendingReviewContinuation:
      pendingReview && !reviewerIsActiveForReview(refreshedRun, pendingReview)
        ? pendingReview
        : undefined,
    reviews,
    preparedPackage: prPackage,
  });
  const nextEngineState = {
    ...refreshedRun.engineState,
    publishGate: {
      ...refreshedRun.engineState?.publishGate,
      reviews,
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
      const defaultBranch =
        getProjectField(projectVars.projectJson, 'default_branch') || DEFAULT_BRANCH;
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
      // The refreshed package carries the current description itself.
      currentDescription: undefined,
      reviewPolicy,
      reviews,
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
  // The preparation owner commits the package only after all projection I/O.
  // A late source refusal therefore preserves the previous canonical pointer.
  await prepared.commit!();
  const nextDecision: RunDecision | undefined = decision
    ? {
        ...decision,
        actions,
        context: { ...decision.context, gateActions: actions },
        payload: nextPayload,
        description: `**Package:** ${prPackage.id}\n**Target:** ${prPackage.publicationTarget}\n**Branch:** ${prPackage.branch || refreshedRun.branch || 'unknown'}\n**Files:** ${prPackage.diffStat.files} (+${prPackage.diffStat.additions} -${prPackage.diffStat.deletions})${freshnessLine}${exhaustedReview ? `\n**Review retries exhausted:** ${reviewRetryCapReason(exhaustedReview)}` : ''}\n\nPackage refreshed. Review the local package before public PR publication.`,
      }
    : undefined;
  updateRun(params.runId, {
    engineState: {
      ...getRun(params.runId)!.engineState,
      publishGate: { ...getRun(params.runId)!.engineState?.publishGate, reviews },
    },
    decisions: [
      ...refreshedRun.decisions.map((entry) =>
        nextDecision && entry.id === nextDecision.id ? nextDecision : entry,
      ),
      ...(decision && oldPayload.prPackage && oldPayload.prPackage.id !== prPackage.id
        ? [
            {
              ...decision,
              id: `${decision.id}-snapshot-${oldPayload.prPackage.id}`,
              resolvedAt: new Date().toISOString(),
              resolvedAction: 'superseded-by-package-refresh',
              payload: {
                ...oldPayload,
                prPackage: { ...oldPayload.prPackage, supersededByPackageId: prPackage.id },
              },
            },
          ]
        : []),
    ],
  });
  await refreshRunGateReadiness(getRun(params.runId)!);
  await persistRunNow(getRun(params.runId)!, 'publication package refresh');
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
