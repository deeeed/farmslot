import { ACCEPTANCE_VERDICTS } from '../contracts/acceptance.js';

import {
  addFinding,
  createContext,
  finishResult,
  isNonEmptyString,
  isRecord,
  type RecipeArtifactPackageInput,
  type RecipeValidationResult,
} from './common.js';
import { digestRecipeDocument } from './digest.js';
import type { RecipeRecordingTimelineDocument } from './recording.js';

/** Serialized target identity; resolution remains the provider's responsibility. */
export type RecipeRecordingTarget =
  | { kind: 'cdp-page'; host: string; port: number; targetId: string }
  | { kind: 'android-device'; serial: string }
  | { kind: 'window-id'; windowId: string }
  | { kind: 'pid'; pid: number }
  | { kind: 'app-window'; appName: string; windowName: string }
  | { kind: 'simulator'; device: string };

/** Canonical serialized identity validation for providers and lease acquisition. */
export function validateRecipeRecordingTarget(value: unknown): RecipeValidationResult {
  const context = createContext();
  const issue = (path: string, message: string) =>
    addFinding(context, 'error', 'recording_target.invalid', path, message);
  if (!isRecord(value)) {
    issue('$', 'Recording target must be an object.');
    return finishResult(context);
  }
  const fields: Readonly<Record<string, readonly string[]>> = {
    'cdp-page': ['host', 'port', 'targetId'],
    'android-device': ['serial'],
    'window-id': ['windowId'],
    pid: ['pid'],
    'app-window': ['appName', 'windowName'],
    simulator: ['device'],
  };
  const required =
    typeof value.kind === 'string' && Object.hasOwn(fields, value.kind)
      ? fields[value.kind]
      : undefined;
  if (!required) {
    issue('kind', 'Unknown recording target kind.');
    return finishResult(context);
  }
  for (const field of Object.keys(value)) {
    if (field !== 'kind' && !required.includes(field))
      issue(field, 'Unknown recording target field.');
  }
  for (const field of required) {
    if (field === 'pid' || field === 'port') {
      const number = value[field];
      if (
        typeof number !== 'number' ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (field === 'port' && number > 65_535)
      )
        issue(
          field,
          `Recording ${field} must be a positive integer${field === 'port' ? ' at most 65535' : ''}.`,
        );
    } else if (!isNonEmptyString(value[field])) {
      issue(field, `Recording ${field} must be non-empty.`);
    }
  }
  return finishResult(context);
}

/** Shared by SDK admission and the existing lease registry's declared recording binding. */
export function recordingTargetClaimKey(context: {
  backend: string;
  target: RecipeRecordingTarget;
}): string {
  const validation = validateRecipeRecordingTarget(context.target);
  if (!isNonEmptyString(context.backend) || validation.status !== 'valid')
    throw new TypeError(
      `Invalid recording identity: ${validation.findings.map((finding) => finding.message).join('; ') || 'Backend must be non-empty.'}`,
    );
  return `recording/${context.backend}/${digestRecipeDocument(context.target)}`;
}

/** One policy for every recorded-evidence consumer (ADR-062). */
export const EVIDENCE_PADDING_MS = 1_000;
export const RECIPE_CLAIM_KINDS = ['acceptance', 'qa-case', 'qa-check'] as const;
export const RECIPE_ASSERTION_ACTIONS: ReadonlySet<string> = new Set([
  'assert_output',
  'assert_json',
  'assert_file',
  'ui.wait_for',
]);

/** Declared retries retain failed attempts without turning a later successful occurrence into failure. */
export function hasUnresolvedRecipeFailure(entries: readonly unknown[]): boolean {
  return entries.some((entry, index) => {
    if (!isRecord(entry) || entry.ok !== false) return false;
    if (!isNonEmptyString(entry.retryGroup) || !RECIPE_ASSERTION_ACTIONS.has(String(entry.action)))
      return true;
    const later = entries
      .slice(index + 1)
      .filter(isRecord)
      .filter(
        (candidate) =>
          candidate.nodeId === entry.nodeId && candidate.retryGroup === entry.retryGroup,
      );
    return later.at(-1)?.ok !== true;
  });
}
export type RecipeClaimKind = (typeof RECIPE_CLAIM_KINDS)[number];
export const RECIPE_CLAIM_VERDICTS = ACCEPTANCE_VERDICTS;
export type RecipeClaimVerdict = (typeof RECIPE_CLAIM_VERDICTS)[number];
export type RecipeClaimProofMode = 'state' | 'visual' | 'mixed';

/** Extends the existing proofTargets declaration; it is not a second registry. */
export interface RecipeClaimDeclaration {
  id: string;
  claim: string;
  kind?: RecipeClaimKind;
  parentId?: string;
  proofMode?: RecipeClaimProofMode;
}

/** Foreign keys only. Labels, intent and playback ranges come from the trace/timeline. */
export interface EvidenceMomentRef {
  recipeRunId: string;
  videoDigest: string;
  traceIndex: number;
}

/** Verdict and checked references, derived once from the executed proof. */
export interface RecipeClaimEvidence {
  id: string;
  text: string;
  kind: RecipeClaimKind;
  parentId?: string;
  proofMode: RecipeClaimProofMode;
  verdict: RecipeClaimVerdict;
  recipeNodes: string[];
  assertionIndices: number[];
  evidence: string[];
  moments: EvidenceMomentRef[];
  /** Honest timing limitations, independent of the semantic verdict. */
  timing?: 'measured' | 'untimed' | 'outside-recording';
  note?: string;
  /** Repair selection only: the original execution whose proof this row keeps. */
  retainedFrom?: string;
}

