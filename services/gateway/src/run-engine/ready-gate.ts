// ready-gate.ts — Human ready/publication gate orchestration.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type EvidenceManifestEntry,
  type IndependentReviewStatus,
  PipelineSteps,
  type ReadyGateInputSnapshot,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type ReviewLoopRequest,
  reviewValidationDepthForLoop,
  type Run,
} from '@farmslot/protocol';

import { getProjectField, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { findPRNumber, persistRunPrNumber } from '../integrations/pr-linkage.js';
import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { formatIndependentReviewMarkdown } from '../quality/independent-review-artifacts.js';
import { loadRecipeQualityEvaluation } from '../quality/recipe-quality.js';
import {
  effectiveRequiredReviewCount,
  independentReviewPolicySatisfied,
} from '../quality/review-policy.js';
import {
  EXTRA_REVIEW_SOURCE,
  inferReviewSourceKind,
  REVIEW_SOURCES,
} from '../quality/review-sources.js';
import {
  isArtifactOnlyRun,
  publicationStatusForRun,
  scanArtifacts,
} from '../run-completion/orchestrator.js';
import { readReadyGatePreparedPackage } from '../run-completion/ready-gate-package.js';
import { defaultAlternateReviewRunner } from '../runners/registry.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';
import { executeSelfReview } from '../self-review/orchestrator.js';

import {
  latestResolvedHumanGateDecision,
  markResolvedHumanGateReviewRequestConsumed,
} from './decision-replay.js';
import { captureReviewInputArtifactsForRun } from './diff-artifacts.js';
import { createEngineDecision } from './engine-decisions.js';
import {
  assertPublicationReviewPolicySatisfied,
  buildPublishGateReviewStatus,
  countStalePublicationReviews,
  hasValidPrNumber,
  validatePackageApprovalSelection,
} from './gate-policy.js';
import { loadProjectVarsOrNull } from './project-vars.js';
import {
  publicationReviewPolicyForRun,
  requiresPublicationApproval,
} from './publication-policy.js';
import {
  effectiveReviewRunner,
  humanGateReviewDepth,
  MAX_PUBLISH_GATE_REVIEW_LOOPS,
  requestedReviewLoopCount,
  reviewPlanFromSelection,
} from './review-plan.js';
import { getDiffStat, readTaskArtifactText, readWorkerReport } from './task-artifacts.js';

const S = PipelineSteps;

export async function executePublishGateReviewPlan(
  runId: string,
  slotId: string,
  plan: ReviewLoopRequest[],
  source: 'dispatch' | 'human-gate',
): Promise<string[]> {
  const boundedPlan = plan.slice(0, MAX_PUBLISH_GATE_REVIEW_LOOPS);
  if (boundedPlan.length === 0) return [];
  const reviewIds: string[] = [];
  for (const planStep of boundedPlan) {
    const latestBeforeReview = getRun(runId)!;
    const reviewedPackage =
      source === 'human-gate' ? await readPreparedPackage(latestBeforeReview) : undefined;
    // ID + artifact paths flow through EXTRA_REVIEW_SOURCE so this stream stays
    // namespace-isolated from the worker's self-review attempts (review-sources.ts).
    const reviewId = EXTRA_REVIEW_SOURCE.artifactRefs(
      (latestBeforeReview.engineState?.publishGate?.independentReviews ?? []).length + 1,
    ).id;
    const requestedRunner = effectiveReviewRunner(planStep);
    updateRunStep(runId, S.HUMAN_GATE, {
      detail: requestedRunner
        ? `Running ${source} ${requestedRunner} review (${planStep.order}/${boundedPlan.length})...`
        : `Running ${source} worker-runner review (${planStep.order}/${boundedPlan.length})...`,
    });
    const reviewResult = await executeSelfReview(runId, slotId, {
      reviewRunner: requestedRunner,
      model: planStep.model ?? null,
      validationDepth:
        planStep.validationDepth ??
        reviewValidationDepthForLoop(planStep.order - 1, boundedPlan.length),
      artifactScope: reviewId,
      // Configured review steps are true review loops: findings are fed back
      // to the original worker, the worker fixes them, then the same reviewer
      // re-reviews before the next configured reviewer starts.
    });
    const latest = getRun(runId)!;
    const priorReviews = latest.engineState?.publishGate?.independentReviews ?? [];
    const reviewStatus = buildPublishGateReviewStatus({
      source,
      priorReviewCount: priorReviews.length,
      reviewResult,
      requestedRunner,
      workerRunner: latest.metrics.runner,
      model: latest.metrics.actualModel ?? latest.metrics.model ?? null,
      reviewId,
      reviewedPackage,
    });
    const reviewStatuses = await persistIndependentReviewArtifactsForRun(latest, [reviewStatus]);
    reviewIds.push(...reviewStatuses.map((review) => review.id));
    updateRun(runId, {
      engineState: {
        ...latest.engineState,
        publishGate: {
          ...latest.engineState?.publishGate,
          independentReviews: [...priorReviews, ...reviewStatuses],
        },
      },
    });
    if (reviewResult.verdict !== 'pass') break;
  }
  return reviewIds;
}
async function persistIndependentReviewArtifactsForRun(
  run: Run,
  reviews: IndependentReviewStatus[],
): Promise<IndependentReviewStatus[]> {
  if (!run.taskFile || reviews.length === 0) return reviews;
  const taskDir = path.dirname(run.taskFile);
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const persisted: IndependentReviewStatus[] = [];
  for (const review of reviews) {
    // Resolve artifact paths through the ReviewSource registry so persistence
    // honors per-stream conventions instead of reconstructing from id alone.
    // If the stream's conventions ever change, only review-sources.ts moves.
    const refs = REVIEW_SOURCES[inferReviewSourceKind(review)].artifactRefs(review.loopNumber);
    const withArtifacts = {
      ...review,
      artifactPaths: [...new Set([...(review.artifactPaths ?? []), refs.jsonRel, refs.mdRel])],
    };
    await writeFile(
      path.join(taskDir, refs.jsonRel),
      JSON.stringify(withArtifacts, null, 2),
      'utf-8',
    );
    await writeFile(
      path.join(taskDir, refs.mdRel),
      formatIndependentReviewMarkdown(withArtifacts),
      'utf-8',
    );
    persisted.push(withArtifacts);
  }
  invalidateArtifactTextCache(taskDir, run.slotId);
  invalidateLiveRecipeContextMemo(run.id);
  return persisted;
}

export async function readPreparedPackage(current: Run): Promise<ReadyGatePrPackage | undefined> {
  try {
    return await readReadyGatePreparedPackage(current);
  } catch (err) {
    console.warn(
      `[run-engine] prepared package read failed for ${current.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
    );
    return undefined;
  }
}

async function buildReadyGateInputSnapshot(current: Run): Promise<ReadyGateInputSnapshot> {
  let taskPrompt: string | undefined;
  if (current.taskFile) {
    try {
      taskPrompt = await readFile(current.taskFile, 'utf-8');
    } catch (err) {
      // Legacy/recycled runs can point at a task file that has already been
      // removed. The ready gate can still render ticket/input metadata, but
      // operators need the missing prompt surfaced in logs rather than hidden.
      console.warn(
        `[run-engine] ready-gate task prompt read failed for ${current.id.slice(0, 8)} at ${current.taskFile}: ${(err as Error).message}`,
      );
    }
  }

  return {
    ...(current.ticketData ? { ticketData: current.ticketData } : {}),
    taskFile: current.taskFile,
    ...(taskPrompt ? { taskPrompt } : {}),
    ...(current.engineState?.interactiveDev?.initialContext
      ? { initialContext: current.engineState.interactiveDev.initialContext }
      : {}),
    ...(current.engineState?.interactiveDev?.checklist?.length
      ? { checklist: current.engineState.interactiveDev.checklist }
      : {}),
    ...(current.templateProvenance ? { templateProvenance: current.templateProvenance } : {}),
  };
}

async function persistGateFeedback(
  current: Run,
  actionId: string,
  selectionData?: Record<string, unknown>,
): Promise<void> {
  if (!current.taskFile) return;
  const artifactsDir = path.join(path.dirname(current.taskFile), 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const rel = `artifacts/publication-gate-${actionId}-${Date.now().toString(36)}.md`;
  const instructions =
    typeof selectionData?.feedback === 'string'
      ? selectionData.feedback
      : typeof selectionData?.comment === 'string'
        ? selectionData.comment
        : '';
  await writeFile(
    path.join(path.dirname(current.taskFile), rel),
    [
      `# Publication gate action: ${actionId}`,
      '',
      instructions || 'No free-form instructions supplied.',
    ].join('\n'),
    'utf-8',
  );
  updateRun(current.id, {
    engineState: {
      ...current.engineState,
      publishGate: {
        ...current.engineState?.publishGate,
        feedbackArtifactPath: rel,
        ...(actionId === 'send-feedback' && current.engineState?.publishGate?.packageId
          ? {
              supersededPackageIds: [
                ...(current.engineState.publishGate.supersededPackageIds ?? []),
                current.engineState.publishGate.packageId,
              ],
            }
          : {}),
      },
    },
  });
}

export function localVideoProofWarning(
  evidence: Array<{ path: string }> | undefined,
): string | null {
  const paths = evidence?.map((artifact) => artifact.path.toLowerCase()) ?? [];
  if (paths.length === 0) return null;
  const hasScreenshot = paths.some((path) => /\.(png|jpe?g|gif)$/.test(path));
  const hasVideo = paths.some((path) => /\.(mp4|mov|webm)$/.test(path));
  if (!hasScreenshot || hasVideo) return null;
  return [
    '⚠️ Local video proof missing: screenshot evidence exists, but no after.mp4/.mov/.webm was packaged.',
    'Capture-helper screenshots can still prove the PR body, but add a local recipe video when you want fast post-run review without reloading the slot.',
  ].join(' ');
}

export async function executeReadyGate(runId: string): Promise<string> {
  const current = getRun(runId)!;
  const artifactOnly = isArtifactOnlyRun(current);

  // Find PR + CI repo
  const pv = await loadProjectVarsOrNull(current.project, 'run step', current.id);
  const ciRepo = pv?.projectJson ? getProjectField(pv.projectJson, 'ci.repo') || null : null;
  // `??` would treat the prNumber=0 sentinel as a real value and skip rescue;
  // hasValidPrNumber filters it so findPRNumber actually runs.
  const publicationApprovalGate = requiresPublicationApproval(current);
  const preparedPackage = publicationApprovalGate ? await readPreparedPackage(current) : undefined;
  const prNumber =
    artifactOnly || publicationApprovalGate
      ? null
      : hasValidPrNumber(current)
        ? current.prNumber!
        : ciRepo
          ? await findPRNumber(current, ciRepo)
          : null;
  if (!artifactOnly && prNumber && !hasValidPrNumber(current)) {
    await persistRunPrNumber(runId, prNumber);
    await captureReviewInputArtifactsForRun(getRun(runId)!);
  }

  // Read worker report for summary
  const report = await readWorkerReport(runId);

  const workerLearnings = await readTaskArtifactText(current.taskFile, 'learnings.md');

  // Build diff stat
  const diffStat = await getDiffStat(current);

  const videoProofWarning = localVideoProofWarning(preparedPackage?.evidenceManifest);
  const desc =
    publicationApprovalGate && preparedPackage
      ? [
          `**Package:** ${preparedPackage.id}`,
          `**Target:** ${preparedPackage.publicationTarget}`,
          `**Branch:** ${preparedPackage.branch || current.branch || 'unknown'}`,
          `**Files:** ${preparedPackage.diffStat.files} (+${preparedPackage.diffStat.additions} -${preparedPackage.diffStat.deletions})`,
          ...(videoProofWarning ? ['', videoProofWarning] : []),
          '',
          report?.slice(0, 300) ?? 'Review the local package before public PR publication.',
        ].join('\n')
      : report
        ? `**Branch:** ${current.branch ?? 'unknown'}\n**Files:** ${diffStat.files} (+${diffStat.additions} -${diffStat.deletions})\n\n${report.slice(0, 300)}`
        : `Worker finished. Branch: ${current.branch ?? 'unknown'}`;

  const reviewDepth =
    preparedPackage?.reviewDepth ??
    publicationReviewPolicyForRun(
      current,
      pv?.projectJson,
      current.engineState?.publishGate?.reviewDepth,
    );
  const independentReviews = current.engineState?.publishGate?.independentReviews ?? [];
  const requiredReviewCount = effectiveRequiredReviewCount(reviewDepth);
  const staleReviewCount =
    publicationApprovalGate && preparedPackage && requiredReviewCount > 0
      ? countStalePublicationReviews(independentReviews, preparedPackage, {
          requireCrossRunnerCertification: reviewDepth.requireCrossRunner,
        })
      : 0;
  const reviewSatisfied =
    !publicationApprovalGate ||
    (independentReviewPolicySatisfied(reviewDepth, independentReviews) && staleReviewCount === 0);
  const actions: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }> =
    publicationApprovalGate
      ? [
          ...(reviewSatisfied
            ? [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }]
            : []),
          { id: 'hold', label: 'Hold', style: 'secondary' as const },
          {
            id: 'request-extra-review',
            label: 'Request Extra Review',
            style: 'secondary' as const,
          },
          {
            id: 'request-cross-runner-review',
            label: 'Request External Review',
            style: 'secondary' as const,
          },
        ]
      : [
          { id: 'ready', label: 'Mark Ready', style: 'primary' },
          { id: 'hold', label: 'Hold', style: 'secondary' },
        ];

  const recipeJson = await readTaskArtifactText(current.taskFile, 'recipe.json');
  const recipeCoverage = await readTaskArtifactText(current.taskFile, 'recipe-coverage.md');

  // Scan artifact manifest
  let artifactManifest: EvidenceManifestEntry[] | undefined;
  if (current.taskFile) {
    try {
      const scanned = await scanArtifacts(path.dirname(current.taskFile));
      artifactManifest = scanned.map((artifact) => ({
        path: artifact.path,
        purpose: artifact.purpose,
        sizeBytes: artifact.sizeBytes,
      }));
    } catch (err) {
      // READY_GATE can still open without an artifact manifest, but operators
      // need this surfaced to diagnose missing evidence rather than accepting
      // a silent empty manifest.
      console.warn(
        `[run-engine] ready-gate artifact scan failed for ${runId.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }

  // Read self-review step output
  let selfReviewVerdict: string | undefined;
  let selfReviewSummary: string | undefined;
  const selfReviewStep = current.steps.find((s) => s.name === 'self-review');
  if (selfReviewStep?.outputs) {
    const out = selfReviewStep.outputs as Record<string, unknown>;
    selfReviewVerdict =
      typeof out.verdict === 'string' ? out.verdict : out.skipped ? 'skipped' : undefined;
    const issues = Array.isArray(out.issues)
      ? out.issues.filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    if (issues.length > 0) {
      selfReviewSummary = issues
        .map((issue) => `${String(issue.file ?? '')}: ${String(issue.description ?? '')}`)
        .join('; ');
    }
  }

  // Read ci-watch step output for inline CI status
  let ciChecks: Array<{ name: string; status: string; conclusion: string | null }> | undefined;
  const ciWatchStep = current.steps.find((s) => s.name === 'ci-watch');
  if (ciWatchStep?.outputs) {
    const out = ciWatchStep.outputs as Record<string, unknown>;
    if (!out.skipped) {
      const failed: string[] = Array.isArray(out.failedChecks)
        ? out.failedChecks.filter((name): name is string => typeof name === 'string')
        : [];
      const timeline: Array<{ status: string; detail?: string }> = Array.isArray(out.checkTimeline)
        ? out.checkTimeline.filter((entry): entry is { status: string; detail?: string } => {
            if (!entry || typeof entry !== 'object') return false;
            const record = entry as Record<string, unknown>;
            return (
              typeof record.status === 'string' &&
              (record.detail === undefined || typeof record.detail === 'string')
            );
          })
        : [];
      const lastEntry = timeline[timeline.length - 1];
      if (lastEntry?.detail) {
        // detail format: "pass: lint, tsc | fail: jest"
        const parts = lastEntry.detail.split('|').map((p: string) => p.trim());
        const checks: typeof ciChecks = [];
        for (const part of parts) {
          const [conclusion, names] = part.split(':').map((s: string) => s.trim());
          if (names) {
            for (const name of names.split(',').map((s: string) => s.trim())) {
              if (name)
                checks.push({
                  name,
                  status: 'completed',
                  conclusion: conclusion === 'pass' ? 'success' : 'failure',
                });
            }
          }
        }
        if (checks.length > 0) ciChecks = checks;
      }
      if (!ciChecks && failed.length > 0) {
        ciChecks = failed.map((name) => ({ name, status: 'completed', conclusion: 'failure' }));
      }
      if (!ciChecks && typeof out.result === 'string') {
        ciChecks = [
          {
            name: 'CI',
            status: 'completed',
            conclusion: out.result === 'pass' ? 'success' : 'failure',
          },
        ];
      }
    }
  }

  const acceptanceCriteria: string[] | undefined = current.ticketData?.acceptanceCriteria?.length
    ? current.ticketData.acceptanceCriteria
    : undefined;
  const inputSnapshot = await buildReadyGateInputSnapshot(current);

  // Snapshot the slot's HEAD SHA at gate-creation time so post-hoc viewers
  // can tell when the workspace's live diff has drifted from what was
  // reviewed. Non-fatal — legacy gates without this field fall back to
  // the "live diff" warning banner in ready-workspace.
  let headSha: string | undefined;
  if (current.slotId) {
    try {
      const vars = await loadSlotVars(current.slotId);
      const r = await execOnSlot(vars, `git -C '${vars.remoteRepo}' rev-parse HEAD 2>/dev/null`);
      const sha = r.stdout.trim();
      if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) headSha = sha;
    } catch (err) {
      console.warn(
        `[run-engine] ready-gate headSha capture failed for ${runId.slice(0, 8)}: ${(err as Error).message}`,
      );
    }
  }
  const readyPayload: ReadyGatePayload = {
    kind: 'ready',
    prNumber,
    repo: ciRepo,
    diffStat: preparedPackage?.diffStat ?? diffStat,
    workerReport: report ?? '',
    branch: preparedPackage?.branch ?? current.branch ?? '',
    slotId: current.slotId ?? undefined,
    headSha: preparedPackage?.headSha ?? headSha,
    recipeJson,
    recipeQualityArtifact: (
      await loadRecipeQualityEvaluation({
        run: current,
        workerReport: report ?? '',
        recipeJson,
        recipeCoverage,
      })
    ).artifact,
    artifactManifest: preparedPackage?.evidenceManifest ?? artifactManifest,
    selfReviewVerdict,
    selfReviewSummary,
    workerLearnings,
    ciChecks,
    acceptanceCriteria,
    inputSnapshot,
    ...(preparedPackage
      ? {
          prPackage: preparedPackage,
          reviewDepth,
          independentReviews,
          gatePolicy: preparedPackage.gatePolicy,
          validationSummary: preparedPackage.validationSummaryPath ?? undefined,
          publicationTarget: preparedPackage.publicationTarget,
          publicationStatus: publicationStatusForRun(current),
          stale: staleReviewCount > 0,
        }
      : {}),
  };

  const actionId = await createEngineDecision(runId, 'human_gate', desc, actions, readyPayload);

  const afterDecisionRun = getRun(runId)!;
  const decision = latestResolvedHumanGateDecision(afterDecisionRun.decisions);
  const selectionData = decision?.selectionData;
  if (publicationApprovalGate) {
    const decisionPayload = decision?.payload as ReadyGatePayload | undefined;
    const approvedPackage = decisionPayload?.prPackage ?? preparedPackage;
    if (actionId === 'approve-publish' || actionId === 'ready') {
      if (!approvedPackage) throw new Error('Publication approval requires a prepared package');
      validatePackageApprovalSelection(approvedPackage, decision);
      assertPublicationReviewPolicySatisfied(getRun(runId)!, approvedPackage);
    }
    const target =
      selectionData?.publicationTarget === 'ready'
        ? 'ready'
        : selectionData?.publicationTarget === 'draft'
          ? 'draft'
          : (approvedPackage?.publicationTarget ?? 'ready');
    const reviewRequest =
      selectionData?.reviewRequest && typeof selectionData.reviewRequest === 'object'
        ? (selectionData.reviewRequest as Record<string, unknown>)
        : {};
    const selectedPlan = reviewPlanFromSelection(selectionData);
    const requestRequiresCrossRunner = reviewRequest.requireCrossRunner === true;
    const requestedPlan: ReviewLoopRequest[] =
      actionId === 'request-cross-runner-review' &&
      !selectedPlan.some((loop) => effectiveReviewRunner(loop))
        ? [
            {
              order: 1,
              runner: defaultAlternateReviewRunner(
                current.metrics.runner,
              ) as ReviewLoopRequest['runner'],
              validationDepth: 'full-live' as const,
            },
          ]
        : selectedPlan;
    const loopsToAdd =
      actionId === 'request-cross-runner-review'
        ? Math.max(1, requestedPlan.length)
        : requestedReviewLoopCount(reviewRequest, requestedPlan.length);
    const reviewRequestConsumed = markResolvedHumanGateReviewRequestConsumed(decision);
    const baseReviewDepth = publicationReviewPolicyForRun(current, pv?.projectJson);
    const patch =
      actionId === 'request-extra-review' || actionId === 'request-cross-runner-review'
        ? {
            reviewDepth: humanGateReviewDepth(
              baseReviewDepth,
              { ...reviewRequest, requireCrossRunner: requestRequiresCrossRunner },
              { actionId, fallbackLoopCount: loopsToAdd },
            ),
            pendingReviewPlan: requestedPlan,
          }
        : {};
    updateRun(runId, {
      ...(reviewRequestConsumed ? { decisions: afterDecisionRun.decisions } : {}),
      engineState: {
        ...afterDecisionRun.engineState,
        publishGate: {
          ...afterDecisionRun.engineState?.publishGate,
          publicationTarget: target,
          ...(actionId === 'approve-publish' || actionId === 'ready'
            ? {
                approvedPackageHash: approvedPackage?.packageHash,
                approvedAt: new Date().toISOString(),
                publicationStatus: 'pending_publish' as const,
              }
            : { publicationStatus: 'not_published' as const }),
          ...patch,
        },
      },
    });
    if (actionId !== 'approve-publish' && actionId !== 'ready') {
      await persistGateFeedback(afterDecisionRun, actionId, selectionData);
    }
  }

  // DNM removal and comment posting moved to finalize step for visibility
  console.log(`[run-engine] run ${runId.slice(0, 8)} — gate resolved: ${actionId}`);
  return actionId;
}
