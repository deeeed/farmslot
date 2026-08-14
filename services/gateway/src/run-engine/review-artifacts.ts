import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TASK_DIR, type PlanningContextProjection } from '@farmslot/protocol';

import {
  isGatewayOwnedArtifactMirrorEntry,
  REVIEW_GATE_ARTIFACT_COPY_EXCLUDES,
  WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES,
} from '../core/artifact-copy-policy.js';
import { loadSlotVars, resolveProjectTaskDirName } from '../core/config.js';
import { slotCopyDir, slotCopyFile, slotFileExists, slotListDir } from '../core/slot-io.js';
import { getRun } from '../runs/store.js';
import { buildPlanningContextSection, PLANNING_CONTEXT_INPUT } from '../tasks/planning-context.js';

import { loadProjectVarsOrNull } from './project-vars.js';

export interface ReviewArtifacts {
  recommendation: string;
  summary: string;
  lineCommentSummary: string;
  hasReview: boolean;
  reviewMd: string;
  lineComments: Array<{ path: string; line: number; body: string; severity: string }>;
}

interface ReviewLineCommentArtifact {
  path?: unknown;
  line?: unknown;
  body?: unknown;
  severity?: unknown;
}

interface ReviewLineCommentsArtifact {
  comments?: unknown;
  recommendation?: unknown;
}

function reviewLineCommentsFromArtifact(data: unknown): ReviewLineCommentArtifact[] {
  if (Array.isArray(data)) return data.filter((entry) => entry && typeof entry === 'object');
  if (!data || typeof data !== 'object') return [];
  const comments = (data as ReviewLineCommentsArtifact).comments;
  return Array.isArray(comments)
    ? comments.filter((entry) => entry && typeof entry === 'object')
    : [];
}

function reviewRecommendationFromArtifact(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const recommendation = (data as ReviewLineCommentsArtifact).recommendation;
  return typeof recommendation === 'string' && recommendation.trim()
    ? recommendation.toUpperCase()
    : null;
}

const REVIEW_RECOMMENDATION_RANK: Record<string, number> = {
  APPROVE: 0,
  COMMENT: 1,
  REQUEST_CHANGES: 2,
};

function normalizeReviewRecommendation(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized && normalized in REVIEW_RECOMMENDATION_RANK ? normalized : null;
}

function stricterReviewRecommendation(left: string, right: string): string {
  return REVIEW_RECOMMENDATION_RANK[right] > REVIEW_RECOMMENDATION_RANK[left] ? right : left;
}

