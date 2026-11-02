// publish-package-refresh.ts — Ready-gate package refresh and evidence-selection preservation

import {
  effectiveRequiredReviewCount,
  Events,
  GATE_SUMMARY_KINDS,
  isPublishApprovalAction,
  latestExhaustedReview,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  RecordedEvidenceReadError,
  reviewPolicySatisfied,
  reviewRetryCapReason,
  type ReviewStatus,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars, SlotConfigError } from '../core/config.js';
import { reviewedInputsChanged } from '../review/reviewed-inputs.js';
import { evidenceKeyVariants } from '../run-completion/evidence-paths.js';
import {
  prepareCompletionPackageTransitionLocked,
  publicationStatusForRun,
} from '../run-completion/orchestrator.js';
import { preparedPackageIsStale } from '../run-completion/prepared-package-stale.js';
import { publicationBaselineContext } from '../run-completion/publication-artifacts.js';
import { capturePublicationSource } from '../run-completion/publication-source.js';
import {
  computeReadyGateReviewSubjectHash,
  readReadyGatePreparedPackage,
} from '../run-completion/ready-gate-package.js';
import { retainedRunTaskDirectory } from '../run-completion/retained-artifacts.js';
import { withRunTransition } from '../run-lifecycle/transition-coordinator.js';
import { readRunProgress, type RunProgressObservation } from '../runners/run-progress.js';
import { commitRunVisualJudgment, getRun, persistRunNow, updateRun } from '../runs/store.js';

import {
  applyBranchFreshnessToReadyGatePayload,
  type BranchFreshnessSummary,
  probeRunBaseFreshness,
} from './branch-freshness.js';
import { BlockedRunError, OWNED_WORKER_NOT_IDLE, OwnedWorkerBusyError } from './errors.js';
import {
  buildEvidenceRefreshAction,
  countStalePublicationReviews,
  gateReviewContinuationForRun,
  publicationGateDecisionActions,
  reviewerIsActiveForReview,
  reviewFinalSnapshotMatchesPreparedPackage,
  stampPublishGateReviewStatusForPackage,
} from './gate-policy.js';
import { refreshRunGateReadiness, reviewsWithValidResults } from './gate-prerequisites.js';
import { buildGateSummary } from './gate-summary.js';
import { readyGateReviewSubjectMatches } from './post-dispatch-steps.js';
import { publicationReviewPolicyForRun } from './publication-policy.js';
import { readGateRecordedEvidenceSources } from './recorded-evidence-sources.js';
import { refreshReviewDiffIdentities, refreshReviewDiffSnapshot } from './review-diff-refresh.js';
import { projectClaimFindingSettlements } from './review-finding-settlements.js';
import { getDiffStat } from './task-artifacts.js';
import { activeVisualRepair, visualRepairOffered } from './visual-repair.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};

