// review-gate.ts — Review-posting gate orchestration and refresh

import { rm } from 'node:fs/promises';
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
  type Run,
} from '@farmslot/protocol';

import { farmslotRoot, getProjectField, resolveProjectTaskDirName } from '../core/config.js';
import { fetchGitHubPR, fetchPRDiffFiles } from '../external/github.js';
import { ghRequest } from '../integrations/github-client.js';
import { findPRNumber, persistRunPrNumber } from '../integrations/pr-linkage.js';
import { auditEvidenceQuality } from '../intelligence/engine.js';
import { loadRecipeQualityEvaluation } from '../quality/recipe-quality.js';
import {
  assertCaptionConfidence,
  autoDetectEvidenceManifest,
  buildEvidenceSection,
  collectLowCaptions,
  EvidenceCaptionError,
  extractAndPersistSessionCost,
  type LowCaption,
  readEvidenceManifest,
  scanArtifacts,
  uploadArtifacts,
} from '../run-completion/orchestrator.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';

import { captureReviewInputArtifactsForRun, readReviewInputSnapshot } from './diff-artifacts.js';
import { createEngineDecision } from './engine-decisions.js';
import { BlockedRunError } from './errors.js';
import { isOwnPrApprovalError } from './gate-policy.js';
import { loadProjectVarsOrNull } from './project-vars.js';
import { copyWorkerArtifacts, readReviewArtifacts } from './review-artifacts.js';
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