export function reviewRecommendationFromMarkdown(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/).map((rawLine) =>
    rawLine
      .replace(/\*\*|__|`/g, '')
      .replace(/^\s*[-+]\s*/, '')
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/^\s*\d+[.)]\s*/, '')
      .trim(),
  );
  for (let index = 0; index < lines.length; index += 1) {
    const inline =
      /^(?:Recommended Action|Recommendation|Verdict)\s*:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\s*[.!]?$/i.exec(
        lines[index],
      );
    if (inline) return inline[1].toUpperCase();
    if (/^(?:Recommended Action|Recommendation|Verdict)\s*:?[.!]?$/i.test(lines[index])) {
      const nextValue = lines.slice(index + 1).find((line) => line.length > 0) ?? '';
      const following = /^(APPROVE|REQUEST_CHANGES|COMMENT)\s*[.!]?$/i.exec(nextValue);
      if (following) return following[1].toUpperCase();
    }
  }
  return null;
}

async function workerGatewayOwnedCopyExcludes(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  workerArtifactsDir: string,
): Promise<string[]> {
  if (!(await slotFileExists(vars, workerArtifactsDir))) return [];
  return (await slotListDir(vars, workerArtifactsDir)).filter(isGatewayOwnedArtifactMirrorEntry);
}

export async function copyWorkerArtifacts(runId: string): Promise<void> {
  const run = getRun(runId)!;
  if (!run.slotId || !run.taskFile) return;

  const vars = await loadSlotVars(run.slotId);
  const taskDir = path.dirname(run.taskFile);
  const taskRelDir = run.taskFile.includes('/tasks/')
    ? run.taskFile.split('/tasks/')[1].replace('/TASK.md', '')
    : null;
  if (!taskRelDir) return;

  const pv = await loadProjectVarsOrNull(run.project, 'worker artifact copy', run.id);
  const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;
  const workerTaskDir = path.join(vars.remoteRepo, taskDirName, taskRelDir);
  const localArtifactsDir = path.join(taskDir, 'artifacts');

  const workerArtifacts = path.join(workerTaskDir, 'artifacts');
  const gatewayOwnedExcludes = await workerGatewayOwnedCopyExcludes(vars, workerArtifacts);
  await slotCopyDir(vars, workerArtifacts, localArtifactsDir, {
    excludeTopLevel: [...REVIEW_GATE_ARTIFACT_COPY_EXCLUDES, ...gatewayOwnedExcludes],
    excludeRelativePaths: [...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES],
    // Stamp run/slot so package-refresh / run-detail transfer UI can bind progress.
    phase: 'mirror',
    runId,
    slotId: run.slotId ?? vars.slotId,
    labelPrefix: 'review-artifacts',
  });

  const workerTask = path.join(workerTaskDir, 'TASK.md');
  if (await slotFileExists(vars, workerTask)) {
    await slotCopyFile(vars, workerTask, path.join(taskDir, 'TASK.md.worker'), {
      phase: 'mirror',
      runId,
      slotId: run.slotId ?? vars.slotId,
      label: 'TASK.md.worker',
    });
  }
  console.log(`[run-engine] copied worker artifacts for ${runId.slice(0, 8)}`);
}

/**
 * Reads the planning-context snapshot the task writer froze for the worker.
 * Never recomputed here: a reviewer must see the prerequisites the worker was
 * briefed on, so a changed upstream shows up as a hash mismatch instead of
 * silently rewriting itself from current stores.
 */
export async function readFrozenPlanningContext(
  taskFile: string | null,
): Promise<PlanningContextProjection | null> {
  if (!taskFile) return null;
  const snapshotPath = path.join(path.dirname(taskFile), PLANNING_CONTEXT_INPUT);
  if (!existsSync(snapshotPath)) return null;
  const parsed: unknown = JSON.parse(await readFile(snapshotPath, 'utf-8'));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as PlanningContextProjection).snapshotHash !== 'string' ||
    !Array.isArray((parsed as PlanningContextProjection).relations)
  ) {
    throw new Error(`Malformed frozen planning context at ${snapshotPath}`);
  }
  return parsed as PlanningContextProjection;
}

/**
 * Renders the reviewer's copy of the worker's related-context brief from the
 * frozen artifact, so both briefs quote the same snapshot hash.
 */
export async function buildIndependentReviewPlanningBrief(
  taskFile: string | null,
  slotTaskDir: string,
): Promise<string> {
  const projection = await readFrozenPlanningContext(taskFile);
  return buildPlanningContextSection(
    slotTaskDir,
    projection,
    'the worker task carried no frozen planning-context snapshot',
  );
}

export async function readReviewArtifacts(runId: string): Promise<ReviewArtifacts> {
  let markdownRecommendation: string | null = null;
  const run = getRun(runId);
  const result: ReviewArtifacts = {
    recommendation: 'COMMENT',
    summary: '',
    lineCommentSummary: 'none',
    hasReview: false,
    reviewMd: '',
    lineComments: [],
  };

  if (!run?.taskFile) return result;
  const taskDir = path.dirname(run.taskFile);
  const reviewPath = path.join(taskDir, 'artifacts', 'review.md');
  const lcPath = path.join(taskDir, 'artifacts', 'line-comments.json');

  // Read review.md
  if (existsSync(reviewPath)) {
    try {
      const reviewMd = await readFile(reviewPath, 'utf-8');
      result.hasReview = true;
      result.reviewMd = reviewMd;

      // Extract summary (text between ## Summary and next ##)
      const summaryMatch = reviewMd.match(/## Summary\n([\s\S]*?)(?=\n##|$)/);
      result.summary = summaryMatch?.[1]?.trim().slice(0, 500) ?? reviewMd.slice(0, 300);

      // Extract recommendation
      markdownRecommendation = reviewRecommendationFromMarkdown(reviewMd);
      if (markdownRecommendation) {
        result.recommendation = markdownRecommendation;
      }
    } catch (err) {
      console.warn(
        `[run-engine] failed to read review artifact ${reviewPath}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }

  // Read line-comments.json
  if (existsSync(lcPath)) {
    try {
      const raw = await readFile(lcPath, 'utf-8');
      const data: unknown = JSON.parse(raw);
      const comments = reviewLineCommentsFromArtifact(data);
      const counts: Record<string, number> = {};
      for (const c of comments) {
        const sev = typeof c.severity === 'string' ? c.severity.toLowerCase() : 'comment';
        counts[sev] = (counts[sev] ?? 0) + 1;
      }
      const parts = ['must_fix', 'suggestion', 'nitpick', 'comment']
        .filter((s) => counts[s])
        .map((s) => `${counts[s]} ${s}`);
      result.lineCommentSummary = `${comments.length} comments: ${parts.join(', ')}`;
      result.lineComments = comments.map((c) => ({
        path: typeof c.path === 'string' ? c.path : '',
        line: typeof c.line === 'number' ? c.line : 0,
        body: typeof c.body === 'string' ? c.body : '',
        severity: typeof c.severity === 'string' ? c.severity.toLowerCase() : 'comment',
      }));

      // Fail closed when the human-readable verdict and structured sidecar
      // disagree. A stale/default COMMENT must never weaken REQUEST_CHANGES.
      const sidecarRecommendation = normalizeReviewRecommendation(
        reviewRecommendationFromArtifact(data),
      );
      if (sidecarRecommendation) {
        if (markdownRecommendation && markdownRecommendation !== sidecarRecommendation) {
          console.warn(
            `[run-engine] review recommendation mismatch for ${runId.slice(0, 8)}: review.md=${markdownRecommendation}, line-comments.json=${sidecarRecommendation}; using stricter verdict`,
          );
        }
        result.recommendation = markdownRecommendation
          ? stricterReviewRecommendation(markdownRecommendation, sidecarRecommendation)
          : sidecarRecommendation;
      }
    } catch (err) {
      console.warn(
        `[run-engine] failed to read review line comments ${lcPath}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }

  return result;
}
