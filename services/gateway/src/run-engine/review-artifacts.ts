import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TASK_DIR } from '@farmslot/protocol';

import {
  isGatewayOwnedArtifactMirrorEntry,
  REVIEW_GATE_ARTIFACT_COPY_EXCLUDES,
  WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES,
} from '../core/artifact-copy-policy.js';
import { loadSlotVars, resolveProjectTaskDirName } from '../core/config.js';
import { slotCopyDir, slotCopyFile, slotFileExists, slotListDir } from '../core/slot-io.js';
import { getRun } from '../runs/store.js';

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
  const taskDirName = pv
    ? resolveProjectTaskDirName(pv.projectJson)
    : DEFAULT_TASK_DIR;
  const workerTaskDir = path.join(vars.remoteRepo, taskDirName, taskRelDir);
  const localArtifactsDir = path.join(taskDir, 'artifacts');

  const workerArtifacts = path.join(workerTaskDir, 'artifacts');
  const gatewayOwnedExcludes = await workerGatewayOwnedCopyExcludes(vars, workerArtifacts);
  await slotCopyDir(vars, workerArtifacts, localArtifactsDir, {
    excludeTopLevel: [...REVIEW_GATE_ARTIFACT_COPY_EXCLUDES, ...gatewayOwnedExcludes],
    excludeRelativePaths: [...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES],
  });

  const workerTask = path.join(workerTaskDir, 'TASK.md');
  if (await slotFileExists(vars, workerTask)) {
    await slotCopyFile(vars, workerTask, path.join(taskDir, 'TASK.md.worker'));
  }
  console.log(`[run-engine] copied worker artifacts for ${runId.slice(0, 8)}`);
}

export async function readReviewArtifacts(runId: string): Promise<ReviewArtifacts> {
  const run = getRun(runId)!;
  const result: ReviewArtifacts = {
    recommendation: 'COMMENT',
    summary: '',
    lineCommentSummary: 'none',
    hasReview: false,
    reviewMd: '',
    lineComments: [],
  };

  if (!run.taskFile) return result;
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
      const recMatch = reviewMd.match(
        /(?:Recommended Action|Recommendation)[:\s]*\n?\s*(APPROVE|REQUEST_CHANGES|COMMENT)/i,
      );
      if (recMatch) result.recommendation = recMatch[1].toUpperCase();
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

      // Also extract recommendation from line-comments.json if present
      result.recommendation = reviewRecommendationFromArtifact(data) ?? result.recommendation;
    } catch (err) {
      console.warn(
        `[run-engine] failed to read review line comments ${lcPath}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }

  return result;
}