export async function executeReviewGate(runId: string): Promise<void> {
  const current = getRun(runId)!;

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
  if (prNumber) {
    await persistRunPrNumber(runId, prNumber);
    reviewInputArtifactPaths = await captureReviewInputArtifactsForRun(getRun(runId)!).then(
      (artifacts) => artifacts.map((artifact) => artifact.path),
    );
  }
  const reviewInputSnapshot = await readReviewInputSnapshot(
    getRun(runId)?.taskFile ?? current.taskFile,
  );
  reviewInputArtifactPaths = [
    ...new Set([...reviewInputArtifactPaths, ...reviewInputSnapshot.artifactPaths]),
  ];
  reviewSnapshot = reviewInputSnapshot.snapshot;

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
      const taskDir = path.dirname(current.taskFile);
      artifactManifest = await scanArtifacts(taskDir);
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

  const recipeJson = await readTaskArtifactText(current.taskFile, 'recipe.json');
  const recipeCoverage = await readTaskArtifactText(current.taskFile, 'recipe-coverage.md');
  const workerReport = await readTaskArtifactText(current.taskFile, 'report.md');
  const workerLearnings = await readTaskArtifactText(current.taskFile, 'learnings.md');

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

  const actions: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }> = [
    { id: 'post', label: 'Post to PR', style: 'primary' },
    { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
  ];

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

  // 5b. Persist evidence overrides from selectionData (if any)
  if (qualityReport) {
    const resolvedDecision = getRun(runId)!.decisions.find(
      (d) => d.type === 'engine_review_posting' && d.resolvedAt,
    );
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
      assertReviewSnapshotMatchesPullRequest(reviewSnapshot, livePr.headSha);
    } catch (err) {
      if (err instanceof BlockedRunError) {
        const latest = getRun(runId)!;
        updateRun(runId, {
          decisions: latest.decisions.map((decision) => {
            if (
              decision.type !== 'engine_review_posting' ||
              decision.id !==
                latest.decisions.find(
                  (d) => d.type === 'engine_review_posting' && d.resolvedAction === 'post',
                )?.id
            )
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
    const resolvedDecision = current.decisions.find(
      (d) => d.type === 'engine_review_posting' && d.resolvedAction === 'post',
    );
    const overrideRec = resolvedDecision?.selectionData?.recommendation as string | undefined;

    // Populate Runner / Model / Cost / Tokens fields in the comment header.
    // session-usage.sh needs RUNNER_SESSION_PATH from run.metrics — the script on its own can't resolve it.
    const costSnapshot = await extractAndPersistSessionCost(runId);
    const runner = current.metrics.runner?.trim();
    const model = current.metrics.model?.trim();

    // Inline the visual evidence into the main comment body (was posted as a separate follow-up comment).
    let evidenceTmpFile: string | null = null;
    if (evidenceMarkdown && shouldIncludeReviewEvidence(resolvedDecision?.selectionData)) {
      evidenceTmpFile = `/tmp/farmslot-review-evidence-${runId.slice(0, 8)}.md`;
      const { writeFile: writeF } = await import('node:fs/promises');
      await writeF(evidenceTmpFile, evidenceMarkdown, 'utf-8');
    }

    // The gateway already owns session metrics, artifact upload, and local artifact
    // archival. Tell the standalone script not to repeat those remote-heavy phases.
    // Use execFile with an argv array so user-supplied run metadata (runner/model)
    // can't break out of shell quoting.
    const postReviewArgs: string[] = [
      `${farmslotRoot}/scripts/post-review.sh`,
      '--run-id',
      runId,
      '--pr',
      String(prNumber),
      '--repo',
      ciRepo,
      '--commit-id',
      reviewSnapshot.headSha,
      '--slot',
      current.slotId!,
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
    postReviewArgs.push(
      ...reviewEvidencePostArgs(resolvedDecision?.selectionData, evidenceTmpFile),
    );

    try {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile(
          'bash',
          postReviewArgs,
          { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              reject(Object.assign(err, { stdout, stderr }));
            } else {
              resolve();
            }
          },
        );
      });
    } catch (err) {
      if (!isOwnPrApprovalError(err)) throw err;

      // GitHub rejects a formal APPROVE from the PR author. post-review.sh
      // reaches that call only after posting the full review comment, so the
      // review run is still successful; only the formal approval event is
      // skipped.
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — formal approval skipped: ${(err as Error).message.split('\n')[0]}`,
      );
      updateRunStep(runId, S.HUMAN_GATE, {
        detail: 'Review comment posted; formal approval skipped (author cannot approve own PR)',
      });
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    } finally {
      if (evidenceTmpFile) {
        await rm(evidenceTmpFile, { force: true });
      }
    }

    // Post inline line comments
    const includedIndices = resolvedDecision?.selectionData?.includedIndices as
      | number[]
      | undefined;
    const allComments = review.lineComments ?? [];
    const commentsToPost = includedIndices
      ? allComments.filter((_: unknown, i: number) => includedIndices.includes(i))
      : allComments;

    if (commentsToPost.length > 0) {
      updateRunStep(runId, S.HUMAN_GATE, {
        detail: `Posting comments 0/${commentsToPost.length}...`,
      });
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
      const headSha = reviewSnapshot.headSha;

      if (headSha) {
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
                `commit_id=${headSha}`,
                '-f',
                `path=${c.path}`,
                '-F',
                `line=${c.line}`,
                '-f',
                'side=RIGHT',
              ],
              { force: true },
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
      }
    }

    // The formal review and inline comments were pinned to the reviewed commit.
    // A concurrent push makes that review outdated, but must not turn the
    // already-successful publication into a replay that double-posts it.
    const confirmedPr = await fetchGitHubPR(`${ciRepo}#${prNumber}`);
    if (confirmedPr.headSha !== reviewSnapshot.headSha) {
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — review posted for ${reviewSnapshot.headSha.slice(0, 7)}, but PR advanced to ${confirmedPr.headSha?.slice(0, 7) ?? 'unknown'}`,
      );
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

  const decision = run.decisions.find((d) => d.type === 'engine_review_posting' && !d.resolvedAt);
  if (!decision) {
    throw new Error('No pending review_posting decision to refresh');
  }

  await copyWorkerArtifacts(runId);
  const review = await readReviewArtifacts(runId);
  const workerLearnings = await readTaskArtifactText(run.taskFile, 'learnings.md');

  let artifactManifest: ArtifactRef[] | undefined;
  if (run.taskFile) {
    try {
      // A successful scan returning [] means evidence was removed since
      // the last refresh — overwrite the manifest with [] rather than
      // leaving the stale entries in place (the spread below preserves
      // them otherwise, and the review UI keeps showing 404s for files
      // that no longer exist).
      artifactManifest = await scanArtifacts(path.dirname(run.taskFile));
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

  const nextPayload: ReviewGatePayload = {
    ...((decision.payload ?? {}) as ReviewGatePayload),
    reviewMd: review.reviewMd,
    lineComments: review.lineComments,
    recommendation: review.recommendation,
    workerLearnings,
    ...(artifactManifest ? { artifactManifest } : {}),
  };
  const nextDescription = review.summary
    ? `**Recommendation:** ${review.recommendation}\n**Line comments:** ${review.lineCommentSummary}\n\n${review.summary}`
    : decision.description;
  const nextDecision = { ...decision, payload: nextPayload, description: nextDescription };
  const nextDecisions = run.decisions.map((d) => (d.id === decision.id ? nextDecision : d));

  updateRun(runId, { decisions: nextDecisions });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — review gate refreshed (rec=${review.recommendation}, comments=${review.lineComments.length})`,
  );

  return getRun(runId)!;
}
