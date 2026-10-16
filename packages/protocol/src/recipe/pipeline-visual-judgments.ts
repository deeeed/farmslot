import { isRecord } from './common.js';
import type { EvidenceMomentRef } from './evidence.js';
import { validateRecipeParams } from './params.js';

export const PIPELINE_VISUAL_RESULT_SCHEMA = 'pipeline-visual-judgments-v1';
export type NativeResultSchema = typeof PIPELINE_VISUAL_RESULT_SCHEMA;

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

export interface NativeStructuredResult {
  schema: NativeResultSchema;
  value: PipelineVisualJudgments;
}

const text = { type: 'string', pattern: '\\S' };
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };

/** The same schema constrains the provider and validates its completed result. */
export const PIPELINE_VISUAL_JUDGMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'recipeRunId', 'closureIdentity', 'judgments'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    recipeRunId: text,
    closureIdentity: digest,
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

export function isNativeResultSchema(value: unknown): value is NativeResultSchema {
  return value === PIPELINE_VISUAL_RESULT_SCHEMA;
}

export function isPipelineVisualJudgments(value: unknown): value is PipelineVisualJudgments {
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

export function nativeStructuredResult(
  schema: unknown,
  value: unknown,
): NativeStructuredResult | undefined {
  return isNativeResultSchema(schema) && isPipelineVisualJudgments(value)
    ? { schema, value }
    : undefined;
}
