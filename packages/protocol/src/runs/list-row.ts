// runs/list-row.ts — honest slim types for run.list served rows.
//
// `RunListRow` is what `run.list` actually serves: a `Run` without its heavy keys.
// Every full `Run` satisfies `RunListRow`, so old cached fat rows and new slim rows are
// both valid `RunListRow` values.
import type { AgentContext } from '../contracts/agents.js';
import type { ReviewWorkspaceSubject } from '../contracts/review-workspace.js';
import type {
  ReadyGatePayload,
  RetrospectivePayload,
  ReviewGatePayload,
  Run,
  RunDecision,
  RunDecisionPayload,
  RunEngineState,
  RunMetrics,
  RunReviewResult,
  RunTicketData,
} from '../contracts/runs.js';

import type { RunEvidenceSummary } from './evidence-summary.js';

// ─── Decisions and engine state ──────────────────────────────────────────────
//
// A decision is served as `trimRunForList` serves it (a payload value over
// RUN_LIST_PAYLOAD_VALUE_LIMIT is left out and named in `payloadTrimmed`), minus the heavy
// keys below. Each averages over 500 B per stored run and no list surface reads it; every
// other key is served as the run holds it.

/** A ready gate payload on a list row, without its package, snapshots, report and summary. */
export type RunListReadyGatePayload = Omit<
  ReadyGatePayload,
  | 'prPackage'
  | 'currentDescription'
  | 'recipeJson'
  | 'inputSnapshot'
  | 'gateSummary'
  | 'workerReport'
>;

/** A review gate payload on a list row, without the review's text and line comments. */
export type RunListReviewGatePayload = Omit<ReviewGatePayload, 'reviewMd' | 'lineComments'>;

/** A retrospective payload on a list row, without its gate summary. */
export type RunListRetrospectivePayload = Omit<RetrospectivePayload, 'gateSummary'>;

/** A decision payload on a list row: the three kinds above, every other kind whole. */
export type RunListDecisionPayload =
  | RunListReadyGatePayload
  | RunListReviewGatePayload
  | RunListRetrospectivePayload
  | Exclude<RunDecisionPayload, ReadyGatePayload | ReviewGatePayload | RetrospectivePayload>;

/** A decision on a list row, without the resolver's selection and the evidence attestation. */
export type RunListDecision = Omit<
  RunDecision,
  'selectionData' | 'evidenceAttestation' | 'payload'
> & {
  payload?: RunListDecisionPayload;
};

/** Engine state on a list row, without the publish gate's summary. */
export type RunListEngineState = Omit<RunEngineState, 'publishGate'> & {
  publishGate?: Omit<NonNullable<RunEngineState['publishGate']>, 'gateSummary'>;
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
 * A `run.list` served row: a `Run` without its heavy keys, with the step outputs
 * list surfaces read.
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
   * Set only on a served row that left out a heavy key outside decision payloads and step
   * outputs: on an agent context, the metrics, the ticket, the review result, the review
   * subject, a decision or the publish gate (see `payloadTrimmed` on decisions and
   * `outputsTrimmed` on steps). A reader that needs one fetches the run.
   */
  detailTrimmed?: true;
  /** Pre-computed at serve time by the gateway; absent on run.get rows. */
  evidenceSummary?: RunEvidenceSummary;
};