export function setPublishPackageRefreshBroadcast(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

async function currentPublicationHead(run: Run): Promise<string | null> {
  return (await capturePublicationSource(run)).headSha;
}

async function publicationBundleAvailable(
  run: Run,
  prepared: ReadyGatePrPackage,
): Promise<boolean> {
  if (!prepared.artifactBundle) return true;
  try {
    await retainedRunTaskDirectory(run, prepared.artifactBundle);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** The gate loop and inspection share the existing package writer. */
export async function ensureCurrentPublishPackage(
  runId: string,
): Promise<ReadyGatePrPackage | undefined> {
  return withRunTransition(runId, async () => {
    const run = getRun(runId);
    if (!run) return undefined;
    const status = publicationStatusForRun(run);
    if (status !== 'not_published' && status !== 'pending_publish') return undefined;
    const prepared = await readReadyGatePreparedPackage(run);
    // Approval already bound this package. A restarted gate must replay that
    // approval without preparing a replacement or losing its package identity.
    if (status === 'pending_publish') {
      if (!prepared || !(await publicationBundleAvailable(run, prepared)))
        throw new BlockedRunError(
          'Approved publication package is unavailable; restore its artifacts',
        );
      return prepared;
    }
    const head = await currentPublicationHead(run);
    if (!head)
      throw new BlockedRunError(
        'Publication source HEAD is unavailable; restore the owned source before approval',
      );
    const ids = (run.engineState?.publishGate?.reviews ?? [])
      .flatMap((review) => review.artifactPaths ?? [review.id])
      .sort();
    if (
      !preparedPackageIsStale(run) &&
      prepared?.headSha === head &&
      JSON.stringify([...prepared.reviewArtifactIds].sort()) === JSON.stringify(ids) &&
      (await publicationBundleAvailable(run, prepared))
    )
      return prepared;
    await refreshPublishPackageTransitionLocked({ runId }, true);
    return readReadyGatePreparedPackage(getRun(runId)!);
  });
}

interface PublicationInspectionReaders {
  head: typeof currentPublicationHead;
  bundleAvailable: typeof publicationBundleAvailable;
  progress: (run: Run) => Promise<RunProgressObservation>;
  refresh: (runId: string, decisionId: string) => Promise<Run>;
}

const inspectionRefreshes = new Map<string, Promise<Run>>();

/**
 * An evidence refusal is kept until its inputs change. Every run.get and decision list inspects the
 * gate, and each refresh holds the machine's transition key while it reads the worker's checkout,
 * so re-running a refusal on every poll would starve the machine's other runs. Artifact edits
 * leave HEAD alone, so a refusal is also retried once it is a few minutes old, and as soon as the
 * worker has worked again.
 */
const refreshRefusals = new Map<string, { inputs: string; message: string; at: number }>();
const REFRESH_REFUSAL_RETRY_MS = 5 * 60_000;

function refreshInputs(run: Run, decisionId: string, head: string): string {
  return JSON.stringify([
    decisionId,
    head,
    run.engineState?.generation ?? 0,
    run.slotId,
    run.branch,
    publicationBaselineContext(run).baseSha,
    (run.beforeAttemptAttestations ?? []).map((attestation) => attestation.id),
  ]);
}

/** Only an evidence refusal repeats on the next poll; a node timeout or a busy worker does not. */
function isEvidenceRefusal(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof RecordedEvidenceReadError) return true;
  return false;
}

function refreshFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One bounded log line: a node failure can carry a command's whole output. */
function refreshFailureLogLine(message: string): string {
  const line = message.replace(/\s+/gu, ' ');
  return line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
}

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
  ) {
    // A gate that closed, or moved past refreshing, has no refusal left to show.
    refreshRefusals.delete(run.id);
    return Promise.resolve(run);
  }
  const existing = inspectionRefreshes.get(run.id);
  if (existing) return existing;
  const readers: PublicationInspectionReaders = {
    head: currentPublicationHead,
    bundleAvailable: publicationBundleAvailable,
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
      const bundleAvailable =
        pending.payload?.kind === 'ready' && pending.payload.prPackage
          ? await readers.bundleAvailable(run, pending.payload.prPackage)
          : false;
      if (
        !preparedPackageIsStale(getRun(run.id) ?? run) &&
        pending.payload?.kind === 'ready' &&
        pending.payload.prPackage?.headSha === head &&
        bundleAvailable
      )
        return getRun(run.id) ?? run;
      const progress = await readers.progress(getRun(run.id) ?? run);
      if (progress.kind !== 'idle') {
        // A worker acting on the gate (re-recording, say) gets its result refreshed. An unproven
        // read under node load is not the worker working, so the refusal is kept through it.
        if (progress.kind === 'making-progress') refreshRefusals.delete(run.id);
        return collecting(
          bundleAvailable
            ? 'Publication HEAD changed; waiting for the owned worker to be idle before refreshing its package.'
            : 'Retained publication evidence is missing; waiting for the owned worker to be idle before refreshing its package.',
          head,
        );
      }
      const inputs = refreshInputs(getRun(run.id) ?? run, pending.id, head);
      const refused = refreshRefusals.get(run.id);
      if (refused?.inputs === inputs && Date.now() - refused.at < REFRESH_REFUSAL_RETRY_MS)
        return collecting(`Publication package refresh could not finish: ${refused.message}`);
      try {
        return await readers.refresh(run.id, pending.id);
      } catch (error) {
        if (isEvidenceRefusal(error))
          refreshRefusals.set(run.id, {
            inputs,
            message: refreshFailureMessage(error),
            at: Date.now(),
          });
        throw error;
      }
    } catch (error) {
      return collecting(
        `Publication package refresh could not finish: ${refreshFailureMessage(error)}`,
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

export function restampReviewsForRefreshedPackage(
  reviews: ReviewStatus[],
  reviewedPackages: Array<ReadyGatePrPackage | undefined>,
  refreshedPackage: ReadyGatePrPackage,
): ReviewStatus[] {
  return reviews.map((review) => {
    if (!reviewFinalSnapshotMatchesPreparedPackage(review, refreshedPackage)) return review;
    const canRestamp =
      review.source === 'dispatch' ||
      review.source === 'human-gate' ||
      (review.source === 'pipeline' &&
        !!review.settledFindings?.length &&
        reviewedPackages.some(
          (prior) => prior && readyGateReviewSubjectMatches(prior, refreshedPackage),
        )) ||
      reviewedPackages.some(
        (reviewedPackage) =>
          reviewedPackage &&
          readyGateReviewSubjectMatches(reviewedPackage, refreshedPackage) &&
          reviewWasStampedForPackage(review, reviewedPackage),
      );
    return canRestamp ? stampPublishGateReviewStatusForPackage(review, refreshedPackage) : review;
  });
}

export async function refreshPublishPackage(
  params: Parameters<typeof refreshPublishPackageTransitionLocked>[0],
  readers: { progress?: typeof readRunProgress; source?: typeof capturePublicationSource } = {},
): ReturnType<typeof refreshPublishPackageTransitionLocked> {
  const startedAt = Date.now();
  try {
    return await withRunTransition(params.runId, () =>
      refreshPublishPackageTransitionLocked(params, false, readers.progress, readers.source),
    );
  } catch (error) {
    // A caller that timed out never sees this refusal, so the log keeps it. Inspection runs a
    // refusal again only once its inputs change, so this is one line per attempt, not per poll.
    const message = refreshFailureMessage(error);
    console.warn(
      `[run-engine] run ${params.runId.slice(0, 8)} — publish package refresh refused after ${Math.round((Date.now() - startedAt) / 1000)}s: ${refreshFailureLogLine(message)}`,
    );
    // The gate shows the latest evidence refusal, not an older remembered one.
    const remembered = refreshRefusals.get(params.runId);
    if (remembered && isEvidenceRefusal(error))
      refreshRefusals.set(params.runId, { ...remembered, message, at: Date.now() });
    throw error;
  }
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
      ? {
          ...decision.payload,
          prPackage: decision.payload.prPackage ?? (await readReadyGatePreparedPackage(run)),
        }
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
    throw progress.kind === 'making-progress'
      ? new OwnedWorkerBusyError()
      : new BlockedRunError(OWNED_WORKER_NOT_IDLE);
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
  // Compare both sides using verified canonical digests, while retaining each
  // historical package's recorded stamps and immutable stored artifact.
  const capturedSnapshots = prepared.reviews.flatMap((review) =>
    [review, ...(review.attempts ?? [])].flatMap((attempt) => attempt.reviewSnapshot ?? []),
  );
  const reviewedPackages = await Promise.all(
    [oldPayload.prPackage, ...historicalReadyGatePackages].map(async (reviewedPackage) => {
      if (!reviewedPackage?.reviewSnapshot) return reviewedPackage;
      const snapshot = await refreshReviewDiffSnapshot(
        refreshedRun,
        reviewedPackage.reviewSnapshot,
        capturedSnapshots,
      );
      return snapshot === reviewedPackage.reviewSnapshot
        ? reviewedPackage
        : { ...reviewedPackage, reviewSnapshot: snapshot };
    }),
  );
  const capturedReviews = (await refreshReviewDiffIdentities(refreshedRun, prepared.reviews)).map(
    ({ settledFindings: _settled, ...review }) => review,
  );
  const valid = await reviewsWithValidResults({
    ...refreshedRun,
    artifactBundle: prPackage.artifactBundle ?? refreshedRun.artifactBundle,
    engineState: {
      ...refreshedRun.engineState,
      publishGate: { ...refreshedRun.engineState?.publishGate, reviews: capturedReviews },
    },
  });
  const projection =
    prPackage.headSha &&
    valid.some((review) => review.verdict === 'issues') &&
    refreshedRun.visualJudgmentReceipts?.some(
      (receipt) =>
        (receipt.kind ?? 'person-reviewed') === 'person-reviewed' &&
        receipt.verdict === 'confirmed',
    )
      ? projectClaimFindingSettlements(
          refreshedRun,
          await readGateRecordedEvidenceSources(refreshedRun, prPackage),
          prPackage.headSha,
          capturedReviews,
          new Set(valid.map((review) => review.id)),
        )
      : { reviews: capturedReviews, receipts: [] };
  for (const receipt of projection.receipts) {
    if (!receipt.settledReviewFindings?.length) continue;
    await commitRunVisualJudgment(
      refreshedRun.id,
      () => receipt,
      (current) => {
        if (
          (current.engineState?.generation ?? 0) !== generation ||
          current.slotId !== run.slotId ||
          current.branch !== run.branch
        )
          throw new Error('Run ownership changed during finding settlement');
      },
    );
  }
  const reviews = restampReviewsForRefreshedPackage(
    projection.reviews,
    reviewedPackages,
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
  const pendingReview = await gateReviewContinuationForRun(refreshedRun, prPackage.headSha);
  const actions = publicationGateDecisionActions({
    reviewSatisfied,
    evidenceRefreshAction,
    pendingReviewContinuation:
      pendingReview && !reviewerIsActiveForReview(refreshedRun, pendingReview)
        ? pendingReview
        : undefined,
    sendBackToAgent: await visualRepairOffered(refreshedRun, prPackage),
    visualRepairReviewId: activeVisualRepair(refreshedRun)?.reviewId,
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
  // Re-probe behind-base + merge-tree against the publication base on package refresh so the
  // operator sees staleness before more review loops, and a conflict blocks approval (F302).
  // Never auto-rebases.
  // Always replace (not partial-spread) freshness keys so stale mergeConflictPaths
  // / hints cannot survive a clean or failed probe via ...oldPayload.
  let freshness: BranchFreshnessSummary | null = null;
  let freshnessLine = '';
  if (refreshedRun.slotId) {
    try {
      freshness = (await probeRunBaseFreshness(refreshedRun))?.freshness ?? null;
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
  refreshRefusals.delete(params.runId);
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
    decisions: refreshedRun.decisions.flatMap((entry): RunDecision[] => {
      if (!nextDecision || entry.id !== nextDecision.id) return [entry];
      return [
        ...(oldPayload.prPackage && oldPayload.prPackage.id !== prPackage.id
          ? [
              {
                ...entry,
                id: `${entry.id}-snapshot-${oldPayload.prPackage.id}`,
                resolvedAt: new Date().toISOString(),
                resolvedAction: 'superseded-by-package-refresh',
                payload: {
                  ...oldPayload,
                  prPackage: { ...oldPayload.prPackage, supersededByPackageId: prPackage.id },
                },
              },
            ]
          : []),
        nextDecision,
      ];
    }),
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
