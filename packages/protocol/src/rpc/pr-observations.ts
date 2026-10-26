// Closed observation identities and durable projections for gateway-owned PR detail reads.
// Pure and client-cache-free so the registry and the gateway collectors share one normalization.
import type { PRForSlotResult, PRReviewCommentsResult, PRStatusResult } from './pr.js';
import type { UpstreamObservation } from './resource-observers.js';

export interface PRStatusObservationParams {
  pr: number;
  project: string;
}

export interface PRReviewCommentsObservationParams {
  pr: number;
  repo: string;
}

export interface PRForSlotObservationParams {
  slotId: string;
}

/** Stored rows keep only the failure class; gateway messages may describe local setup. */
export const PR_STORED_OBSERVATION_ERROR = 'The last GitHub check did not complete.';

function observationRecord(
  params: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    throw new Error(`${label} observations require an object`);
  const record = params as Record<string, unknown>;
  if (Object.keys(record).some((key) => record[key] !== undefined && !allowed.includes(key)))
    throw new Error(`${label} observations do not accept unregistered selectors`);
  return record;
}

function prNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label} observations require a pull request number`);
  return value;
}

function identifier(value: unknown, label: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > 256 ||
    /[/\\]/.test(value) ||
    value === '.' ||
    value === '..'
  )
    throw new Error(`${label} observations require a valid ${field}`);
  return value;
}

function repoSlug(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error(`${label} observations require an owner/name repository`);
  return value;
}

/** `force` stays an explicit read; it never names a separate observation. */
export function prStatusObservationParams(params: unknown): PRStatusObservationParams {
  const record = observationRecord(params, 'PR status', ['pr', 'project', 'force']);
  if (record.force !== undefined && record.force !== false)
    throw new Error('PR status observations cannot force a check');
  return {
    pr: prNumber(record.pr, 'PR status'),
    project: identifier(record.project, 'PR status', 'project'),
  };
}

export function prReviewCommentsObservationParams(
  params: unknown,
): PRReviewCommentsObservationParams {
  const record = observationRecord(params, 'PR review thread', ['pr', 'repo']);
  return {
    pr: prNumber(record.pr, 'PR review thread'),
    repo: repoSlug(record.repo, 'PR review thread'),
  };
}

export function prForSlotObservationParams(params: unknown): PRForSlotObservationParams {
  const record = observationRecord(params, 'Slot PR', ['slotId']);
  return { slotId: identifier(record.slotId, 'Slot PR', 'slot') };
}

function storedObservation(observation: UpstreamObservation | undefined): {
  observation?: UpstreamObservation;
} {
  if (!observation) return {};
  return {
    observation: {
      status: observation.status,
      ...(observation.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
      ...(observation.error
        ? { error: { code: observation.error.code, message: PR_STORED_OBSERVATION_ERROR } }
        : {}),
    },
  };
}

export function prStatusStoredData(data: unknown): PRStatusResult {
  const result = data as PRStatusResult;
  return { pr: result.pr, ...storedObservation(result.observation) };
}

export function prReviewCommentsStoredData(data: unknown): PRReviewCommentsResult {
  const result = data as PRReviewCommentsResult;
  return {
    threads: result.threads.map(({ id, path, line, resolved, outdated, comments }) => ({
      id,
      path,
      line,
      resolved,
      outdated,
      comments: comments.map(({ id: commentId, body, author, createdAt, updatedAt }) => ({
        id: commentId,
        body,
        author,
        createdAt,
        updatedAt,
      })),
    })),
    currentUser: result.currentUser,
    ...storedObservation(result.observation),
  };
}

export function prForSlotStoredData(data: unknown): PRForSlotResult {
  const result = data as PRForSlotResult;
  return {
    pr: result.pr,
    repo: result.repo,
    baseRef: result.baseRef,
    ...storedObservation(result.observation),
  };
}
