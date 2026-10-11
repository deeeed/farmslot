// run-completion/reviews.ts — materialize publication-gate review artifacts.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ReviewAttempt, ReviewStatus, Run } from '@farmslot/protocol';

import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { formatReviewMarkdown } from '../quality/review-artifacts.js';
import { PIPELINE_REVIEW_SOURCE } from '../quality/review-sources.js';

export async function materializeReviewArtifacts(run: Run): Promise<ReviewStatus[]> {
  const step = run.steps.find((s) => s.name === 'review');
  const out = (step?.outputs ?? {}) as Record<string, unknown>;
  if (!step?.outputs) return [];

  const attemptVerdict = (attempt: ReviewAttempt): ReviewStatus['verdict'] => attempt.verdict;
  const attempts = Array.isArray(out.attempts) ? (out.attempts as ReviewAttempt[]) : [];
  if (attempts.length > 0) {
    // The review step is one configured review lane that may retry after a
    // worker-fix loop. Keep prior issue attempts as provenance on a single
    // review status, but let the final attempt decide whether the gate passes.
    // Treating every retry as its own review re-surfaces already
    // fixed Loop 1 blockers after package refresh.
    const finalAttempt = attempts.at(-1)!;
    const refs = PIPELINE_REVIEW_SOURCE.artifactRefs(
      1,
      typeof out.reviewId === 'string' ? out.reviewId.replace(/^pipeline-review-/, '') : undefined,
    );
    const review: ReviewStatus = {
      id: refs.id,
      source: 'pipeline',
      mode: out.mode === 'warm' ? 'warm' : 'cold',
      ...(out.session && typeof out.session === 'object'
        ? { session: out.session as ReviewStatus['session'] }
        : {}),
      runner: typeof out.runner === 'string' ? out.runner : null,
      model: typeof out.model === 'string' ? out.model : null,
      ...(typeof out.effort === 'string' && out.effort.trim() ? { effort: out.effort.trim() } : {}),
      reviewerSessionId:
        finalAttempt.usage?.runnerSessionId ??
        (typeof out.reviewerSessionId === 'string' ? out.reviewerSessionId : null),
      loopNumber: 1,
      verdict: attemptVerdict(finalAttempt),
      unresolvedCount: finalAttempt.unresolvedCount,
      issues: finalAttempt.issues,
      validationDepth: finalAttempt.validationDepth,
      usage: finalAttempt.usage,
      artifactPaths: [...new Set(attempts.flatMap((attempt) => attempt.artifactPaths ?? []))],
      taskProgressArtifactPath: finalAttempt.taskProgressArtifactPath,
      timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
      reviewSnapshot: finalAttempt.reviewSnapshot,
      feedbackSent: out.feedbackSent === true,
      attempts,
      fixDelta:
        finalAttempt.fixDelta ??
        attempts
          .slice()
          .reverse()
          .find((attempt) => attempt.fixDelta)?.fixDelta,
      startedAt: attempts[0]?.startedAt ?? step.startedAt,
      completedAt: finalAttempt.completedAt ?? step.completedAt,
    };
    if (run.taskFile) {
      const taskDir = path.dirname(run.taskFile);
      const artifactsDir = path.join(taskDir, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      const withArtifacts = {
        ...review,
        artifactPaths: [...new Set([...(review.artifactPaths ?? []), refs.jsonRel, refs.mdRel])],
      };
      await writeFile(
        path.join(taskDir, refs.jsonRel),
        JSON.stringify(withArtifacts, null, 2),
        'utf-8',
      );
      await writeFile(path.join(taskDir, refs.mdRel), formatReviewMarkdown(withArtifacts), 'utf-8');
      Object.assign(review, withArtifacts);
      invalidateArtifactTextCache(taskDir, run.slotId);
      invalidateLiveRecipeContextMemo(run.id);
    }
    return [review];
  }

  const verdict: ReviewStatus['verdict'] = out.skipped
    ? 'skipped'
    : out.verdict === 'pass'
      ? 'pass'
      : out.verdict === 'issues'
        ? 'issues'
        : out.verdict === 'blocked'
          ? 'failed'
          : 'pending';
  if (verdict === 'pending' && step.status !== 'running') return [];
  const issues = Array.isArray(out.issues)
    ? (out.issues as NonNullable<ReviewStatus['issues']>)
    : [];
  const reviewSnapshot =
    out.reviewSnapshot && typeof out.reviewSnapshot === 'object'
      ? (out.reviewSnapshot as ReviewStatus['reviewSnapshot'])
      : undefined;
  const fixDelta =
    out.fixDelta && typeof out.fixDelta === 'object'
      ? (out.fixDelta as ReviewStatus['fixDelta'])
      : undefined;
  const usage =
    out.usage && typeof out.usage === 'object' ? (out.usage as ReviewStatus['usage']) : undefined;
  const fallbackRefs = PIPELINE_REVIEW_SOURCE.artifactRefs(
    1,
    typeof out.reviewId === 'string' ? out.reviewId.replace(/^pipeline-review-/, '') : undefined,
  );
  const review: ReviewStatus = {
    id: fallbackRefs.id,
    source: 'pipeline',
    mode: out.mode === 'warm' ? 'warm' : 'cold',
    ...(out.session && typeof out.session === 'object'
      ? { session: out.session as ReviewStatus['session'] }
      : {}),
    runner: typeof out.runner === 'string' ? out.runner : null,
    model: typeof out.model === 'string' ? out.model : null,
    ...(typeof out.effort === 'string' && out.effort.trim() ? { effort: out.effort.trim() } : {}),
    reviewerSessionId:
      out.usage &&
      typeof out.usage === 'object' &&
      'runnerSessionId' in out.usage &&
      typeof out.usage.runnerSessionId === 'string'
        ? out.usage.runnerSessionId
        : typeof out.reviewerSessionId === 'string'
          ? out.reviewerSessionId
          : null,
    loopNumber: 1,
    verdict,
    unresolvedCount: verdict === 'pass' ? 0 : issues.length,
    ...(issues.length ? { issues } : {}),
    ...(out.validationDepth === 'static-code' || out.validationDepth === 'full-live'
      ? { validationDepth: out.validationDepth }
      : {}),
    ...(usage ? { usage } : {}),
    feedbackSent: out.feedbackSent === true,
    reviewSnapshot,
    fixDelta,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
  };

  if (run.taskFile) {
    const artifactsDir = path.join(path.dirname(run.taskFile), 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const withArtifacts = {
      ...review,
      artifactPaths: [
        ...new Set([
          ...(Array.isArray(out.artifactPaths) ? out.artifactPaths : []),
          fallbackRefs.jsonRel,
          fallbackRefs.mdRel,
        ]),
      ],
    };
    await writeFile(
      path.join(path.dirname(run.taskFile), fallbackRefs.jsonRel),
      JSON.stringify(withArtifacts, null, 2),
      'utf-8',
    );
    await writeFile(
      path.join(path.dirname(run.taskFile), fallbackRefs.mdRel),
      formatReviewMarkdown(withArtifacts),
      'utf-8',
    );
    Object.assign(review, withArtifacts);
    invalidateArtifactTextCache(path.dirname(run.taskFile), run.slotId);
    invalidateLiveRecipeContextMemo(run.id);
  }

  return [review];
}

async function readJsonArtifact<T>(filePath: string): Promise<T | undefined> {
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

function artifactRelPathsForReviewLoop(
  reviewId: string,
  loopNumber: number,
  files: string[],
): string[] {
  return files.map((file) => `artifacts/${reviewId}/review-loop-${loopNumber}/${file}`);
}

async function materializeOrphanReviewAttempts(
  taskDir: string,
  review: ReviewStatus,
): Promise<ReviewAttempt[]> {
  const reviewDir = path.join(taskDir, 'artifacts', review.id);
  if (!existsSync(reviewDir)) return [];
  const entries = await readdir(reviewDir, { withFileTypes: true });
  const attempts: ReviewAttempt[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^review-loop-(\d+)$/);
    if (!match) continue;
    const loopNumber = Number(match[1]);
    if (!Number.isFinite(loopNumber)) continue;
    const loopDir = path.join(reviewDir, entry.name);
    const files = (await readdir(loopDir)).sort();
    const receipt = await readJsonArtifact<{
      verdict?: ReviewStatus['verdict'];
      issues?: ReviewStatus['issues'];
      unresolvedCount?: number;
    }>(path.join(loopDir, 'review-result.json'));
    const verdict = receipt?.verdict ?? 'pending';
    const reviewSnapshot = await readJsonArtifact<ReviewAttempt['reviewSnapshot']>(
      path.join(loopDir, 'review-diff-stat.json'),
    );
    const rawFixDelta = await readJsonArtifact<ReviewAttempt['fixDelta']>(
      path.join(loopDir, 'fix-delta-stat.json'),
    );
    const fixDelta = rawFixDelta?.source === 'unavailable' ? undefined : rawFixDelta;
    attempts.push({
      loopNumber,
      mode: review.mode,
      verdict,
      unresolvedCount: receipt?.unresolvedCount ?? receipt?.issues?.length ?? 0,
      validationDepth: review.validationDepth,
      usage: review.usage,
      reviewSnapshot,
      fixDelta,
      artifactPaths: artifactRelPathsForReviewLoop(review.id, loopNumber, files),
      startedAt: reviewSnapshot?.capturedAt,
      completedAt: reviewSnapshot?.capturedAt,
    });
  }
  return attempts.sort((a, b) => a.loopNumber - b.loopNumber);
}

export async function augmentReviewAttemptsFromArtifacts(
  run: Run,
  reviews: ReviewStatus[],
): Promise<ReviewStatus[]> {
  if (!run.taskFile) return reviews;
  const taskDir = path.dirname(run.taskFile);
  return Promise.all(
    reviews.map(async (review) => {
      if (review.source === 'pipeline') return review;
      const orphanAttempts = await materializeOrphanReviewAttempts(taskDir, review);
      if (orphanAttempts.length === 0) return review;
      const byAttempt = new Map<string, ReviewAttempt>();
      for (const attempt of [...orphanAttempts, ...(review.attempts ?? [])]) {
        const key = `${attempt.loopNumber}:${attempt.completedAt ?? ''}:${attempt.verdict}`;
        byAttempt.set(key, attempt);
      }
      const attempts = [...byAttempt.values()].sort((a, b) => {
        if (a.completedAt && b.completedAt) return a.completedAt.localeCompare(b.completedAt);
        return a.loopNumber - b.loopNumber;
      });
      const finalAttempt = attempts.at(-1);
      return {
        ...review,
        attempts,
        artifactPaths: [
          ...new Set([
            ...(review.artifactPaths ?? []),
            ...attempts.flatMap((attempt) => attempt.artifactPaths ?? []),
          ]),
        ],
        startedAt: attempts[0]?.startedAt ?? review.startedAt,
        completedAt: finalAttempt?.completedAt ?? review.completedAt,
      };
    }),
  );
}
