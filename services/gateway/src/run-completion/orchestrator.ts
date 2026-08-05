// run-completion.ts — Post-work completion pipeline
// Handles artifact copy, PR comments (with worker report), PR body sanitization, retrospective curation.

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactRef,
  DEFAULT_BRANCH,
  type DiffStat,
  type GatePolicy,
  type IndependentReviewStatus,
  modelsMatch,
  type PublicationStatus,
  type PublicationTarget,
  type ReadyGatePrPackage,
  type ReviewDepthPolicy,
  type Run,
} from '@farmslot/protocol';

import { getProjectField, loadProjectVars, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { execLocal } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';
import { ghRequest } from '../integrations/github-client.js';
import { findPRNumber, persistRunPrNumber } from '../integrations/pr-linkage.js';
import { effectiveRequiredReviewCount } from '../quality/review-policy.js';
import { inferReviewSourceKind, reviewCompositeKey } from '../quality/review-sources.js';
import { publicationReviewPolicyForRun } from '../run-engine/publication-policy.js';
import { resolveRunnerSessionForRun } from '../runners/session-process.js';
import { getRun, updateRun } from '../runs/store.js';
import { extractRunnerSessionUsage } from '../runtime/session-usage.js';
import {
  captureCurrentReviewSnapshot,
  unavailableReviewSnapshot,
} from '../self-review/snapshots.js';
import { isNoCodeTerminalDisposition } from '../tasks/worker-signals.js';

import { refreshArtifactMirror } from './artifact-mirror.js';
import {
  buildDraftPrBody,
  buildDraftPrTitle,
  isPackageSelectableEvidenceArtifact,
  mergeEvidenceManifestArtifactRefs,
} from './draft-pr.js';
import type { EvidenceManifest } from './evidence-manifest.js';
import { evidenceKeyVariants } from './evidence-paths.js';
import {
  augmentIndependentReviewAttemptsFromArtifacts,
  materializeIndependentReviewArtifacts,
} from './independent-reviews.js';
import { buildPackageEvidenceManifest } from './package-evidence-manifest.js';
import {
  markPRReady,
  postPRComment,
  shouldPostWorkerReportComment,
  updatePRTitle,
} from './pr-publication.js';
import {
  assertSelectedEvidencePublished,
  expandEvidenceSelectionForManifest,
  postProcessPRBody,
  readEvidenceManifest,
  scanArtifacts,
  uploadArtifacts,
} from './publication-artifacts.js';
import {
  computeReadyGatePackageHash,
  computeReadyGatePackageInputHash,
  computeReadyGateReviewSubjectHash,
  resolveSelectedEvidenceRef,
  sha256Text,
  sortArtifactRefsForComparison,
  stableJson,
} from './ready-gate-package.js';
export {
  defaultReviewDepthPolicy,
  effectiveRequiredReviewCount,
  independentReviewPolicySatisfied,
} from '../quality/review-policy.js';
export {
  ciRequiresPublishedPr,
  publicationReviewPolicyForRun,
  requiresPublicationApproval,
  shouldPrepareLocalFirstPackage,
} from '../run-engine/publication-policy.js';
export type {
  CaptionConfidence,
  EvidenceManifest,
  EvidenceManifestPair,
  EvidenceManifestVideo,
  LowCaption,
} from './evidence-manifest.js';
export {
  assertCaptionConfidence,
  autoDetectEvidenceManifest,
  buildEvidenceSection,
  captionConfidenceFor,
  collectLowCaptions,
  EvidenceCaptionError,
  validateEvidenceManifest,
} from './evidence-manifest.js';
import {
  createRetrospective,
  initRunCompletionRetrospective,
  readTaskArtifactText,
  readWorkerReport,
  readWorkerReportArtifact,
} from './retrospective.js';
export {
  assertSelectedEvidencePublished,
  expandEvidenceSelectionForManifest,
  filterArtifactUrlsByEvidenceSelection,
  filterEvidenceManifestBySelection,
  localPrBodyPathResidues,
  postProcessPRBody,
  readEvidenceManifest,
  scanArtifacts,
  uploadArtifacts,
} from './publication-artifacts.js';
export {
  buildRetrospectivePayload,
  createRetrospective,
  createRetrospectiveForRun,
  inferRetrospectiveOutcome,
  readCommentsTriageSummary,
} from './retrospective.js';

type BroadcastFn = (event: string, payload: unknown) => void;

export function initRunCompletion(broadcast: BroadcastFn): void {
  initRunCompletionRetrospective(broadcast);
}

export interface CompletionResult {
  prNumber: number | null;
  ciRepo: string | null;
  artifactsCopied: boolean;
  prCommentPosted: boolean;
  prTitleUpdated: boolean;
  prMarkedReady: boolean;
  retrospectiveCreated: boolean;
  artifacts: ArtifactRef[];
}

export interface PrepareCompletionPackageResult {
  completion: CompletionResult;
  prPackage: ReadyGatePrPackage;
  reviewDepth: ReviewDepthPolicy;
  independentReviews: IndependentReviewStatus[];
}

export interface PublishCompletionPackageResult extends CompletionResult {
  publicationTarget: PublicationTarget;
  publicationStatus: PublicationStatus;
  packageHash: string;
  bodyPostProcessed: boolean;
}

/**
 * Extract worker session cost + token counts via session-usage.sh and persist
 * on run.metrics. Returns the extracted values so callers can reuse them
 * (e.g. review-pr calls this before post-review.sh to populate the PR comment).
 */
export interface SessionCostSnapshot {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  turns: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
  actualModel: string | null;
}

export async function extractAndPersistSessionCost(runId: string): Promise<SessionCostSnapshot> {
  const empty: SessionCostSnapshot = {
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    turns: null,
    cacheCreation: null,
    cacheRead: null,
    actualModel: null,
  };
  const run = getRun(runId);
  if (!run || !run.slotId) return empty;
  try {
    const vars = await loadSlotVars(run.slotId);
    const resolved = await resolveRunnerSessionForRun(run, vars);
    const runnerSessionPath = resolved?.runnerSessionPath ?? run.metrics.runnerSessionPath;
    const runnerSessionId = resolved?.runnerSessionId ?? run.metrics.runnerSessionId;
    const usage = await extractRunnerSessionUsage({
      slotId: run.slotId,
      vars,
      runner: run.metrics.runner,
      runnerSessionId,
      runnerSessionPath,
    });
    const costUsd = usage.costUsd ?? null;
    const inputTokens = usage.inputTokens ?? null;
    const outputTokens = usage.outputTokens ?? null;
    const totalTokens =
      usage.totalTokens ??
      (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
    const turns = usage.turns ?? null;
    const cacheCreation = usage.cacheCreation ?? null;
    const cacheRead = usage.cacheRead ?? null;
    const actualModel = usage.actualModel ?? null;
    const metricsPatch: Partial<typeof run.metrics> = {};
    if (costUsd !== null) metricsPatch.costEstimate = costUsd;
    if (turns !== null) metricsPatch.sessionTurns = turns;
    if (inputTokens !== null) metricsPatch.sessionInputTokens = inputTokens;
    if (outputTokens !== null) metricsPatch.sessionOutputTokens = outputTokens;
    if (cacheCreation !== null) metricsPatch.sessionCacheCreation = cacheCreation;
    if (cacheRead !== null) metricsPatch.sessionCacheRead = cacheRead;
    if (totalTokens !== null) metricsPatch.sessionTotalTokens = totalTokens;
    if (actualModel) metricsPatch.actualModel = actualModel;
    if (actualModel && run.metrics.model && !modelsMatch(run.metrics.model, actualModel)) {
      console.warn(
        `[run-completion] model drift: dispatched=${run.metrics.model} actual=${actualModel} run=${runId}`,
      );
    }
    if (
      resolved &&
      (resolved.runnerSessionPath !== run.metrics.runnerSessionPath ||
        resolved.runnerSessionId !== run.metrics.runnerSessionId)
    ) {
      metricsPatch.runnerSessionPath = resolved.runnerSessionPath;
      metricsPatch.runnerSessionId = resolved.runnerSessionId;
    }
    if (Object.keys(metricsPatch).length > 0) {
      updateRun(runId, { metrics: { ...run.metrics, ...metricsPatch } });
      console.log(
        `[run-completion] session cost: $${costUsd?.toFixed(4) ?? '?'} turns=${turns ?? '?'} actualModel=${actualModel ?? '?'} (input=${inputTokens ?? '?'} output=${outputTokens ?? '?'})`,
      );
    }
    return {
      costUsd,
      inputTokens,
      outputTokens,
      totalTokens,
      turns,
      cacheCreation,
      cacheRead,
      actualModel,
    };
  } catch (err) {
    console.warn(`[run-completion] cost extraction failed (non-fatal): ${(err as Error).message}`);
    return empty;
  }
}

export async function assertReadyGatePackageInputsCurrent(
  current: Run,
  preparedPackage: ReadyGatePrPackage,
): Promise<void> {
  if (!current.taskFile) throw new Error('Approved package requires a task directory');
  const taskDir = path.dirname(current.taskFile);
  const artifacts = await scanArtifacts(taskDir);
  const currentEvidenceManifest = await readEvidenceManifest(current);
  const currentManifest = await buildPackageEvidenceManifest(
    taskDir,
    artifacts,
    currentEvidenceManifest,
  );
  const report = await readWorkerReport(current);
  const validation = await readValidationSummary(current);
  const mismatches: string[] = [];

  if (buildDraftPrTitle(current) !== preparedPackage.draftTitle) mismatches.push('draft title');
  if ((await buildDraftPrBody(current, report, artifacts)) !== preparedPackage.draftBody) {
    mismatches.push('draft body');
  }
  if (
    stableJson(sortArtifactRefsForComparison(currentManifest)) !==
    stableJson(sortArtifactRefsForComparison(preparedPackage.evidenceManifest ?? []))
  ) {
    mismatches.push('evidence manifest');
  }
  if (validation.path !== (preparedPackage.validationSummaryPath ?? null)) {
    mismatches.push('validation summary path');
  }
  if (validation.hash !== (preparedPackage.validationSummaryHash ?? null)) {
    mismatches.push('validation summary hash');
  }

  if (mismatches.length === 0) return;
  throw new Error(
    `Package changed; refresh package and re-review before publishing (${mismatches.join(', ')})`,
  );
}

export function isPublishedStatus(status: PublicationStatus | undefined | null): boolean {
  return status === 'published_draft' || status === 'published_ready';
}

export function publicationStatusForRun(run: Run | null | undefined): PublicationStatus {
  return run?.engineState?.publishGate?.publicationStatus ?? 'not_published';
}

export function isArtifactOnlyRun(run: Pick<Run, 'completionPolicy'> | null | undefined): boolean {
  return run?.completionPolicy === 'artifact-only';
}

function gatePolicyForRun(run: Run): GatePolicy {
  return {
    owner: 'human',
    dispatchMode: run.mode,
    publishAuthority: 'human',
    reason:
      run.mode === 'autonomous'
        ? 'v1 autonomous local-first runs still require human publication approval'
        : 'v1 local-first publication is human-gated',
  };
}

function defaultPublicationTarget(run: Run): PublicationTarget {
  const target = run.engineState?.publishGate?.publicationTarget;
  return target === 'ready' || target === 'draft' ? target : 'ready';
}

async function readValidationSummary(
  run: Run,
): Promise<{ path: string | null; text: string | null; hash: string | null }> {
  const candidates = ['validation-summary.md', 'validation.md', 'recipe-coverage.md', 'report.md'];
  for (const name of candidates) {
    const text = await readTaskArtifactText(run, name);
    if (text?.trim()) return { path: `artifacts/${name}`, text, hash: sha256Text(text) };
  }
  return { path: null, text: null, hash: null };
}

async function snapshotHeadSha(run: Run): Promise<string | undefined> {
  if (!run.slotId) return undefined;
  try {
    const vars = await loadSlotVars(run.slotId);
    const result = await execOnSlot(
      vars,
      `git -C '${vars.remoteRepo}' rev-parse HEAD 2>/dev/null`,
      { timeout: 15_000 },
    );
    const sha = result.stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
  } catch (err) {
    console.warn(
      `[run-completion] head SHA snapshot failed for ${run.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
    );
    return undefined;
  }
}

function preserveSelectedEvidenceKeys(
  selectedEvidenceKeys: string[] | undefined,
  evidenceManifest: ArtifactRef[],
  trustedEvidenceManifest: EvidenceManifest | null | undefined,
  priorEvidenceManifest?: ArtifactRef[],
): string[] | undefined {
  if (!selectedEvidenceKeys) return undefined;
  const preserved = [
    ...new Set(
      selectedEvidenceKeys
        .map((key) => resolveSelectedEvidenceRef(key, evidenceManifest))
        .filter((artifact): artifact is ArtifactRef => {
          if (!artifact) return false;
          return isPackageSelectableEvidenceArtifact(artifact, trustedEvidenceManifest);
        })
        .map((artifact) => artifact.path),
    ),
  ];
  if (priorEvidenceManifest) {
    const priorPaths = new Set(priorEvidenceManifest.flatMap((a) => evidenceKeyVariants(a.path)));
    const newPublishable = evidenceManifest
      .filter(
        (a) =>
          isPackageSelectableEvidenceArtifact(a, trustedEvidenceManifest) &&
          !evidenceKeyVariants(a.path).some((v) => priorPaths.has(v)),
      )
      .map((a) => a.path);
    for (const key of newPublishable) {
      if (!preserved.includes(key)) preserved.push(key);
    }
  }
  return preserved.sort();
}

export function selectedEvidenceKeysForPublication(input: {
  selectedEvidenceKeys: readonly string[] | undefined;
  evidenceManifest: ArtifactRef[];
  trustedEvidenceManifest: EvidenceManifest | null | undefined;
}): string[] {
  return [
    ...new Set(
      (input.selectedEvidenceKeys ?? [])
        .map((key) => resolveSelectedEvidenceRef(key, input.evidenceManifest))
        .filter((artifact): artifact is ArtifactRef => {
          if (!artifact) return false;
          return isPackageSelectableEvidenceArtifact(artifact, input.trustedEvidenceManifest);
        })
        .map((artifact) => artifact.path),
    ),
  ].sort();
}

const LOCAL_PROOF_VIDEO_EXT = /\.(mp4|mov|webm)$/i;

export function defaultSelectedEvidenceKeysForPublication(input: {
  evidenceManifest: ArtifactRef[];
  trustedEvidenceManifest: EvidenceManifest | null | undefined;
}): string[] {
  return input.evidenceManifest
    .filter(
      (artifact) =>
        !LOCAL_PROOF_VIDEO_EXT.test(artifact.path) &&
        isPackageSelectableEvidenceArtifact(artifact, input.trustedEvidenceManifest),
    )
    .map((artifact) => artifact.path)
    .sort();
}

/**
 * Pre-gate safe completion phase for fix-bug v1. This copies local artifacts,
 * captures branch/session/package metadata, and writes immutable package files.
 * It deliberately suppresses every GitHub PR mutation path.
 */
export async function prepareCompletionPackage(
  runId: string,
  options?: {
    diffStat?: DiffStat;
    publicationTarget?: PublicationTarget;
    reviewDepth?: ReviewDepthPolicy;
    selectedEvidenceKeys?: string[];
    priorEvidenceManifest?: ArtifactRef[];
    stampReviews?: boolean;
    requireArtifactMirror?: boolean;
    headSha?: string;
  },
): Promise<PrepareCompletionPackageResult> {
  const before = getRun(runId);
  if (!before) throw new Error(`Run not found: ${runId}`);

  const completion = await runCompletionPipeline(runId, {
    skipRetrospective: true,
    suppressPrMutation: true,
    requireArtifactMirror: options?.requireArtifactMirror,
  });
  const run = getRun(runId)!;
  const report = await readWorkerReport(run);
  const artifacts = completion.artifacts;
  const taskDir = run.taskFile ? path.dirname(run.taskFile) : null;
  const runEvidenceManifest = await readEvidenceManifest(run);
  const evidenceManifest = await buildPackageEvidenceManifest(
    taskDir,
    artifacts,
    runEvidenceManifest,
  );
  const validation = await readValidationSummary(run);
  const projectVars = await loadProjectVars(run.project);
  const reviewDepth = publicationReviewPolicyForRun(
    run,
    projectVars.projectJson,
    options?.reviewDepth ?? run.engineState?.publishGate?.reviewDepth,
  );
  const materializedReviews = await materializeIndependentReviewArtifacts(run);
  const selfReviewStep = run.steps.find((step) => step.name === 'self-review');
  const priorReviews = (run.engineState?.publishGate?.independentReviews ?? []).filter(
    (review) =>
      !(
        inferReviewSourceKind(review) === 'self-review' &&
        review.verdict === 'pending' &&
        selfReviewStep?.status !== 'running'
      ),
  );
  // Composite (sourceKind, loopNumber) key — defense in depth so two streams
  // can't collide even if a future caller bypasses the source helpers. The id
  // alone was the prior key and silently dropped entries on collision.
  const priorReviewsByCompositeKey = new Map<string, IndependentReviewStatus>();
  const reviewsByCompositeKey = new Map<string, IndependentReviewStatus>();
  for (const review of priorReviews) {
    const key = reviewCompositeKey(inferReviewSourceKind(review), review.loopNumber);
    priorReviewsByCompositeKey.set(key, review);
    reviewsByCompositeKey.set(key, review);
  }
  const priorSelfReview =
    priorReviews.filter((review) => inferReviewSourceKind(review) === 'self-review').at(-1) ?? null;
  if (materializedReviews.some((review) => inferReviewSourceKind(review) === 'self-review')) {
    for (const [key, review] of reviewsByCompositeKey) {
      if (inferReviewSourceKind(review) === 'self-review') reviewsByCompositeKey.delete(key);
    }
  }
  for (const review of materializedReviews) {
    const key = reviewCompositeKey(inferReviewSourceKind(review), review.loopNumber);
    const prior =
      priorReviewsByCompositeKey.get(key) ??
      (inferReviewSourceKind(review) === 'self-review' ? priorSelfReview : null);
    reviewsByCompositeKey.set(
      key,
      options?.stampReviews === false && prior
        ? {
            ...review,
            reviewedHeadSha: prior.reviewedHeadSha,
            reviewedPackageInputHash: prior.reviewedPackageInputHash,
            reviewedReviewSubjectHash: prior.reviewedReviewSubjectHash,
          }
        : review,
    );
  }
  let independentReviews = [...reviewsByCompositeKey.values()].sort(
    (a, b) => a.loopNumber - b.loopNumber,
  );
  independentReviews = await augmentIndependentReviewAttemptsFromArtifacts(run, independentReviews);
  const target = options?.publicationTarget ?? defaultPublicationTarget(run);
  // A live slot always wins. A persisted package HEAD is accepted only as the
  // inspection identity fallback after that slot has been removed.
  const headSha = (await snapshotHeadSha(run)) ?? options?.headSha;
  if (!headSha) {
    throw new Error('Cannot prepare publishable PR package without a workspace HEAD SHA');
  }
  let reviewSnapshot = unavailableReviewSnapshot('missing-slot');
  if (run.slotId) {
    let vars: Awaited<ReturnType<typeof loadSlotVars>> | null = null;
    try {
      vars = await loadSlotVars(run.slotId);
    } catch (error) {
      // A removed slot must not make the package impossible to inspect.
      reviewSnapshot = unavailableReviewSnapshot('slot-load-error', (error as Error).message);
    }
    if (vars) reviewSnapshot = (await captureCurrentReviewSnapshot(vars)).snapshot;
  }
  const branch = run.branch ?? before.branch ?? '';
  const packageId = `pkg-${run.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const artifactPath = 'artifacts/pr-package.json';
  const validSelectedEvidenceKeys = preserveSelectedEvidenceKeys(
    options?.selectedEvidenceKeys,
    evidenceManifest,
    runEvidenceManifest,
    options?.priorEvidenceManifest,
  );
  const draftBodyArtifacts = evidenceManifest.length
    ? evidenceManifest
    : mergeEvidenceManifestArtifactRefs(artifacts, runEvidenceManifest);
  const basePackage: Omit<ReadyGatePrPackage, 'packageHash'> = {
    id: packageId,
    artifactPath,
    branch,
    remoteBranchRef: branch ? `origin/${branch}` : null,
    headSha,
    diffStat: options?.diffStat ?? { files: 0, additions: 0, deletions: 0 },
    reviewSnapshot,
    draftTitle: buildDraftPrTitle(run),
    draftBody: await buildDraftPrBody(run, report, draftBodyArtifacts),
    evidenceManifest,
    selectedEvidenceKeys:
      validSelectedEvidenceKeys ??
      defaultSelectedEvidenceKeysForPublication({
        evidenceManifest,
        trustedEvidenceManifest: runEvidenceManifest,
      }),
    validationSummaryPath: validation.path,
    validationSummaryHash: validation.hash,
    reviewArtifactIds: independentReviews.flatMap((review) => review.artifactPaths ?? [review.id]),
    dispatchMode: run.mode,
    gatePolicy: gatePolicyForRun(run),
    reviewDepth,
    publicationTarget: target,
    publicationStatus: 'not_published',
    createdAt: new Date().toISOString(),
  };
  const packageInputHash = computeReadyGatePackageInputHash(basePackage);
  const reviewSubjectHash = computeReadyGateReviewSubjectHash(basePackage);
  const packageWithoutHash = {
    ...basePackage,
    packageInputHash,
    reviewSubjectHash,
  };
  const packageHash = computeReadyGatePackageHash(packageWithoutHash);
  const prPackage: ReadyGatePrPackage = { ...packageWithoutHash, packageHash };
  if (options?.stampReviews !== false) {
    independentReviews = independentReviews.map((review) => ({
      ...review,
      reviewedHeadSha: prPackage.headSha ?? review.reviewSnapshot?.headSha ?? null,
      reviewedPackageInputHash: prPackage.packageInputHash ?? null,
      reviewedReviewSubjectHash: prPackage.reviewSubjectHash ?? null,
    }));
    prPackage.reviewArtifactIds = independentReviews.flatMap(
      (review) => review.artifactPaths ?? [review.id],
    );
  }

  if (taskDir) {
    const artifactsDir = path.join(taskDir, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(taskDir, artifactPath), JSON.stringify(prPackage, null, 2), 'utf-8');
    await writeFile(
      path.join(taskDir, 'artifacts/pr-package.md'),
      [
        '# PR Package',
        '',
        `- Package: ${prPackage.id}`,
        `- Hash: ${prPackage.packageHash}`,
        `- Branch: ${prPackage.branch || 'unknown'}`,
        `- Head: ${prPackage.headSha ?? 'unknown'}`,
        `- Target: ${prPackage.publicationTarget}`,
        `- Status: ${prPackage.publicationStatus}`,
        `- Reviews: ${independentReviews.length}/${effectiveRequiredReviewCount(reviewDepth)}`,
        '',
        '## Draft title',
        prPackage.draftTitle,
        '',
        '## Draft body',
        prPackage.draftBody,
      ].join('\n'),
      'utf-8',
    );
  }

  updateRun(runId, {
    engineState: {
      ...run.engineState,
      publishGate: {
        ...run.engineState?.publishGate,
        packageId: prPackage.id,
        packageHash: prPackage.packageHash,
        packageInputHash: prPackage.packageInputHash,
        reviewSubjectHash: prPackage.reviewSubjectHash,
        packageArtifactPath: artifactPath,
        publicationTarget: target,
        publicationStatus: 'not_published',
        reviewDepth,
        independentReviews,
      },
    },
  });

  return { completion, prPackage, reviewDepth, independentReviews };
}

/**
 * Run the full completion pipeline. Called from run-engine's `complete` step.
 * Returns enriched result with boolean flags for each sub-action.
 */
export async function runCompletionPipeline(
  runId: string,
  options?: {
    skipRetrospective?: boolean;
    suppressPrMutation?: boolean;
    requireArtifactMirror?: boolean;
  },
): Promise<CompletionResult> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const flags: CompletionResult = {
    prNumber: null,
    ciRepo: null,
    artifactsCopied: false,
    prCommentPosted: false,
    prTitleUpdated: false,
    prMarkedReady: false,
    retrospectiveCreated: false,
    artifacts: [],
  };

  // For review-pr: artifacts + review posting are handled by the human-gate step.
  // The complete step only releases the slot and creates the retrospective.
  const isReviewPR = run.flowType === 'review-pr';

  // 0. Copy artifacts from worker repo FIRST (skip for review-pr — already done in review-gate).
  //    Best-effort: completion proceeds even if the mirror copy fails so the
  //    rest of the pipeline (cost extraction, report generation) is not
  //    blocked. The explicit user-triggered path (run.refreshMirror) does NOT
  //    swallow errors — see runRefreshMirror in methods/run.ts.
  if (!isReviewPR) {
    try {
      const copied = await refreshArtifactMirror(run);
      if (options?.requireArtifactMirror && copied === 0) {
        throw new Error('artifact mirror refresh copied no files');
      }
      flags.artifactsCopied = true;
    } catch (err) {
      if (options?.requireArtifactMirror) {
        throw new Error(
          `Artifact mirror refresh failed; cannot build an authoritative publish package: ${(err as Error).message}`,
        );
      }
      console.warn(
        `[run-completion] artifact mirror failed (non-fatal, continuing): ${(err as Error).message}`,
      );
    }
  }

  // 0b. Extract worker session cost
  await extractAndPersistSessionCost(runId);

  // 1. Read worker's report from artifacts (now available locally)
  const reportArtifact = await readWorkerReportArtifact(run);
  const report = reportArtifact?.text ?? null;

  // Detect branch from git if not already set on the run. Compare against the
  // project's default_branch (not hardcoded `main`) so projects with custom
  // default branches don't persist their own default as a feature branch.
  if (!run.branch && run.slotId) {
    try {
      const slotVars = await loadSlotVars(run.slotId);
      const pv = await loadProjectVars(run.project).catch(() => null);
      const defaultBranch =
        (pv && getProjectField(pv.projectJson, 'default_branch')) || DEFAULT_BRANCH;
      const result = await execLocal(
        `git -C '${slotVars.remoteRepo}' rev-parse --abbrev-ref HEAD 2>/dev/null`,
      );
      const branch = result.stdout.trim();
      if (branch && branch !== defaultBranch) {
        updateRun(runId, { branch });
        console.log(`[run-completion] detected branch from git: ${branch}`);
      }
    } catch {
      /* non-fatal */
    }
  }

  // Re-read run after potential branch update
  const updatedRun = getRun(runId)!;
  const suppressPrMutation =
    options?.suppressPrMutation ||
    isNoCodeTerminalDisposition(updatedRun.metrics.disposition) ||
    isArtifactOnlyRun(updatedRun);

  // Resolve CI repo
  const pv = await loadProjectVars(updatedRun.project).catch(() => null);
  const ciRepo: string | null = (pv?.projectJson as any)?.ci?.repo ?? null;
  flags.ciRepo = ciRepo;

  // 2. Find PR number
  const prNumber = !suppressPrMutation && ciRepo ? await findPRNumber(updatedRun, ciRepo) : null;
  flags.prNumber = prNumber;
  if (prNumber) {
    await persistRunPrNumber(runId, prNumber);
  }

  // 3. Post PR completion comment with metrics + report (skip for review-pr — post-review.sh handles it)
  // Gate on a non-empty worker report so runs that never wrote
  // artifacts/report.md (cancelled, crashed, short-circuited) don't spam the
  // PR with metadata-only comments whose `Worker report` collapsible reads
  // "No report available." — each run has a unique short-id so the body-dedup
  // check at postPRComment can't catch these.
  //
  // We deliberately do NOT gate on `run.status === 'done'` here — this helper
  // runs inside the `complete` step, and startRun() doesn't flip the run to
  // `done` until the whole pipeline returns, so status is `completing` during
  // this call. The fact that we reached step 3 is itself the evidence we need.
  const reportIsSubstantive = typeof report === 'string' && report.trim().length > 0;
  const shouldPostReport = shouldPostWorkerReportComment(run.flowType, reportArtifact?.fileName);
  if (!isReviewPR && shouldPostReport && ciRepo && prNumber && reportIsSubstantive) {
    flags.prCommentPosted = await postPRComment(run, report, ciRepo, prNumber);
  } else if (!isReviewPR && shouldPostReport && ciRepo && prNumber) {
    console.log(
      `[run-completion] skipping pr-comment for ${runId.slice(0, 8)}: status=${run.status} report=${reportIsSubstantive ? 'present' : 'missing'}`,
    );
  }

  // 4. Update PR title with proper conventional commit format (skip for review-pr — author owns title)
  if (!isReviewPR && ciRepo && prNumber) {
    try {
      await updatePRTitle(run, ciRepo, prNumber);
      flags.prTitleUpdated = true;
    } catch {
      /* tracked via flag */
    }
  }

  // 5. Upload artifacts (screenshots, videos) to artifacts repo
  let artifactUrls = new Map<string, string>();
  if (!isReviewPR && prNumber && run.taskFile) {
    try {
      artifactUrls = await uploadArtifacts(updatedRun, prNumber);
    } catch (err) {
      console.warn(
        `[run-completion] artifact upload failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  // 6. For flows with ci-watch: rewrite PR body + check author checklist, then mark ready.
  if (!isReviewPR && ciRepo && prNumber) {
    // Replace local artifact paths with uploaded URLs + auto-check author checklist boxes.
    // Fail-closed and ordered before markPRReady: a sanitization failure must leave the
    // PR in draft rather than publish a body that still exposes local-only paths.
    await postProcessPRBody(updatedRun, ciRepo, prNumber, artifactUrls, undefined, {
      failOnError: true,
    });
    try {
      await markPRReady(ciRepo, prNumber);
      flags.prMarkedReady = true;
    } catch {
      /* tracked via flag */
    }
  }

  // 6. Create retrospective decision for user review
  //    Skipped when flow has ci-watch (retrospective moves there) or human-gate (serves as quality check)
  if (!options?.skipRetrospective) {
    await createRetrospective(run, report);
    flags.retrospectiveCreated = true;
  }

  // 7. Scan artifact directory for manifest
  if (run.taskFile) {
    flags.artifacts = await scanArtifacts(path.dirname(run.taskFile));
  }

  return flags;
}

async function createPrFromApprovedPackage(
  run: Run,
  ciRepo: string,
  prPackage: ReadyGatePrPackage,
): Promise<number | null> {
  if (!run.slotId) throw new Error('cannot publish a local-first PR without an assigned slot');
  const vars = await loadSlotVars(run.slotId);
  if (prPackage.headSha) {
    const head = (
      await execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} rev-parse HEAD 2>/dev/null`, {
        timeout: 15_000,
      })
    ).stdout.trim();
    if (!head || head !== prPackage.headSha) {
      throw new Error(
        `Package HEAD drift before PR creation: approved ${prPackage.headSha.slice(0, 12)} but live HEAD is ${head ? head.slice(0, 12) : 'unknown'}`,
      );
    }
  }
  if (!prPackage.branch?.trim()) throw new Error('approved package is missing a branch');
  await execOnSlot(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} push -u origin ${shellQuote(prPackage.branch)}`,
    { timeout: 120_000 },
  );

  const tmpFile = `/tmp/farmslot-pr-body-${run.id.slice(0, 8)}-${randomUUID()}.md`;
  await writeFile(tmpFile, pendingPublicationBody(prPackage), 'utf-8');
  const pv = await loadProjectVars(run.project).catch(() => null);
  const base = (pv && getProjectField(pv.projectJson, 'default_branch')) || DEFAULT_BRANCH;
  const args = [
    'pr',
    'create',
    '--repo',
    ciRepo,
    '--head',
    prPackage.branch,
    '--base',
    base,
    '--title',
    pendingPublicationTitle(prPackage),
    '--body-file',
    tmpFile,
  ];
  // Always create local-first PRs as draft while artifact upload/body rewrite is
  // still pending. Ready publication marks it ready only after the final body is
  // rewritten with uploaded evidence URLs.
  args.push('--draft');
  try {
    const result = await ghRequest(args, { force: true });
    const url = result.stdout
      .trim()
      .split(/\s+/)
      .find((part) => /github\.com\/.+\/pull\/\d+/.test(part));
    const match = url?.match(/\/pull\/(\d+)/);
    if (match) return Number(match[1]);
    return findPRNumber(run, ciRepo);
  } finally {
    await rm(tmpFile, { force: true }).catch((err: unknown) => {
      console.warn(
        `[run-completion] temporary PR body cleanup failed: ${(err as Error).message.slice(0, 200)}`,
      );
    });
  }
}

function pendingPublicationTitle(prPackage: ReadyGatePrPackage): string {
  return `chore: prepare farmslot publication ${prPackage.id}`;
}

function pendingPublicationBody(prPackage: ReadyGatePrPackage): string {
  return [
    '## Summary',
    `Farmslot is preparing publication package ${prPackage.id}.`,
    '',
    'Validated evidence links have not been finalized yet. Farmslot will replace this placeholder before publication is marked ready.',
  ].join('\n');
}

async function applyApprovedPrTitle(
  ciRepo: string,
  prNumber: number,
  prPackage: ReadyGatePrPackage,
): Promise<void> {
  await ghRequest(
    ['pr', 'edit', String(prNumber), '--repo', ciRepo, '--title', prPackage.draftTitle],
    { force: true },
  );
}

/**
 * Post-approval publication phase. This is the only fix-bug v1 helper that is
 * allowed to create/update PR surfaces, post comments, upload evidence, rewrite
 * PR body, or mark ready.
 */
/** Sub-step emitter for finalize progress UI. Each phase boundary fires
 *  `('substep', { name, detail })` so the engine can update step.detail in
 *  real time and the operator sees what's running instead of a blank
 *  "Finalizing…" while GitHub calls round-trip. */
export type PublishProgressEmitter = (
  event: string,
  payload: { name?: string; detail?: string },
) => void;

export async function publishCompletionPackage(
  runId: string,
  approvedPackage: ReadyGatePrPackage,
  options?: {
    publicationTarget?: PublicationTarget;
    comment?: string;
    selectedEvidenceKeys?: string[];
    emit?: PublishProgressEmitter;
  },
): Promise<PublishCompletionPackageResult> {
  const emit: PublishProgressEmitter = options?.emit ?? (() => {});
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const already = publicationStatusForRun(run);
  const target = options?.publicationTarget ?? approvedPackage.publicationTarget ?? 'draft';
  const flags: PublishCompletionPackageResult = {
    prNumber: run.prNumber ?? null,
    ciRepo: null,
    artifactsCopied: true,
    prCommentPosted: false,
    prTitleUpdated: false,
    prMarkedReady: false,
    retrospectiveCreated: false,
    artifacts: run.taskFile ? await scanArtifacts(path.dirname(run.taskFile)) : [],
    publicationTarget: target,
    publicationStatus: already,
    packageHash: approvedPackage.packageHash,
    bodyPostProcessed: false,
  };
  if (isPublishedStatus(already) && run.prNumber) return flags;

  updateRun(runId, {
    engineState: {
      ...run.engineState,
      publishGate: {
        ...run.engineState?.publishGate,
        publicationTarget: target,
        publicationStatus: 'pending_publish',
        approvedPackageHash: approvedPackage.packageHash,
        approvedAt: approvedPackage.approvedAt ?? new Date().toISOString(),
      },
    },
  });

  try {
    emit('substep', { name: 'load-project-vars', detail: 'Loading project config' });
    const pv = await loadProjectVars(run.project).catch(() => null);
    const ciRepo: string | null = (pv?.projectJson as any)?.ci?.repo ?? null;
    flags.ciRepo = ciRepo;
    if (!ciRepo) throw new Error('no ci.repo configured');

    emit('substep', { name: 'resolve-pr-number', detail: `Resolving PR number against ${ciRepo}` });
    let prNumber = run.prNumber ?? (await findPRNumber(run, ciRepo, { noRetry: true }));
    if (!prNumber) {
      emit('substep', { name: 'create-pr', detail: `Creating draft PR on ${ciRepo}` });
      prNumber = await createPrFromApprovedPackage(run, ciRepo, approvedPackage);
    }
    if (!prNumber) throw new Error('publication could not resolve or create a PR number');
    flags.prNumber = prNumber;
    await persistRunPrNumber(runId, prNumber);

    const latestRun = getRun(runId) ?? run;
    const reportArtifact = await readWorkerReportArtifact(latestRun);
    const report = reportArtifact?.text ?? null;
    const reportIsSubstantive = typeof report === 'string' && report.trim().length > 0;
    if (
      reportIsSubstantive &&
      shouldPostWorkerReportComment(latestRun.flowType, reportArtifact?.fileName)
    ) {
      emit('substep', {
        name: 'post-worker-report',
        detail: `Posting worker report to PR #${prNumber}`,
      });
      flags.prCommentPosted = await postPRComment(latestRun, report, ciRepo, prNumber, {
        failOnError: true,
      });
    }
    if (options?.comment?.trim()) {
      emit('substep', {
        name: 'post-operator-comment',
        detail: `Posting operator comment to PR #${prNumber}`,
      });
      await ghRequest(
        ['pr', 'comment', String(prNumber), '--repo', ciRepo, '--body', options.comment],
        { force: true },
      );
    }

    const approvedSelectedEvidenceKeys =
      options?.selectedEvidenceKeys ?? approvedPackage.selectedEvidenceKeys ?? [];
    const evidenceManifest = latestRun.taskFile ? await readEvidenceManifest(latestRun) : null;
    const publishableSelectedEvidenceKeys = selectedEvidenceKeysForPublication({
      selectedEvidenceKeys: approvedSelectedEvidenceKeys,
      evidenceManifest: approvedPackage.evidenceManifest ?? [],
      trustedEvidenceManifest: evidenceManifest,
    });
    const selectedEvidenceKeys =
      expandEvidenceSelectionForManifest(evidenceManifest, publishableSelectedEvidenceKeys) ?? [];
    let artifactUrls = new Map<string, string>();
    if (latestRun.taskFile) {
      emit('substep', {
        name: 'upload-artifacts',
        detail: `Uploading ${selectedEvidenceKeys.length} evidence artifact(s)`,
      });
      artifactUrls = await uploadArtifacts(latestRun, prNumber, selectedEvidenceKeys, {
        failOnError: true,
      });
      flags.artifacts = await scanArtifacts(path.dirname(latestRun.taskFile));
    }
    assertSelectedEvidencePublished(selectedEvidenceKeys, artifactUrls);

    emit('substep', {
      name: 'post-process-pr-body',
      detail: `Rewriting PR #${prNumber} body with artifact links`,
    });
    await postProcessPRBody(latestRun, ciRepo, prNumber, artifactUrls, selectedEvidenceKeys, {
      failOnError: true,
      baseBody: approvedPackage.draftBody,
      evidenceManifest,
    });
    flags.bodyPostProcessed = true;

    emit('substep', { name: 'apply-pr-title', detail: `Updating PR #${prNumber} title` });
    await applyApprovedPrTitle(ciRepo, prNumber, approvedPackage);
    flags.prTitleUpdated = true;

    if (target === 'ready') {
      emit('substep', {
        name: 'mark-pr-ready',
        detail: `Marking PR #${prNumber} ready for review`,
      });
      await markPRReady(ciRepo, prNumber);
      flags.prMarkedReady = true;
    }

    const publicationStatus: PublicationStatus =
      target === 'ready' ? 'published_ready' : 'published_draft';
    flags.publicationStatus = publicationStatus;
    updateRun(runId, {
      engineState: {
        ...getRun(runId)?.engineState,
        publishGate: {
          ...getRun(runId)?.engineState?.publishGate,
          publicationTarget: target,
          publicationStatus,
          approvedPackageHash: approvedPackage.packageHash,
          prNumber,
        },
      },
    });
    return flags;
  } catch (err) {
    const latest = getRun(runId) ?? run;
    updateRun(runId, {
      engineState: {
        ...latest.engineState,
        publishGate: {
          ...latest.engineState?.publishGate,
          publicationTarget: target,
          publicationStatus: 'publish_failed',
        },
      },
    });
    throw err;
  }
}
