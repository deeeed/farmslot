import type { PipelineVisualReviewerBinding } from './claim-reviews.js';
import { isRecord } from './common.js';
import type { EvidenceMomentRef } from './evidence.js';
import { validateRecipeParams } from './params.js';

export const PIPELINE_VISUAL_RESULT_SCHEMA = 'pipeline-visual-judgments-v1';
/** Authorised repair review: per-source visual results plus retained-claim applicability. */
export const PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA = 'pipeline-visual-judgments-v2';
export type NativeResultSchema =
  | typeof PIPELINE_VISUAL_RESULT_SCHEMA
  | typeof PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA;

export interface PipelineVisualJudgment {
  claimId: string;
  verdict: 'confirmed' | 'rejected';
  reason: string;
  reviewedFiles: { path: string; digest: string }[];
  moments: EvidenceMomentRef[];
}

export interface PipelineVisualJudgments {
  schemaVersion: 1;
  recipeRunId: string;
  closureIdentity: string;
  judgments: PipelineVisualJudgment[];
}

/** A reviewer's explicit current-head classification of one retained criterion. */
export interface PipelineRepairApplicability {
  claimId: string;
  recipeRunId: string;
  closureIdentity: string;
  unaffected: boolean;
  reason: string;
}

export interface PipelineRepairVisualJudgments {
  schemaVersion: 2;
  headSha: string;
  scopeDigest: string;
  /** Existing visual-judgment results, one per fresh source with claims awaiting review. */
  sources: PipelineVisualJudgments[];
  retained: PipelineRepairApplicability[];
}

/**
 * What a reviewer returns. It never supplies a closure identity: the gateway binds each result to
 * the closure it captured at launch for that recipeRunId.
 */
export type PipelineVisualReviewerJudgments = Omit<PipelineVisualJudgments, 'closureIdentity'>;

export type PipelineRepairReviewerApplicability = Omit<
  PipelineRepairApplicability,
  'closureIdentity'
>;

export interface PipelineRepairReviewerJudgments extends Omit<
  PipelineRepairVisualJudgments,
  'sources' | 'retained'
> {
  sources: PipelineVisualReviewerJudgments[];
  retained: PipelineRepairReviewerApplicability[];
}

export type NativeStructuredResult =
  | { schema: typeof PIPELINE_VISUAL_RESULT_SCHEMA; value: PipelineVisualReviewerJudgments }
  | { schema: typeof PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA; value: PipelineRepairReviewerJudgments };

/** Gateway-captured review input; shared task files cannot supply it. */
export interface PipelineVisualReviewInput {
  headSha: string;
  recipeRunId: string;
  closureIdentity: string;
  artifactPrefix: string;
  claims: Array<Omit<PipelineVisualJudgment, 'verdict' | 'reason'> & { text: string }>;
}

/** Gateway-captured repair review input: fresh visual sources and retained criteria to classify. */
export interface PipelineRepairVisualReviewInput {
  schemaVersion: 2;
  headSha: string;
  repairId: string;
  scopeDigest: string;
  sources: PipelineVisualReviewInput[];
  retained: Array<{
    claimId: string;
    text: string;
    recipeRunId: string;
    closureIdentity: string;
    /** The source's recorded revision; the reviewer diffs from here to headSha. */
    sourceHeadSha: string;
  }>;
}

export type PipelineReviewInput = PipelineVisualReviewInput | PipelineRepairVisualReviewInput;

export function isPipelineRepairVisualReviewInput(
  input: PipelineReviewInput,
): input is PipelineRepairVisualReviewInput {
  return 'schemaVersion' in input && input.schemaVersion === 2;
}

/** Validated completed native turn retained until a matching package is prepared. */
export interface PipelineVisualReviewResult {
  headSha: string;
  binding: PipelineVisualReviewerBinding;
  result: PipelineVisualJudgments | PipelineRepairVisualJudgments;
  completedAt: string;
}

const text = { type: 'string', pattern: '\\S' };
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };

/** The same schema constrains the provider and validates its completed result. */
export const PIPELINE_VISUAL_JUDGMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'recipeRunId', 'judgments'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    recipeRunId: text,
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claimId', 'verdict', 'reason', 'reviewedFiles', 'moments'],
        properties: {
          claimId: text,
          verdict: { type: 'string', enum: ['confirmed', 'rejected'] },
          reason: text,
          reviewedFiles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'digest'],
              properties: { path: text, digest },
            },
          },
          moments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['recipeRunId', 'videoDigest', 'traceIndex'],
              properties: {
                recipeRunId: text,
                videoDigest: digest,
                traceIndex: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
    },
  },
};

