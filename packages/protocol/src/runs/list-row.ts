// runs/list-row.ts — honest slim types for run.list served rows.
//
// `RunListRow` is what `run.list` actually serves: a projection of `Run` with
// heavy optional fields dropped and decisions/engineState narrowed to only the
// keys list surfaces read.  Every full `Run` satisfies `RunListRow` (every
// required field that slim keeps is also required or optional on `Run`), so old
// cached fat rows and new slim rows are both valid `RunListRow` values.
import type { AgentContext } from '../contracts/agents.js';
import type { ReviewWorkspaceSubject } from '../contracts/review-workspace.js';
import type {
  NoChangeGatePayload,
  ReadyGatePayload,
  ReviewGatePayload,
  ReviewPolicy,
  Run,
  RunDecision,
  RunDecisionPayload,
  RunEngineState,
  RunMetrics,
  RunReviewResult,
  RunTicketData,
} from '../contracts/runs.js';

import type { RunEvidenceSummary } from './evidence-summary.js';

// ─── Slim payload component types ────────────────────────────────────────────

/** Display-only review-round budget kept on slim list rows. */
export interface RunListReviewRoundBudget {
  used: number;
  remaining: number;
}

/**
 * Slim review policy for list rows: who requested reviews (the policy owner chip) and the
 * minimum (the mini pipeline numbers dispatch review rounds past it).
 */
export type RunListReviewPolicy = Pick<ReviewPolicy, 'requestedBy' | 'minimumReviews'>;

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
  | 'gateSummary'
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
 * Slim decision for run.list rows. The gateway leaves `description` out and keeps
 * each action's id, label and style; every other field stays. Every full
 * `RunDecision` satisfies `RunListDecision`.
 */
export type RunListDecision = Omit<RunDecision, 'description' | 'payload'> & {
  description?: string;
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

// ─── Heavy per-run detail left out ───────────────────────────────────────────
//
// Only the heavy keys go: each averages over 500 B per stored run and no list surface reads
// it. Every other key of these fields is served as the run holds it.

/** An agent context on a list row, without its visual-review blobs, session archive and usage. */
export type RunListAgentContext = Omit<
  AgentContext,
  'pipelineVisualReviewInput' | 'pipelineVisualReviewResult' | 'runnerSessionArchive' | 'usage'
>;

/** Metrics on a list row, without the checklist timing events. */
export type RunListMetrics = Omit<RunMetrics, 'subtasks' | 'checklistTiming'>;

/** Ticket data on a list row, without the ticket's description. */
export type RunListTicketData = Omit<RunTicketData, 'description'>;

/** A review result on a list row, without the review's text and line comments. */
export type RunListReviewResult = Omit<RunReviewResult, 'reviewMd' | 'lineComments'>;

/** A review workspace subject on a list row, without the pull request body. */
export type RunListReviewWorkspaceSubject = Omit<ReviewWorkspaceSubject, 'body'>;

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
  | 'agentContexts'
  | 'metrics'
  | 'ticketData'
  | 'reviewResult'
  | 'reviewWorkspaceSubject'
> & {
  decisions: RunListDecision[];
  engineState?: RunListEngineState;
  agentContexts?: RunListAgentContext[];
  metrics: RunListMetrics;
  ticketData?: RunListTicketData;
  reviewResult?: RunListReviewResult;
  reviewWorkspaceSubject?: RunListReviewWorkspaceSubject;
  /**
   * Set only on a served row that left out a heavy agent-context, metrics, ticket,
   * review-result or review-subject key (see `payloadTrimmed` on decisions and
   * `outputsTrimmed` on steps). A reader that needs one fetches the run.
   */
  detailTrimmed?: true;
  /** Pre-computed at serve time by the gateway; absent on run.get rows. */
  evidenceSummary?: RunEvidenceSummary;
};
