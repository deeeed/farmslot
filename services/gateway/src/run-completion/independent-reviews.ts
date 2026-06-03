// run-completion/independent-reviews.ts — materialize publication-gate independent review artifacts.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { IndependentReviewAttempt, IndependentReviewStatus, Run } from '@farmslot/protocol';

import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { formatIndependentReviewMarkdown } from '../quality/independent-review-artifacts.js';
import { SELF_REVIEW_SOURCE } from '../quality/review-sources.js';

export async function materializeIndependentReviewArtifacts(
  run: Run,
): Promise<IndependentReviewStatus[]> {
  const step = run.steps.find((s) => s.name === 'self-review');
  const out = (step?.outputs ?? {}) as Record<string, unknown>;
  if (!step?.outputs) return [];

  const attemptVerdict = (attempt: IndependentReviewAttempt): IndependentReviewStatus['verdict'] =>
    attempt.verdict;
  const attempts = Array.isArray(out.attempts) ? (out.attempts as IndependentReviewAttempt[]) : [];
  if (attempts.length > 0) {
    // The self-review step is one configured review lane that may retry after a
    // worker-fix loop. Keep prior issue attempts as provenance on a single
    // review status, but let the final attempt decide whether the gate passes.
    // Treating every retry as its own independent review re-surfaces already
    // fixed Loop 1 blockers after package refresh.
    const finalAttempt = attempts.at(-1)!;
    const refs = SELF_REVIEW_SOURCE.artifactRefs(1);
    const review: IndependentReviewStatus = {
      id: refs.id,
      source: 'self-review',
      runner: typeof out.runner === 'string' ? out.runner : (run.metrics.runner ?? null),
      model:
        typeof out.model === 'string'
          ? out.model
          : (run.metrics.actualModel ?? run.metrics.model ?? null),
      reviewerSessionId:
        finalAttempt.usage?.runnerSessionId ??
        (typeof out.reviewerSessionId === 'string' ? out.reviewerSessionId : null),
      crossRunner: out.crossRunner === true,
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
      await writeFile(
        path.join(taskDir, refs.mdRel),
        formatIndependentReviewMarkdown(withArtifacts),
        'utf-8',
      );
      Object.assign(review, withArtifacts);
      invalidateArtifactTextCache(taskDir, run.slotId);
      invalidateLiveRecipeContextMemo(run.id);
    }
    return [review];
  }

  const verdict: IndependentReviewStatus['verdict'] = out.skipped
    ? 'skipped'
    : out.verdict === 'pass'
      ? 'pass'
      : out.verdict === 'issues'
        ? 'issues'
        : out.verdict === 'blocked'
          ? 'failed'
          : 'pending';
  const issues = Array.isArray(out.issues)
    ? (out.issues as NonNullable<IndependentReviewStatus['issues']>)
    : [];
  const reviewSnapshot =
    out.reviewSnapshot && typeof out.reviewSnapshot === 'object'
      ? (out.reviewSnapshot as IndependentReviewStatus['reviewSnapshot'])
      : undefined;
  const fixDelta =
    out.fixDelta && typeof out.fixDelta === 'object'
      ? (out.fixDelta as IndependentReviewStatus['fixDelta'])
      : undefined;
  const usage =
    out.usage && typeof out.usage === 'object'
      ? (out.usage as IndependentReviewStatus['usage'])
      : undefined;
  const fallbackRefs = SELF_REVIEW_SOURCE.artifactRefs(1);
  const review: IndependentReviewStatus = {
    id: fallbackRefs.id,
    source: 'self-review',
    runner: typeof out.runner === 'string' ? out.runner : (run.metrics.runner ?? null),
    model:
      typeof out.model === 'string'
        ? out.model
        : (run.metrics.actualModel ?? run.metrics.model ?? null),
    reviewerSessionId:
      out.usage &&
      typeof out.usage === 'object' &&
      'runnerSessionId' in out.usage &&
      typeof out.usage.runnerSessionId === 'string'
        ? out.usage.runnerSessionId
        : typeof out.reviewerSessionId === 'string'
          ? out.reviewerSessionId
          : null,
    crossRunner: out.crossRunner === true,
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
      formatIndependentReviewMarkdown(withArtifacts),
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

function verdictFromReviewFeedback(
  markdown: string | undefined,
): IndependentReviewStatus['verdict'] {
  const verdict = markdown?.match(/##\s*Verdict:\s*([A-Z_-]+)/i)?.[1]?.toLowerCase();
  if (verdict === 'pass') return 'pass';
  if (verdict === 'issues') return 'issues';
  if (verdict === 'failed' || verdict === 'fail') return 'failed';
  if (verdict === 'cancelled') return 'cancelled';
  if (verdict === 'skipped') return 'skipped';
  return 'pending';
}

function unresolvedCountFromReviewFeedback(
  markdown: string | undefined,
  verdict: IndependentReviewStatus['verdict'],
): number {
  if (verdict === 'pass' || verdict === 'skipped') return 0;
  const issuesSection = markdown?.split(/^##\s+Issues\s*$/im)[1] ?? '';
  const issueLines = issuesSection
    .split('\n')
    .filter((line) => /^\s*[-*]\s+/.test(line) && !/\(none\)/i.test(line));
  return Math.max(1, issueLines.length);
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
  review: IndependentReviewStatus,
): Promise<IndependentReviewAttempt[]> {
  const reviewDir = path.join(taskDir, 'artifacts', review.id);
  if (!existsSync(reviewDir)) return [];
  const entries = await readdir(reviewDir, { withFileTypes: true });
  const attempts: IndependentReviewAttempt[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^review-loop-(\d+)$/);
    if (!match) continue;
    const loopNumber = Number(match[1]);
    if (!Number.isFinite(loopNumber)) continue;
    const loopDir = path.join(reviewDir, entry.name);
    const files = (await readdir(loopDir)).sort();
    const feedbackPath = path.join(loopDir, 'review-feedback.md');
    const feedback = existsSync(feedbackPath) ? await readFile(feedbackPath, 'utf-8') : undefined;
    const verdict = verdictFromReviewFeedback(feedback);
    const reviewSnapshot = await readJsonArtifact<IndependentReviewAttempt['reviewSnapshot']>(
      path.join(loopDir, 'review-diff-stat.json'),
    );
    const rawFixDelta = await readJsonArtifact<IndependentReviewAttempt['fixDelta']>(
      path.join(loopDir, 'fix-delta-stat.json'),
    );
    const fixDelta = rawFixDelta?.source === 'unavailable' ? undefined : rawFixDelta;
    attempts.push({
      loopNumber,
      verdict,
      unresolvedCount: unresolvedCountFromReviewFeedback(feedback, verdict),
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

export async function augmentIndependentReviewAttemptsFromArtifacts(
  run: Run,
  reviews: IndependentReviewStatus[],
): Promise<IndependentReviewStatus[]> {
  if (!run.taskFile) return reviews;
  const taskDir = path.dirname(run.taskFile);
  return Promise.all(
    reviews.map(async (review) => {
      if (review.source === 'self-review') return review;
      const orphanAttempts = await materializeOrphanReviewAttempts(taskDir, review);
      if (orphanAttempts.length === 0) return review;
      const byAttempt = new Map<string, IndependentReviewAttempt>();
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
