import type { AgentRole } from '../contracts/index.js';

import type { SlotAgentTargetParams } from './terminal.js';

export interface TaskProgressParams extends SlotAgentTargetParams {
  /**
   * Parse a specific task markdown file instead of the active run/context file.
   * Relative paths are resolved under the slot repo root; absolute paths must
   * still live under that repo root.
   */
  taskFile?: string;
  /**
   * List views: return only `summary`, without the markdown, child units, timing,
   * operations, acceptance data or live spend, so the read costs the checklist alone.
   */
  summary?: true;
}

/** Done/total and the current step: all a list row shows of a checklist. */
export type TaskProgressSummary = Pick<
  import('../contracts/index.js').TaskProgressStructured,
  'completedSteps' | 'totalSteps' | 'currentPhase' | 'currentStep'
>;

/** Spend of the viewed agent session so far, from the transcript bytes appended since the last read. */
export interface TaskLiveSpend {
  runner: string;
  /** When the gateway last read the transcript; at most one read per session every 15 s. */
  readAt: string;
  /** Null when the runner records no timed token usage. */
  totalTokens: number | null;
  /** Null when a token record has no recorded or listed price. */
  costUsd: number | null;
  /** Null when the runner records no compaction events. */
  compactions: number | null;
  toolCalls: number;
  /** Closed checklist steps, then the open one. */
  steps: import('../contracts/runs.js').SessionToolUsageSegment[];
  /** Why there are no numbers: no transcript yet, a runner without one appendable file, a read failure. */
  unavailable?: string;
  /** Transcript bytes not read yet (catching up after a gateway restart); the numbers are partial. */
  behindBytes?: number;
}

export interface TaskProgressResult {
  slotId: string;
  role?: AgentRole;
  contextId?: string;
  markdown: string;
  structured?: import('../contracts/index.js').TaskProgressStructured;
  /**
   * The run's acceptance-criteria ledger (ADR-060), when the task directory has
   * one. It belongs to the task directory rather than to any single step, so it
   * rides beside `structured` and travels on the progress broadcast as well.
   */
  acceptanceStatus?: import('../contracts/index.js').AcceptanceStatusLedger;
  /**
   * Every acceptance criterion the task directory registered (`inputs/handoff.json`),
   * in id order. Present whenever the run has criteria, even before any verdict is
   * recorded, so a client can show a criterion as awaiting one instead of hiding it.
   */
  acceptanceCriteria?: import('../contracts/index.js').AcceptanceCriterionRef[];
  /**
   * Why the ledger or the criteria list could not be read. Present instead of a
   * silent absence, so a client shows "unreadable" rather than "no criteria" —
   * the two mean very different things for a run's proof.
   */
  acceptanceStatusError?: string;
  /**
   * `ledger` when `acceptanceStatus` is present; `evidence-manifest` when the run
   * retains historical `acceptanceEvidenceLinks` from the manifest's
   * `covers`. Absent when neither applies.
   */
  acceptanceSource?: import('../contracts/index.js').AcceptanceStatusSource;
  /**
   * Criteria the evidence manifest links files to, for a run with no ledger.
   * Evidence linked, not proven: no verdict, and no gate or check reads it.
   */
  acceptanceEvidenceLinks?: import('../contracts/index.js').AcceptanceEvidenceLink[];
  /**
   * Why the evidence manifest the fallback reads could not be read, so a client
   * can tell an unreadable manifest from one that covers no criterion. Never a
   * ledger error: `acceptanceStatusError` keeps that meaning.
   */
  acceptanceEvidenceLinksError?: string;
  /** Live tokens, cost, compactions and tool calls of the viewed agent session. */
  liveSpend?: TaskLiveSpend;
  /** Present instead of `structured` when the read asked for `summary`. */
  summary?: TaskProgressSummary;
}
