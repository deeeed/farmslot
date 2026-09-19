import type { AgentRole } from '../contracts/index.js';

import type { SlotAgentTargetParams } from './terminal.js';

export interface TaskProgressParams extends SlotAgentTargetParams {
  /**
   * Parse a specific task markdown file instead of the active run/context file.
   * Relative paths are resolved under the slot repo root; absolute paths must
   * still live under that repo root.
   */
  taskFile?: string;
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
}