export const PIPELINE_REPAIR_VISUAL_JUDGMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'headSha', 'scopeDigest', 'sources', 'retained'],
  properties: {
    schemaVersion: { type: 'integer', enum: [2] },
    headSha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
    scopeDigest: digest,
    sources: { type: 'array', items: PIPELINE_VISUAL_JUDGMENTS_SCHEMA },
    retained: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claimId', 'recipeRunId', 'unaffected', 'reason'],
        properties: {
          claimId: text,
          recipeRunId: text,
          unaffected: { type: 'boolean' },
          reason: text,
        },
      },
    },
  },
};

export function isNativeResultSchema(value: unknown): value is NativeResultSchema {
  return value === PIPELINE_VISUAL_RESULT_SCHEMA || value === PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA;
}

/** The JSON schema a provider is constrained with for a declared result contract. */
export function nativeResultJsonSchema(schema: NativeResultSchema): Record<string, unknown> {
  return schema === PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA
    ? PIPELINE_REPAIR_VISUAL_JUDGMENTS_SCHEMA
    : PIPELINE_VISUAL_JUDGMENTS_SCHEMA;
}

export function isPipelineVisualJudgments(
  value: unknown,
): value is PipelineVisualReviewerJudgments {
  if (
    !isRecord(value) ||
    validateRecipeParams(value, PIPELINE_VISUAL_JUDGMENTS_SCHEMA).status !== 'valid' ||
    !Array.isArray(value.judgments)
  )
    return false;
  const claims = new Set<string>();
  for (const row of value.judgments) {
    if (
      !isRecord(row) ||
      typeof row.claimId !== 'string' ||
      claims.has(row.claimId) ||
      !Array.isArray(row.reviewedFiles) ||
      !Array.isArray(row.moments) ||
      (!row.reviewedFiles.length && !row.moments.length)
    )
      return false;
    claims.add(row.claimId);
  }
  return true;
}

export function isPipelineRepairVisualJudgments(
  value: unknown,
): value is PipelineRepairReviewerJudgments {
  if (
    !isRecord(value) ||
    validateRecipeParams(value, PIPELINE_REPAIR_VISUAL_JUDGMENTS_SCHEMA).status !== 'valid' ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.retained) ||
    !value.sources.every(isPipelineVisualJudgments)
  )
    return false;
  const sources = new Set<string>();
  for (const source of value.sources as PipelineVisualReviewerJudgments[]) {
    if (sources.has(source.recipeRunId)) return false;
    sources.add(source.recipeRunId);
  }
  const retained = new Set<string>();
  for (const row of value.retained as PipelineRepairReviewerApplicability[]) {
    if (retained.has(row.claimId)) return false;
    retained.add(row.claimId);
  }
  return true;
}

/**
 * A runner on the earlier schema still returns closure identities. The gateway binds its own, so
 * they are dropped before strict validation.
 */
function withoutLegacyClosures(schema: unknown, value: unknown): unknown {
  const drop = (row: unknown) => {
    if (!isRecord(row) || !('closureIdentity' in row)) return row;
    const { closureIdentity: _legacy, ...rest } = row;
    return rest;
  };
  if (schema === PIPELINE_VISUAL_RESULT_SCHEMA) return drop(value);
  if (schema !== PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA || !isRecord(value)) return value;
  return {
    ...value,
    ...(Array.isArray(value.sources) ? { sources: value.sources.map(drop) } : {}),
    ...(Array.isArray(value.retained) ? { retained: value.retained.map(drop) } : {}),
  };
}

export function nativeStructuredResult(
  schema: unknown,
  value: unknown,
): NativeStructuredResult | undefined {
  const candidate = withoutLegacyClosures(schema, value);
  if (schema === PIPELINE_VISUAL_RESULT_SCHEMA && isPipelineVisualJudgments(candidate))
    return { schema, value: candidate };
  if (schema === PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA && isPipelineRepairVisualJudgments(candidate))
    return { schema, value: candidate };
  return undefined;
}
