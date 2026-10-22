// review-gate.ts — Review-posting gate orchestration and refresh
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type ArtifactRef,
  DEFAULT_TASK_DIR,
  Events,
  type EvidenceQualityVerdict,
  parseGitHubRef,
  PipelineSteps,
  type ReviewDiffSnapshot,
  type ReviewGatePayload,
  reviewPostingFingerprint,
  type ReviewViewedFilesResult,
  type Run,
  selectReviewFindings,
} from '@farmslot/protocol';
import { ReviewApprovalPolicyError } from '@farmslot/protocol/review-approval-policy.cjs';

import { farmslotRoot, getProjectField, resolveProjectTaskDirName } from '../core/config.js';
import { fetchGitHubPR, fetchPRDiffFiles } from '../external/github.js';
import { ghRequest } from '../integrations/github-client.js';
import { findPRNumber, persistRunPrNumber } from '../integrations/pr-linkage.js';
import { auditEvidenceQuality } from '../intelligence/engine.js';
import { resolveDefaultPublicationAccount } from '../pr-monitoring/github-account.js';
import { loadRecipeQualityEvaluation } from '../quality/recipe-quality.js';
import { assertReviewCommentLines } from '../review-publication/validate-comments.js';
import {
  markReviewedFilesViewed,
  retainViewedFilesResult,
} from '../review-publication/viewed-files.js';
import { readReviewWorkspaceCompletion } from '../review-workspaces/task.js';
import {
  assertCaptionConfidence,
  autoDetectEvidenceManifest,
  buildEvidenceSection,
  collectLowCaptions,
  EvidenceCaptionError,
  extractAndPersistSessionCost,
  type LowCaption,
  readEvidenceManifest,
  type SessionCostSnapshot,
  uploadArtifacts,
} from '../run-completion/orchestrator.js';
import { retainedRunArtifactManifest } from '../run-completion/retained-artifacts.js';
import { getRun, persistRunNow, updateRun, updateRunStep } from '../runs/store.js';
import {
  ACCEPTANCE_STATUS_FILENAME,
  acceptanceCoverageMarkdown,
  ledgerFromArtifactText,
} from '../tasks/acceptance-status.js';

import { findLatestResolvedDecision } from './decision-replay.js';
import { captureReviewInputArtifactsForRun, readReviewInputSnapshot } from './diff-artifacts.js';
import { createEngineDecision } from './engine-decisions.js';
import { BlockedRunError } from './errors.js';
import { isOwnPrApprovalError } from './gate-policy.js';
import { refreshRunGateReadiness } from './gate-prerequisites.js';
import { loadProjectVarsOrNull } from './project-vars.js';
import { copyWorkerArtifacts, readReviewArtifacts } from './review-artifacts.js';
import { completedReviewSessionTrace } from './review-result.js';
import { runSupersededSince } from './run-generation.js';
import { readTaskArtifactText } from './task-artifacts.js';
type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};

const S = PipelineSteps;

