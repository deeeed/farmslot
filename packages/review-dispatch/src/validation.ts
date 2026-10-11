import {
  isReviewMode,
  type ReviewContinuationContext,
  type ReviewPolicy,
  type ReviewRequestContext,
  type ReviewRequestPayload,
  type ReviewSelection,
  type ReviewSequence,
} from '@farmslot/protocol';

import { DEFAULT_REVIEW_DISPATCH_CATALOG, effortsForRunner, runnerOption } from './catalog.js';
import { sequenceMaximumRows } from './row-limit.js';
import type { ReviewValidationOptions } from './types.js';

function record(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object`);
}
function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${field} contains unsupported property: ${unknown}`);
}
function identifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][^\s]*$/.test(value) || value.length > 256)
    throw new Error(`${field} must be a non-empty identifier without whitespace`);
}
function selection(value: Record<string, unknown>, options: ReviewValidationOptions): void {
  identifier(value.runner, 'Review runner');
  const catalog = options.catalog ?? DEFAULT_REVIEW_DISPATCH_CATALOG;
  const runner = runnerOption(value.runner, catalog);
  if (value.model !== null) identifier(value.model, 'Review model');
  if (value.effort !== null) identifier(value.effort, 'Review effort');
  if (!isReviewMode(value.mode)) throw new Error('Review mode must be warm or cold');
  if (
    runner.allowCustomModels === false &&
    value.model !== null &&
    !runner.models.some((model) => model.id === value.model)
  )
    throw new Error(`Unsupported review model for ${runner.id}: ${value.model}`);
  if (
    value.effort !== null &&
    !effortsForRunner(runner.id, value.model as string | null, catalog).includes(
      value.effort as string,
    )
  )
    throw new Error(`Unsupported review effort for ${runner.id}: ${value.effort}`);
}

export function assertReviewSelection(
  value: unknown,
  options: ReviewValidationOptions = {},
): asserts value is ReviewSelection {
  record(value, 'Review selection');
  exactKeys(value, ['runner', 'model', 'effort', 'mode'], 'Review selection');
  selection(value, options);
}
export function assertReviewSequence(
  value: unknown,
  options: ReviewValidationOptions = {},
): asserts value is ReviewSequence {
  if (!Array.isArray(value)) throw new Error('Review sequence must be an array');
  const maxRows = sequenceMaximumRows(options);
  if (options.allowEmpty === false && value.length === 0)
    throw new Error('Review sequence requires at least one selection');
  if (value.length > maxRows)
    throw new Error(`Review sequence may contain at most ${maxRows} rows`);
  value.forEach((row) => assertReviewSelection(row, options));
}
export function assertReviewRequestPayload(
  value: unknown,
  options: ReviewValidationOptions = {},
): asserts value is ReviewRequestPayload {
  const reviewOptions: ReviewValidationOptions = { ...options, sequenceRole: 'reviews' };
  record(value, 'Review request');
  exactKeys(value, ['runner', 'model', 'effort', 'mode', 'sequence', 'context'], 'Review request');
  selection(value, options);
  if (value.context !== undefined)
    assertReviewRequestContext(
      value.context,
      1 + (Array.isArray(value.sequence) ? value.sequence.length : 0),
    );
  if (value.sequence !== undefined) {
    assertReviewSequence(value.sequence, { ...reviewOptions, allowEmpty: true });
    const maxRows = sequenceMaximumRows(reviewOptions);
    if (value.sequence.length + 1 > maxRows)
      throw new Error(`Review request may contain at most ${maxRows} rows`);
  }
}
export function parseReviewSelection(
  value: unknown,
  options: ReviewValidationOptions = {},
): ReviewSelection {
  assertReviewSelection(value, options);
  return { runner: value.runner, model: value.model, effort: value.effort, mode: value.mode };
}
export function parseReviewSequence(
  value: unknown,
  options: ReviewValidationOptions = {},
): ReviewSequence {
  assertReviewSequence(value, options);
  return value.map((row) => parseReviewSelection(row, options));
}
export function reviewSequenceFromRequest(
  value: unknown,
  options: ReviewValidationOptions = {},
): ReviewSequence {
  assertReviewRequestPayload(value, options);
  const { sequence, context: _context, ...first } = value;
  return [
    parseReviewSelection(first, options),
    ...parseReviewSequence(sequence ?? [], { ...options, allowEmpty: true }),
  ];
}
export function reviewRequestFromSequence(
  value: unknown,
  options: ReviewValidationOptions = {},
  context?: ReviewRequestContext,
): ReviewRequestPayload {
  const rows = parseReviewSequence(value, { ...options, sequenceRole: 'reviews' });
  if (!rows.length) throw new Error('A review request requires at least one selection');
  const [first, ...remaining] = rows;
  if (context) assertReviewRequestContext(context, rows.length);
  return {
    ...first,
    ...(remaining.length ? { sequence: remaining } : {}),
    ...(context ? { context: parseReviewRequestContext(context) } : {}),
  };
}

export function assertReviewPolicy(value: unknown): asserts value is ReviewPolicy {
  record(value, 'Review policy');
  exactKeys(value, ['minimumReviews', 'requestedBy'], 'Review policy');
  if (
    typeof value.minimumReviews !== 'number' ||
    !Number.isSafeInteger(value.minimumReviews) ||
    value.minimumReviews < 0
  )
    throw new Error('Review policy minimumReviews must be a non-negative integer');
  if (!['dispatch', 'human-gate', 'agent-gate'].includes(value.requestedBy as string))
    throw new Error('Review policy requestedBy is invalid');
}
export function parseReviewPolicy(value: unknown): ReviewPolicy {
  assertReviewPolicy(value);
  return { minimumReviews: value.minimumReviews, requestedBy: value.requestedBy };
}

export function assertReviewContinuationContext(
  value: unknown,
): asserts value is ReviewContinuationContext {
  record(value, 'Review continuation context');
  exactKeys(value, ['repository', 'prNumber', 'reviewId'], 'Review continuation context');
  identifier(value.repository, 'Review repository');
  identifier(value.reviewId, 'Review lineage ID');
  if (
    typeof value.prNumber !== 'number' ||
    !Number.isSafeInteger(value.prNumber) ||
    value.prNumber < 1
  )
    throw new Error('Review PR number must be a positive integer');
}
export function assertReviewRequestContext(
  value: unknown,
  rows?: number,
): asserts value is ReviewRequestContext {
  record(value, 'Review request context');
  exactKeys(value, ['reviewLineages'], 'Review request context');
  if (
    !Array.isArray(value.reviewLineages) ||
    (rows !== undefined && value.reviewLineages.length !== rows)
  )
    throw new Error('Review lineage context must align with every sequence row');
  value.reviewLineages.forEach((lineage) => {
    if (lineage !== null) assertReviewContinuationContext(lineage);
  });
}
export function parseReviewRequestContext(value: unknown, rows?: number): ReviewRequestContext {
  assertReviewRequestContext(value, rows);
  return {
    reviewLineages: value.reviewLineages.map((lineage) => (lineage ? { ...lineage } : null)),
  };
}

export function reviewContextFromRequest(
  value: unknown,
  options: ReviewValidationOptions = {},
): ReviewRequestContext | undefined {
  assertReviewRequestPayload(value, options);
  return value.context ? parseReviewRequestContext(value.context) : undefined;
}
