import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isRecord,
  type ReviewValidationDepth,
  type Run,
  type RunnerSessionUsage,
} from '@farmslot/protocol';

import { loadReviewApprovalPolicy } from '../review/approval-policy.js';
import { parseStructuredReviewFeedback } from '../review/feedback.js';
import type { ReviewResult } from '../review/orchestrator.js';
import { parseReviewSnapshotArtifact } from '../review/snapshots.js';
import { atomicWriteTextFile } from '../run-engine/diff-artifact-utils.js';

export interface EvalJudgeReceipt {
  contextId?: string;
  completedAt: string;
  result: ReviewResult;
}

function receiptPath(run: Run): string {
  const link = run.engineState?.evalExperiment;
  if (!link) throw new Error('Eval experiment is missing');
  return path.join(path.dirname(link.packagePath), 'first-output-judge.json');
}

function nullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function readUsage(value: unknown): RunnerSessionUsage | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.measuredAt !== 'string' ||
    (value.source !== 'runner-transcript' && value.source !== 'unavailable')
  )
    throw new Error('Eval judge usage receipt is invalid');
  const usage: RunnerSessionUsage = { measuredAt: value.measuredAt, source: value.source };
  for (const key of [
    'turns',
    'inputTokens',
    'outputTokens',
    'cacheCreation',
    'cacheRead',
    'reasoningOutputTokens',
    'totalTokens',
    'costUsd',
  ] as const) {
    const number = value[key];
    if (number === undefined) continue;
    if (number !== null && (typeof number !== 'number' || !Number.isFinite(number)))
      throw new Error('Eval judge usage receipt is invalid');
    usage[key] = number;
  }
  for (const key of ['runnerSessionId', 'runnerSessionPath', 'runner', 'actualModel'] as const) {
    const text = value[key];
    if (!nullableString(text)) throw new Error('Eval judge usage receipt is invalid');
    if (text !== undefined) usage[key] = text;
  }
  if (value.scope !== undefined) {
    if (value.scope !== 'session-total') throw new Error('Eval judge usage scope is invalid');
    usage.scope = value.scope;
  }
  if (value.error !== undefined) {
    if (typeof value.error !== 'string') throw new Error('Eval judge usage error is invalid');
    usage.error = value.error;
  }
  return usage;
}

export async function readEvalJudgeReceipt(run: Run): Promise<EvalJudgeReceipt | null> {
  if (!run.engineState?.evalExperiment) return null;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(receiptPath(run), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const blind = run.engineState.evalExperiment.blind;
  const first = blind?.firstOutput;
  if (
    !blind ||
    !first ||
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.runId !== run.id ||
    value.headSha !== first.headSha ||
    value.diffSha256 !== first.diffSha256 ||
    typeof value.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    !nullableString(value.contextId) ||
    !isRecord(value.result)
  )
    throw new Error('Eval judge receipt differs from its frozen first output');
  const raw = value.result;
  if (!isRecord(raw.reviewSnapshot)) throw new Error('Eval judge snapshot is missing');
  const snapshot = parseReviewSnapshotArtifact(JSON.stringify(raw.reviewSnapshot));
  const feedback = parseStructuredReviewFeedback(
    JSON.stringify({ schemaVersion: 1, verdict: raw.verdict, issues: raw.issues }),
    receiptPath(run),
    await loadReviewApprovalPolicy(run.project),
  );
  if (feedback.incomplete) throw new Error(feedback.terminalInvalidReason);
  if (
    typeof raw.reviewId !== 'string' ||
    !raw.reviewId ||
    raw.retryCount !== 0 ||
    !nullableString(raw.reviewerSessionId) ||
    !nullableString(raw.runner) ||
    !nullableString(raw.model) ||
    !nullableString(raw.effort) ||
    (raw.validationDepth !== 'static-code' && raw.validationDepth !== 'full-live') ||
    !snapshot ||
    snapshot.source !== 'local-git' ||
    snapshot.headSha !== first.headSha ||
    snapshot.baseSha !== blind.baseSha
  )
    throw new Error('Eval judge receipt has invalid review provenance');
  const paths = value.artifactPaths;
  if (!Array.isArray(paths) || !paths.every((file): file is string => typeof file === 'string'))
    throw new Error('Eval judge artifact paths are invalid');
  const usage = readUsage(raw.usage);
  const validationDepth: ReviewValidationDepth = raw.validationDepth;
  const result: ReviewResult = {
    verdict: feedback.verdict,
    issues: feedback.issues,
    retryCount: 0,
    maxRetries: 0,
    mode: 'cold',
    reviewId: raw.reviewId,
    reviewerSessionId: raw.reviewerSessionId,
    runner: raw.runner ?? undefined,
    model: raw.model ?? undefined,
    effort: raw.effort,
    validationDepth,
    usage,
    reviewSnapshot: snapshot,
    attempts: [
      {
        mode: 'cold',
        loopNumber: 1,
        verdict: feedback.verdict,
        issues: feedback.issues,
        unresolvedCount: feedback.issues.length,
        validationDepth,
        usage,
        reviewSnapshot: snapshot,
        artifactPaths: paths,
        completedAt: value.completedAt,
      },
    ],
  };
  return { result, completedAt: value.completedAt, contextId: value.contextId ?? undefined };
}

/** One immutable judge outcome; the native caller records it before settling its context. */
export async function recordEvalJudgeResult(
  run: Run,
  result: ReviewResult,
  contextId?: string,
): Promise<void> {
  if (
    !run.engineState?.evalExperiment ||
    result.skipped ||
    (result.verdict !== 'pass' && result.verdict !== 'issues')
  )
    return;
  const first = run.engineState.evalExperiment.blind?.firstOutput;
  if (
    !first ||
    result.reviewSnapshot?.headSha !== first.headSha ||
    result.reviewSnapshot.baseSha !== run.engineState.evalExperiment.blind?.baseSha ||
    result.retryCount !== 0
  )
    throw new Error('Eval judge did not review the frozen first output');
  const existing = await readEvalJudgeReceipt(run);
  if (existing) {
    const facts = (review: ReviewResult) =>
      JSON.stringify([
        review.verdict,
        review.issues?.map(({ file, line, description, severity }) => [
          file,
          line,
          description,
          severity,
        ]),
      ]);
    if (facts(existing.result) !== facts(result))
      throw new Error('The first eval judge outcome changed');
    return;
  }
  const attempt = result.attempts?.at(-1);
  await atomicWriteTextFile(
    receiptPath(run),
    JSON.stringify({
      schemaVersion: 1,
      runId: run.id,
      headSha: first.headSha,
      diffSha256: first.diffSha256,
      contextId,
      completedAt: attempt?.completedAt ?? new Date().toISOString(),
      artifactPaths: attempt?.artifactPaths ?? [],
      result,
    }),
  );
}