export function setReviewGateBroadcast(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

export function shouldIncludeReviewEvidence(selectionData?: Record<string, unknown>): boolean {
  return selectionData?.includeEvidence !== false;
}

export function reviewEvidencePostArgs(
  selectionData: Record<string, unknown> | undefined,
  evidenceTmpFile: string | null,
): string[] {
  return evidenceTmpFile && shouldIncludeReviewEvidence(selectionData)
    ? ['--evidence-md-file', evidenceTmpFile]
    : [];
}

export function assertReviewSnapshotMatchesPullRequest(
  reviewSnapshot: ReviewDiffSnapshot | undefined,
  liveHeadSha: string | null | undefined,
): asserts reviewSnapshot is ReviewDiffSnapshot & { headSha: string } {
  if (!reviewSnapshot?.headSha || reviewSnapshot.source === 'unavailable') {
    throw new BlockedRunError(
      'Review snapshot is unavailable; refresh/rerun review before posting.',
      'stale-review',
    );
  }
  if (!liveHeadSha || liveHeadSha !== reviewSnapshot.headSha) {
    throw new BlockedRunError(
      `Review is stale: reviewed ${reviewSnapshot.headSha.slice(0, 7)}, current PR head is ${liveHeadSha?.slice(0, 7) ?? 'unavailable'}. Refresh/rerun review before posting.`,
      'stale-review',
    );
  }
}

export async function publishPinnedReview({
  reviewedHeadSha,
  postFormalReview,
  postInlineComments,
  fetchCurrentHeadSha,
  onHeadAdvanced,
}: {
  reviewedHeadSha: string;
  postFormalReview: (commitId: string) => Promise<void>;
  postInlineComments: (commitId: string) => Promise<void>;
  fetchCurrentHeadSha: () => Promise<string | null | undefined>;
  onHeadAdvanced: (currentHeadSha: string | null | undefined) => void;
}): Promise<void> {
  await postFormalReview(reviewedHeadSha);
  await postInlineComments(reviewedHeadSha);
  const currentHeadSha = await fetchCurrentHeadSha();
  if (currentHeadSha !== reviewedHeadSha) onHeadAdvanced(currentHeadSha);
}

export async function executeReviewGate(runId: string): Promise<void> {
  const current = getRun(runId)!;
  const generation = current.engineState?.generation ?? 0;

  // 1. Copy artifacts from worker
  await copyWorkerArtifacts(runId);

  // 2. Read review artifacts
  const review = await readReviewArtifacts(runId);

  // 3. Find PR number + CI repo
  const pv = await loadProjectVarsOrNull(current.project, 'run step', current.id);
  const ciRepo = pv?.projectJson ? getProjectField(pv.projectJson, 'ci.repo') || null : null;
  const prNumber = ciRepo ? await findPRNumber(current, ciRepo) : null;
  let reviewInputArtifactPaths: string[] = [];
  let reviewSnapshot: ReviewDiffSnapshot | undefined;
  let reviewInputSnapshot = await readReviewInputSnapshot(current.taskFile);
  if (prNumber) {
    await persistRunPrNumber(runId, prNumber);
    // The task writer freezes the exact PR input before dispatch. Reuse that
    // immutable snapshot at the gate; recapturing here would silently move the
    // operator decision to a newer PR head the worker never reviewed.
    if (!reviewInputSnapshot.snapshot || reviewInputSnapshot.snapshot.source === 'unavailable') {
      reviewInputArtifactPaths = await captureReviewInputArtifactsForRun(getRun(runId)!).then(
        (artifacts) => artifacts.map((artifact) => artifact.path),
      );
      reviewInputSnapshot = await readReviewInputSnapshot(
        getRun(runId)?.taskFile ?? current.taskFile,
      );
    }
  }
  reviewInputArtifactPaths = [
    ...new Set([...reviewInputArtifactPaths, ...reviewInputSnapshot.artifactPaths]),
  ];
  reviewSnapshot = reviewInputSnapshot.snapshot;
  if (review.hasReview) {
    if (review.lineComments.length) {
      if (!reviewSnapshot) throw new Error('Review diff identity is unavailable');
      await assertReviewCommentLines(current, review.lineComments, reviewSnapshot);
    }
  }

  // 3b. Upload artifacts and build evidence (non-fatal)
  let reviewArtifactUrls = new Map<string, string>();
  let evidenceMarkdown: string | null = null;
  let artifactManifest: ArtifactRef[] = [];

  if (prNumber && current.taskFile) {
    try {
      reviewArtifactUrls = await uploadArtifacts(getRun(runId)!, prNumber);
      console.log(
        `[run-engine] run ${runId.slice(0, 8)} — uploaded ${reviewArtifactUrls.size} review artifact(s)`,
      );
    } catch (err) {
      console.warn(
        `[run-engine] review artifact upload failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  if (current.taskFile) {
    try {
      artifactManifest = await retainedRunArtifactManifest(getRun(runId)!);
    } catch (err) {
      // Review posting can continue without a refreshed manifest, but the
      // failure must stay visible because missing evidence is actionable.
      console.warn(
        `[run-engine] review artifact scan failed for ${runId.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }

  let lowCaptions: LowCaption[] = [];
  if (reviewArtifactUrls.size > 0) {
    try {
      const manifest =
        (await readEvidenceManifest(getRun(runId)!)) ??
        autoDetectEvidenceManifest(reviewArtifactUrls);
      if (manifest) {
        lowCaptions = collectLowCaptions(manifest);
        try {
          assertCaptionConfidence(manifest);
          evidenceMarkdown = buildEvidenceSection(manifest, reviewArtifactUrls);
        } catch (err) {
          if (err instanceof EvidenceCaptionError) {
            console.warn(`[run-engine] evidence gate blocked posting: ${err.message}`);
            evidenceMarkdown = null;
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      // Missing evidenceMarkdown only suppresses auto-comment evidence; keep
      // the review gate alive and log the builder failure for diagnosis.
      console.warn(
        `[run-engine] evidence section build failed for ${runId.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }

  const recipeJson = await readTaskArtifactText(current, 'recipe.json');
  // Coverage is a structured engine projection; worker prose is not a verdict.
  const recipeCoverage = acceptanceCoverageMarkdown(
    ledgerFromArtifactText(await readTaskArtifactText(current, ACCEPTANCE_STATUS_FILENAME)),
  );
  const workerReport = await readTaskArtifactText(current, 'report.md');
  const workerLearnings = await readTaskArtifactText(current, 'learnings.md');

  // 3e. Phase 2 evidence quality audit (non-fatal)
  let qualityReport: import('@farmslot/protocol').EvidenceQualityReport | null = null;
  if (current.taskFile && current.flowType === 'review-pr') {
    try {
      const manifest =
        (await readEvidenceManifest(getRun(runId)!)) ??
        autoDetectEvidenceManifest(reviewArtifactUrls);
      if (manifest) {
        const prRef = parseGitHubRef(current.ticketOrPr);
        const diffFiles = prRef ? await fetchPRDiffFiles(prRef.repo, prRef.number) : [];
        const acs = current.ticketData?.acceptanceCriteria ?? [];
        const auditResult = await auditEvidenceQuality(manifest, diffFiles, acs);
        qualityReport = auditResult.report;
        if (qualityReport) {
          console.log(
            `[run-engine] evidence audit for ${runId.slice(0, 8)}: score=${qualityReport.overallScore}, verdicts=${qualityReport.acVerdicts.length}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[run-engine] evidence quality audit failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  // 4. Create blocking decision
  const baseDesc = review.summary
    ? `**Recommendation:** ${review.recommendation}\n**Line comments:** ${review.lineCommentSummary}\n\n${review.summary}`
    : 'Worker finished but no review.md artifact found.';
  const captionWarning =
    lowCaptions.length > 0
      ? `\n\n⚠ **Evidence gate: ${lowCaptions.length} low-confidence caption(s) — evidence section will NOT be posted.**\n` +
        lowCaptions
          .map((lc) => `- \`${lc.label}\`${lc.file ? ` (\`${lc.file}\`)` : ''} — ${lc.reason}`)
          .join('\n')
      : '';
  const desc = baseDesc + captionWarning;

  const actions = reviewPostingActions(review.reviewMd);

  const reviewPayload: ReviewGatePayload = {
    kind: 'review',
    prNumber,
    repo: ciRepo,
    baseRef:
      reviewSnapshot?.baseRef ??
      (pv?.projectJson ? getProjectField(pv.projectJson, 'default_branch') || 'main' : 'main'),
    recommendation: review.recommendation,
    reviewMd: review.reviewMd,
    lineComments: review.lineComments,
    artifactManifest: artifactManifest.length > 0 ? artifactManifest : undefined,
    artifactUrls: reviewArtifactUrls.size > 0 ? Object.fromEntries(reviewArtifactUrls) : undefined,
    reviewSnapshot,
    session: await completedReviewSessionTrace(getRun(runId)!, reviewSnapshot),
    reviewInputArtifactPaths: reviewInputArtifactPaths.length
      ? reviewInputArtifactPaths
      : undefined,
    evidenceMarkdown: evidenceMarkdown ?? undefined,
    recipeJson,
    recipeQualityArtifact: (
      await loadRecipeQualityEvaluation({ run: current, workerReport, recipeJson, recipeCoverage })
    ).artifact,
    qualityReport,
    workerLearnings,
  };

  const actionId = await createEngineDecision(
    runId,
    'review_posting',
    desc,
    actions,
    reviewPayload,
  );
  if (actionId === 'abort' || runSupersededSince(getRun(runId), generation)) return;
  const resolvedDecision = findLatestResolvedDecision(getRun(runId)!.decisions, 'review_posting');
  // Capture fingerprinted fields before subsequent awaits or worker artifact reads.
  const acceptedPayload = structuredClone(
    (resolvedDecision?.payload ?? reviewPayload) as ReviewGatePayload,
  );
  const acceptedSelection = structuredClone(resolvedDecision?.selectionData ?? {});
  const acceptedReview =
    actionId === 'post'
      ? selectReviewFindings(acceptedPayload, acceptedSelection)
      : acceptedPayload;
  const acceptedSnapshot = acceptedPayload.reviewSnapshot;

  // 5b. Persist evidence overrides from selectionData (if any)
  if (qualityReport) {
    const overrides = resolvedDecision?.selectionData?.evidenceOverrides as
      | Record<string, string>
      | undefined;
    if (overrides && Object.keys(overrides).length > 0) {
      qualityReport.overrides = Object.entries(overrides).map(([ac, humanVerdict]) => {
        const original = qualityReport!.acVerdicts.find((v) => v.ac === ac);
        return {
          ac,
          humanVerdict: humanVerdict as EvidenceQualityVerdict,
          llmVerdict: (original?.verdict ?? 'MISSING') as EvidenceQualityVerdict,
          overriddenAt: new Date().toISOString(),
        };
      });
      // Update the decision payload so overrides are queryable from run history
      if (resolvedDecision?.payload) {
        (resolvedDecision.payload as ReviewGatePayload).qualityReport = qualityReport;
        updateRun(runId, { decisions: getRun(runId)!.decisions });
      }
      console.log(
        `[run-engine] evidence overrides for ${runId.slice(0, 8)}: ${qualityReport.overrides.length} override(s)`,
      );
    }
  }

  // 6. Execute based on decision
  if (actionId === 'post' && ciRepo && prNumber && current.slotId) {
    updateRunStep(runId, S.HUMAN_GATE, { detail: 'Posting review...' });
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    console.log(`[run-engine] run ${runId.slice(0, 8)} — posting review to PR #${prNumber}`);
    const livePr = await fetchGitHubPR(`${ciRepo}#${prNumber}`);
    try {
      assertReviewSnapshotMatchesPullRequest(acceptedSnapshot, livePr.headSha);
    } catch (err) {
      if (err instanceof BlockedRunError) {
        const latest = getRun(runId)!;
        updateRun(runId, {
          decisions: latest.decisions.map((decision) => {
            if (decision.type !== 'engine_review_posting' || decision.id !== resolvedDecision?.id)
              return decision;
            return {
              ...decision,
              payload: {
                ...((decision.payload ?? {}) as ReviewGatePayload),
                stale: true,
              },
            };
          }),
        });
      }
      throw err;
    }
    const taskRelDir = current.taskFile?.includes('/tasks/')
      ? current.taskFile.split('/tasks/')[1].replace('/TASK.md', '')
      : null;
    const taskDirName = pv?.projectJson
      ? resolveProjectTaskDirName(pv.projectJson)
      : DEFAULT_TASK_DIR;
    const overrideRec = acceptedReview.recommendation;

    const includeInternalMetrics =
      pv?.projectJson.ci?.include_internal_metrics_in_pr_comments === true;
    // Completion persists internal metrics later. Resolve them here only when
    // this project explicitly includes them in its formal review comment.
    const costSnapshot: Pick<SessionCostSnapshot, 'costUsd' | 'totalTokens'> =
      includeInternalMetrics
        ? await extractAndPersistSessionCost(runId)
        : { costUsd: null, totalTokens: null };
    const runner = includeInternalMetrics ? current.metrics.runner?.trim() : undefined;
    const model = includeInternalMetrics ? current.metrics.model?.trim() : undefined;

    // Inline the visual evidence into the main comment body (was posted as a separate follow-up comment).
    let evidenceTmpFile: string | null = null;
    if (evidenceMarkdown && shouldIncludeReviewEvidence(resolvedDecision?.selectionData)) {
      evidenceTmpFile = `/tmp/farmslot-review-evidence-${runId.slice(0, 8)}.md`;
      const { writeFile: writeF } = await import('node:fs/promises');
      await writeF(evidenceTmpFile, evidenceMarkdown, 'utf-8');
    }

    const commentsToPost = acceptedReview.lineComments;
    let publicationAccount:
      | Awaited<ReturnType<typeof resolveDefaultPublicationAccount>>
      | undefined;
    try {
      publicationAccount = await resolveDefaultPublicationAccount(
        current.createdByPrincipalId ?? runId,
      );
    } catch {
      // Viewed is optional. An unavailable credential snapshot preserves the existing poster.
      publicationAccount = undefined;
    }
    const saveViewedFiles = async (viewedFiles: ReviewViewedFilesResult) => {
      const latest = getRun(runId);
      if (!latest || !resolvedDecision) throw new Error('Review gate is unavailable');
      const updated = updateRun(runId, {
        decisions: latest.decisions.map((decision) =>
          decision.id === resolvedDecision.id
            ? { ...decision, payload: { ...(decision.payload as ReviewGatePayload), viewedFiles } }
            : decision,
        ),
      });
      await persistRunNow(updated, 'review Viewed diagnostic');
    };
    const reviewInputDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-accepted-review-'));
    const reviewInputFile = path.join(reviewInputDir, 'review.json');
    try {
      await writeFile(
        reviewInputFile,
        JSON.stringify({
          reviewMd: acceptedReview.reviewMd,
          recommendation: acceptedReview.recommendation,
          comments: commentsToPost,
        }),
        { mode: 0o600 },
      );
      await publishPinnedReview({
        reviewedHeadSha: acceptedSnapshot.headSha,
        postFormalReview: async (commitId) => {
          // The gateway owns session metrics, artifact upload, and archival. Use
          // argv so run metadata cannot break out of shell quoting.
          const postReviewArgs: string[] = [
            `${farmslotRoot}/scripts/post-review.sh`,
            '--run-id',
            runId,
            '--pr',
            String(prNumber),
            '--repo',
            ciRepo,
            '--commit-id',
            commitId,
            '--slot',
            current.slotId!,
            '--review-input-file',
            reviewInputFile,
            '--skip-session-usage',
            '--skip-artifact-upload',
            '--skip-archive',
          ];
          if (taskRelDir) postReviewArgs.push('--task-dir', `${taskDirName}/${taskRelDir}`);
          if (overrideRec) postReviewArgs.push('--recommendation', overrideRec);
          if (runner) postReviewArgs.push('--runner', runner);
          if (model) postReviewArgs.push('--model', model);
          if (typeof costSnapshot.costUsd === 'number')
            postReviewArgs.push('--cost', costSnapshot.costUsd.toFixed(4));
          if (typeof costSnapshot.totalTokens === 'number')
            postReviewArgs.push('--total-tokens', String(costSnapshot.totalTokens));
          if (includeInternalMetrics) postReviewArgs.push('--include-internal-metrics');
          postReviewArgs.push(
            ...reviewEvidencePostArgs(resolvedDecision?.selectionData, evidenceTmpFile),
          );

          try {
            const { execFile } = await import('node:child_process');
            await new Promise<void>((resolve, reject) => {
              execFile(
                'bash',
                postReviewArgs,
                {
                  timeout: 120_000,
                  maxBuffer: 10 * 1024 * 1024,
                  env: publicationAccount
                    ? {
                        ...process.env,
                        GH_HOST: publicationAccount.binding.host,
                        GITHUB_TOKEN: publicationAccount.binding.token,
                      }
                    : process.env,
                },
                (err, stdout, stderr) => {
                  if (err) reject(Object.assign(err, { stdout, stderr }));
                  else resolve();
                },
              );
            });
          } catch (err) {
            if (!isOwnPrApprovalError(err)) throw err;
            console.warn(
              `[run-engine] run ${runId.slice(0, 8)} — formal approval skipped: ${(err as Error).message.split('\n')[0]}`,
            );
            updateRunStep(runId, S.HUMAN_GATE, {
              detail:
                'Review comment posted; formal approval skipped (author cannot approve own PR)',
            });
            broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
          } finally {
            if (evidenceTmpFile) await rm(evidenceTmpFile, { force: true });
          }
        },
        postInlineComments: async (commitId) => {
          if (commentsToPost.length === 0) return;
          updateRunStep(runId, S.HUMAN_GATE, {
            detail: `Posting comments 0/${commentsToPost.length}...`,
          });
          broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
          let posted = 0;
          for (const c of commentsToPost) {
            const sev = c.severity ?? 'comment';
            const prefix: Record<string, string> = {
              must_fix: '**must fix** — ',
              suggestion: '**suggestion** — ',
              nitpick: '*nitpick* — ',
            };
            const body = (prefix[sev] ?? '') + (c.body ?? '');
            try {
              await ghRequest(
                [
                  'api',
                  `repos/${ciRepo}/pulls/${prNumber}/comments`,
                  '-X',
                  'POST',
                  '-f',
                  `body=${body}`,
                  '-f',
                  `commit_id=${commitId}`,
                  '-f',
                  `path=${c.path}`,
                  '-F',
                  `line=${c.line}`,
                  '-f',
                  'side=RIGHT',
                ],
                { force: true, account: publicationAccount?.binding },
              );
              posted++;
              updateRunStep(runId, S.HUMAN_GATE, {
                detail: `Posting comments ${posted}/${commentsToPost.length}...`,
              });
              broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
            } catch (err) {
              console.warn(
                `[run-engine] line comment failed: ${c.path}:${c.line} — ${(err as Error).message.slice(0, 120)}`,
              );
            }
          }
          console.log(
            `[run-engine] run ${runId.slice(0, 8)} — posted ${posted}/${commentsToPost.length} line comments`,
          );
          updateRunStep(runId, S.HUMAN_GATE, { detail: `Posted ${posted} comments` });
          broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
        },
        fetchCurrentHeadSha: async () => (await fetchGitHubPR(`${ciRepo}#${prNumber}`)).headSha,
        onHeadAdvanced: (currentHeadSha) => {
          console.warn(
            `[run-engine] run ${runId.slice(0, 8)} — review posted for ${acceptedSnapshot.headSha.slice(0, 7)}, but PR advanced to ${currentHeadSha?.slice(0, 7) ?? 'unknown'}`,
          );
        },
      });
      if (publicationAccount) {
        await markReviewedFilesViewed(
          {
            pr: { host: 'github.com', repo: ciRepo, number: prNumber },
            headSha: acceptedSnapshot.headSha,
            ...publicationAccount,
          },
          saveViewedFiles,
        );
      } else {
        await retainViewedFilesResult(
          {
            headSha: acceptedSnapshot.headSha,
            attemptedAt: new Date().toISOString(),
            state: 'skipped',
            paths: [],
            markedPaths: [],
            reason: 'Publication credential could not be frozen; Viewed marks were not attempted',
          },
          saveViewedFiles,
        );
      }
    } finally {
      await rm(reviewInputDir, { recursive: true, force: true });
      if (evidenceTmpFile) await rm(evidenceTmpFile, { force: true });
    }

    console.log(`[run-engine] run ${runId.slice(0, 8)} — review posted`);
  } else {
    updateRunStep(runId, S.HUMAN_GATE, { detail: 'Dismissed' });
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    console.log(`[run-engine] run ${runId.slice(0, 8)} — review dismissed`);
  }
}

/**
 * Re-read review artifacts from the worker and patch the pending review_posting
 * decision in place. Used when the worker revises review.md / line-comments.json
 * after the gate has already opened. Preserves the decision id so UI-side
 * selection state (comment inclusion, recommendation override, evidence
 * overrides) stays intact.
 */
export async function refreshReviewGate(runId: string): Promise<Run> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const decision = [...run.decisions]
    .reverse()
    .find((d) => d.type === 'engine_review_posting' && !d.resolvedAt);
  if (!decision) {
    throw new Error('No pending review_posting decision to refresh');
  }

  const startingFingerprint = reviewPostingFingerprint(decision.payload as ReviewGatePayload);
  const freshTarget = () => {
    const fresh = getRun(runId);
    const current = fresh?.decisions.find((item) => item.id === decision.id);
    if (
      !fresh ||
      !current ||
      current.resolvedAt ||
      current.payload?.kind !== 'review' ||
      reviewPostingFingerprint(current.payload) !== startingFingerprint
    )
      throw Object.assign(new Error('Review changed during refresh.'), { code: 'REVIEW_CHANGED' });
    return { run: fresh, decision: current };
  };
  const invalidateApproval = async (error: unknown): Promise<never> => {
    if (error instanceof ReviewApprovalPolicyError) {
      const target = freshTarget();
      const actions = reviewPostingActions(null);
      const invalidated = updateRun(runId, {
        reviewResult: undefined,
        decisions: target.run.decisions.map((entry) =>
          entry.id === decision.id
            ? {
                ...entry,
                payload: {
                  ...(entry.payload as ReviewGatePayload),
                  recommendation:
                    error.recommendation === 'APPROVE' ? 'COMMENT' : error.recommendation,
                },
                description: `${error.message}. Correct the updated review result before publication.`,
                actions,
                context: { ...entry.context, gateActions: actions },
              }
            : entry,
        ),
      });
      const evaluated = await refreshRunGateReadiness(invalidated);
      await persistRunNow(evaluated, 'invalidate stale review approval');
      broadcastFn(Events.RUN_UPDATED, { run: evaluated });
    }
    throw error;
  };
  if (run.reviewWorkspace) {
    const completion = await readReviewWorkspaceCompletion(runId).catch(invalidateApproval);
    if (!completion?.result || completion.signal.outcome !== 'success')
      throw new Error('Reviewer has not finished its updated result');
    const target = freshTarget();
    const result = completion.result;
    const actions = reviewPostingActions(result.reviewMd);
    const refreshed = updateRun(runId, {
      reviewResult: result,
      decisions: target.run.decisions.map((entry) =>
        entry.id === decision.id
          ? {
              ...entry,
              payload: { ...(entry.payload as ReviewGatePayload), ...result },
              description: `**Recommendation:** ${result.recommendation}`,
              actions,
              context: { ...entry.context, gateActions: actions },
            }
          : entry,
      ),
    });
    const evaluated = await refreshRunGateReadiness(refreshed);
    await persistRunNow(evaluated, 'refresh workspace review gate');
    broadcastFn(Events.RUN_UPDATED, { run: evaluated });
    return evaluated;
  }
  await copyWorkerArtifacts(runId);
  const review = await readReviewArtifacts(runId).catch(invalidateApproval);
  try {
    if (review.lineComments.length) {
      const snapshot = (decision.payload as ReviewGatePayload).reviewSnapshot;
      if (!snapshot) throw new Error('Review diff identity is unavailable');
      await assertReviewCommentLines(run, review.lineComments, snapshot);
    }
  } catch (error) {
    return invalidateApproval(error);
  }
  const workerLearnings = await readTaskArtifactText(run, 'learnings.md');

  let artifactManifest: ArtifactRef[] | undefined;
  if (run.taskFile) {
    try {
      // Project the fresh capture, including media deliberately removed from acquisition staging.
      artifactManifest = await retainedRunArtifactManifest(getRun(runId)!);
    } catch (err) {
      // Recovery is intentional: refresh continues with the previously
      // persisted manifest (no rescan applied). But surface the failure
      // so operators can diagnose evidence-refresh problems instead of
      // hunting through silent stale state.
      console.warn(
        `[run-engine] refreshReviewGate: artifact rescan failed for ${runId.slice(0, 8)} at ${path.dirname(run.taskFile)}: ${(err as Error).message}`,
      );
    }
  }

  const target = freshTarget();
  const nextPayload: ReviewGatePayload = {
    ...((target.decision.payload ?? {}) as ReviewGatePayload),
    reviewMd: review.reviewMd,
    lineComments: review.lineComments,
    recommendation: review.recommendation,
    workerLearnings,
    ...(artifactManifest ? { artifactManifest } : {}),
  };
  const nextDescription = `**Recommendation:** ${review.recommendation}\n**Line comments:** ${review.lineCommentSummary}\n\n${review.summary}`;
  const nextDecision = {
    ...target.decision,
    payload: nextPayload,
    description: nextDescription,
    actions: reviewPostingActions(review.reviewMd),
    context: { ...decision.context, gateActions: reviewPostingActions(review.reviewMd) },
  };
  const nextDecisions = target.run.decisions.map((d) => (d.id === decision.id ? nextDecision : d));

  const evaluated = await refreshRunGateReadiness(
    updateRun(runId, {
      decisions: nextDecisions,
      reviewResult: {
        ...target.run.reviewResult,
        recommendation: review.recommendation,
        reviewMd: review.reviewMd,
        lineComments: review.lineComments,
        reviewSnapshot: nextPayload.reviewSnapshot,
        ...(artifactManifest ? { artifactManifest } : {}),
      },
    }),
  );
  await persistRunNow(evaluated, 'refresh primary review gate');
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — review gate refreshed (rec=${review.recommendation}, comments=${review.lineComments.length})`,
  );

  return evaluated;
}

export function reviewPostingActions(
  reviewMd: string | null | undefined,
): Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }> {
  return [
    ...(reviewMd?.trim() ? [{ id: 'post', label: 'Post to PR', style: 'primary' as const }] : []),
    { id: 'dismiss', label: 'Dismiss', style: 'secondary' as const },
  ];
}