export interface RecipeClaimLedger {
  schemaVersion: 2;
  recipeRunId: string;
  criteria: RecipeClaimEvidence[];
  recording: RecordedEvidenceState;
  judgments?: RecipeVisualJudgment[];
}

/** A gate reviewer confirms visual meaning against the exact retained moments. */
export interface RecipeVisualJudgment {
  claimId: string;
  recipeRunId: string;
  verdict: 'confirmed' | 'rejected';
  moments: EvidenceMomentRef[];
  actor: string;
  reason: string;
  judgedAt: string;
}

/** Original media in capture order. A restart gap must never be hidden with held frames. */
export interface RecordingSegmentRef {
  videoPath: string;
  videoDigest: string;
  timelinePath?: string;
  gapBefore?: boolean;
}

export interface RecordedEvidencePolicy {
  mode?: 'auto' | 'full-run' | 'off';
  reason?: string;
  maxFps?: number;
  maxSize?: number;
  maxDurationMs?: number;
  maxBytes?: number;
}

export const DEFAULT_RECORDED_EVIDENCE_POLICY = {
  mode: 'auto',
  maxFps: 15,
  maxSize: 1_080,
  maxDurationMs: 120 * 60 * 1_000,
  maxBytes: 1_024 * 1_024 * 1_024,
} as const satisfies Required<Omit<RecordedEvidencePolicy, 'reason'>>;

export interface RecordedEvidenceState {
  status:
    | 'not-required'
    | 'explicit-off'
    | 'recording'
    | 'finalizing'
    | 'complete'
    | 'incomplete'
    | 'failed';
  reason?: string;
  segments: RecordingSegmentRef[];
}

/** Readers supply identities computed from actual bytes, not hashes copied from a manifest. */
export interface RecordedEvidencePackageInput extends RecipeArtifactPackageInput {
  /** Independently validated immutable comparison packages, never head claim authority. */
  comparisonDependencies?: readonly {
    artifactRoot: string;
    input: RecordedEvidencePackageInput;
  }[];
  recipeRunId?: string;
  artifactDigests: Readonly<Record<string, string>>;
  timelines: Readonly<Record<string, RecipeRecordingTimelineDocument>>;
  claims?: RecipeClaimLedger;
  /** Retained execution-input snapshot; task registration comes from this, never the verdict file. */
  invocation?: unknown;
  /** Retained repair scope and engine claim-source selection, validated before any projection. */
  repair?: { scope: unknown; selection: unknown };
}

export function normalizeRecipeClaimId(id: string): string {
  const match = /^AC-?([1-9][0-9]*)$/iu.exec(id);
  return match ? `AC-${match[1]}` : id;
}

export function validateRecipeClaimDeclarations(value: unknown): RecipeValidationResult {
  const context = createContext();
  const issue = (path: string, message: string) =>
    addFinding(context, 'error', 'recipe.invalid_claim', path, message);
  if (!Array.isArray(value)) {
    issue('proofTargets', 'proofTargets must be an array.');
    return finishResult(context);
  }
  const declarations = new Map<string, string | undefined>();
  for (const [index, target] of value.entries()) {
    const path = `proofTargets[${index}]`;
    if (!isRecord(target)) {
      issue(path, 'A claim must be an object.');
      continue;
    }
    for (const field of Object.keys(target)) {
      if (!['id', 'claim', 'kind', 'parentId', 'proofMode'].includes(field))
        issue(`${path}.${field}`, 'Unknown claim declaration field.');
    }
    if (!isNonEmptyString(target.id) || !isNonEmptyString(target.claim)) {
      issue(path, 'A claim requires a non-empty id and expectation text.');
      continue;
    }
    const id = normalizeRecipeClaimId(target.id);
    if (declarations.has(id)) issue(`${path}.id`, `Duplicate registered claim ${id}.`);
    else declarations.set(id, typeof target.parentId === 'string' ? target.parentId : undefined);
    if (target.kind !== undefined && !RECIPE_CLAIM_KINDS.some((kind) => kind === target.kind))
      issue(`${path}.kind`, 'Unknown claim kind.');
    if (target.parentId !== undefined && !isNonEmptyString(target.parentId))
      issue(`${path}.parentId`, 'Parent claim id must be non-empty.');
    if (
      target.proofMode !== undefined &&
      !['state', 'visual', 'mixed'].includes(String(target.proofMode))
    )
      issue(`${path}.proofMode`, 'Unknown claim proof mode.');
  }
  for (const [id, declaredParent] of declarations) {
    const ancestors = new Set([id]);
    let parent = declaredParent ? normalizeRecipeClaimId(declaredParent) : undefined;
    while (parent) {
      if (!declarations.has(parent)) {
        issue(`proofTargets.${id}.parentId`, `Unknown parent claim ${parent}.`);
        break;
      }
      if (ancestors.has(parent)) {
        issue(`proofTargets.${id}.parentId`, 'Claim parent relationship is cyclic.');
        break;
      }
      ancestors.add(parent);
      const nextParent = declarations.get(parent);
      parent = nextParent ? normalizeRecipeClaimId(nextParent) : undefined;
    }
  }
  return finishResult(context);
}
