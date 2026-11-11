// runs/list-row.ts — honest slim types for run.list served rows.
//
// `RunListRow` is what `run.list` actually serves: a projection of `Run` with
// heavy optional fields dropped and decisions/engineState narrowed to only the
// keys list surfaces read.  Every full `Run` satisfies `RunListRow` (every
// required field that slim keeps is also required or optional on `Run`), so old
// cached fat rows and new slim rows are both valid `RunListRow` values.
import type {
  NoChangeGatePayload,
  ReadyGatePayload,
  ReviewGatePayload,
  Run,
  RunDecision,
  RunDecisionPayload,
  RunEngineState,
} from '../contracts/runs.js';

import type { RunEvidenceSummary } from './evidence-summary.js';

// ─── Slim payload component types ────────────────────────────────────────────

/** Display-only review-round budget kept on slim list rows. */
export interface RunListReviewRoundBudget {
  used: number;
  remaining: number;
}

/**
 * Slim review policy for list rows.  `minimumReviews` is optional because the
 * gateway only keeps `requestedBy` to show the policy owner chip.
 */
export interface RunListReviewPolicy {
  requestedBy: 'dispatch' | 'human-gate' | 'agent-gate';
  minimumReviews?: number;
}

// ─── Slim payload types ───────────────────────────────────────────────────────

/**
 * Slim review gate payload.  Keeps only the display fields the list renders;
 * the full `ReviewGatePayload` satisfies this type.
 */
export interface RunListReviewGatePayload {
  kind: 'review';
  gateReadiness?: ReviewGatePayload['gateReadiness'];
  session?: ReviewGatePayload['session'];
}

/**
 * Slim ready gate payload.  Keeps metadata and display fields; drops the large
 * content fields (workerReport, inputSnapshot, prPackage, reviewMd, ciChecks,
 * etc.) that only the detail view renders.  The full `ReadyGatePayload`
 * satisfies this type.
 */
export type RunListReadyGatePayload = Omit<
  ReadyGatePayload,
  | 'workerReport'
  | 'reviewRoundBudget'
  | 'inputSnapshot'
  | 'prPackage'
  | 'artifactManifest'
  | 'ciChecks'
  | 'reviewSummary'
  | 'reviewVerdict'
  | 'workerLearnings'
  | 'acceptanceCriteria'
  | 'acceptanceStatus'
  | 'currentDescription'
  | 'draftEdits'
  | 'reviewLineageOptions'
  | 'recipeJson'
  | 'recipeQualityArtifact'
  | 'qualityReport'
> & {
  /** Absent on slim rows; present on full rows from run.get. */
  workerReport?: string;
  /** Display-only budget; large computation fields dropped. */
  reviewRoundBudget?: RunListReviewRoundBudget;
};

/**
 * For unhandled decision kinds the gateway keeps only the discriminant.  Every
 * full payload with one of these kinds satisfies this type (required fields
 * beyond `kind` are extra properties that structural typing ignores when
 * assigning to a narrower type).
 */
export type RunListUnhandledPayload = {
  kind: Exclude<RunDecisionPayload['kind'], 'ready' | 'review' | 'no-change'>;
};

/**
 * Decision payload union for run.list rows.
 *
 * - `'review'` → slim: gateReadiness + session only
 * - `'ready'`  → slim: metadata + display fields; large content dropped
 * - `'no-change'` → full type (slim keeps all required fields)
 * - all other kinds → only the discriminant is kept
 */
export type RunListDecisionPayload =
  | RunListReadyGatePayload
  | RunListReviewGatePayload
  | NoChangeGatePayload
  | RunListUnhandledPayload;

// ─── Slim decision type ───────────────────────────────────────────────────────

/**
 * Slim decision for run.list rows.  `id` and `type` are always present;
 * `title`, `description`, `actions`, and `createdAt` are optional because the
 * gateway may omit them on slim rows.  Every full `RunDecision` satisfies
 * `RunListDecision`.
 */
export type RunListDecision = Omit<
  RunDecision,
  'title' | 'description' | 'actions' | 'createdAt' | 'payload'
> & {
  title?: string;
  description?: string;
  actions?: RunDecision['actions'];
  createdAt?: string;
  payload?: RunListDecisionPayload;
};

// ─── Slim engine state ────────────────────────────────────────────────────────

/** Slim publish-gate: uses RunListReviewPolicy instead of the full ReviewPolicy. */
export type RunListPublishGate = Omit<
  NonNullable<RunEngineState['publishGate']>,
  'reviewPolicy'
> & {
  reviewPolicy?: RunListReviewPolicy;
};

/** Slim engine-state for list rows: publishGate uses RunListPublishGate. */
export type RunListEngineState = Omit<RunEngineState, 'publishGate'> & {
  publishGate?: RunListPublishGate;
};

// ─── RunListRow ───────────────────────────────────────────────────────────────

/**
 * A `run.list` served row: a projection of `Run` with heavy optional fields
 * dropped and decisions/engineState narrowed to only the keys list surfaces
 * actually read.
 *
 * Every full `Run` satisfies `RunListRow`, so old cached fat rows and new slim
 * rows are both valid `RunListRow` values.  `evidenceSummary` is a served-only
 * field — the gateway computes it at serve time; `run.get` rows do not carry it.
 */
export type RunListRow = Omit<
  Run,
  | 'decisions'
  | 'engineState'
  | 'resourcePosture'
  | 'sessionUsage'
  | 'visualJudgmentReceipts'
  | 'templateProvenance'
  | 'evidenceSummary'
> & {
  decisions: RunListDecision[];
  engineState?: RunListEngineState;
  /** Pre-computed at serve time by the gateway; absent on run.get rows. */
  evidenceSummary?: RunEvidenceSummary;
};
