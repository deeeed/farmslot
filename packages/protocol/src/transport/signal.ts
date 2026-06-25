// signal.ts — Worker signal file schema for push-based completion detection.
// Workers write SIGNAL.json to their task directory; task-watcher detects it.

import type {
  AgentRole,
  WorkerTerminalDisposition,
  WorkerTerminalEvidence,
} from '../contracts/index.js';

export interface WorkerSignal {
  role?: AgentRole;
  contextId?: string;
  status: 'running' | 'blocked' | 'complete' | 'failed' | 'done' | 'done-partial';
  outcome?: 'success' | 'failure' | 'partial';
  disposition?: WorkerTerminalDisposition;
  evidence?: WorkerTerminalEvidence;
  checklistTiming?: WorkerSignalChecklistTiming;
  step?: string; // current step name
  reason?: string; // why blocked/failed
  prNumber?: number; // if worker created a PR
  timestamp: string;
}

export interface WorkerSignalChecklistTiming {
  schemaVersion: 1;
  /**
   * Stable identifier for the checklist file or prompt section when known
   * (for example `TASK.md` or `CHECKLIST.md`).
   */
  source?: string;
  /**
   * Append-only event history for checklist items the worker has marked done.
   * Consumers derive deltas from the event order and timestamps.
   */
  events: WorkerSignalChecklistEvent[];
}

export interface WorkerSignalChecklistEvent {
  /** 1-based checklist step number, matching the worker-facing `mark N` command. */
  stepNumber: number;
  /** Human-readable checklist text, copied for resilience if the markdown later changes. */
  label: string;
  /** UTC ISO8601 timestamp when the item changed from unchecked to checked. */
  checkedAt: string;
}
