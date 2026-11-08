import type { WorkerSignal, WorkerSignalChecklistEvent } from '../transport/signal.js';

import type { AgentRole } from './agents.js';
import type { RunArtifactBundleRef } from './run-bundles.js';

/** One shared projection consumed by analytics, episodes and offline datasets (ADR-032). */
export interface RunActivityRecord {
  schemaVersion: 1;
  process: RunProcessActivity;
}

export interface ProcessAttempt {
  runId: string;
  contextId: string | null;
  attemptId: string | null;
  role: AgentRole | null;
  engineGeneration: number | null;
  startedAt: string | null;
  frozenAt: string;
  executionNodeId: string | null;
}

export interface ProcessActivitySource {
  id: string;
  kind: 'signal' | 'native-events' | 'transcript' | 'task-artifact' | 'git' | 'run-metrics';
  contextId: string | null;
  executionNodeId: string | null;
  /** Comparisons require matching, known clock identities. */
  clockId: string | null;
  sessionId?: string;
  generation?: string;
  leaseId?: string;
  commandId?: string;
  /** Task-relative or retained-source-relative; never a credential or transcript body. */
  path?: string;
  sha256?: string;
  fileIdentity?: string;
  startAfter?: number;
  endAt?: number;
  byteStart?: number;
  byteEnd?: number;
  baseSha?: string;
  headSha?: string;
  notBefore?: string;
  notAfter?: string;
  startLine?: number;
}

export interface ProcessEventRef {
  sourceId: string;
  sequence?: number;
  line?: number;
  toolId?: string;
}

export type ProcessCoverageStatus = 'complete' | 'partial' | 'unavailable';
export interface ProcessCoverage {
  status: ProcessCoverageStatus;
  reason: string;
}
export type ProcessActivityField =
  | 'checklist'
  | 'commits'
  | 'productEdits'
  | 'baseline'
  | 'rootCause'
  | 'markCalls';

export interface ProcessCommit {
  sha: string;
  parents: string[];
  authoredAt: string;
  committedAt: string;
  /** Marker labels require verified marker facts, never just a commit subject. */
  kind: 'debug-marker' | 'marker-removal' | 'other';
  source: ProcessEventRef;
}

export interface ProcessProductEdit {
  /** Request/start observation; completion bounds the successful write from above. */
  at: string;
  completedAt?: string;
  path: string;
  status: 'observed' | 'requested' | 'failed' | 'unknown';
  classification: 'product' | 'diagnostic-marker' | 'unknown';
  source: ProcessEventRef;
  resultSource?: ProcessEventRef;
}

export interface ProcessBaselineRun {
  at: string;
  recipeRunId: string;
  source: ProcessEventRef;
}

export type ProcessMarkTarget =
  | { action: 'step'; stepNumber: number }
  | { action: 'start' | 'complete' | 'block' | 'fail' | 'subtask' | 'unknown' };

export interface ProcessMarkCall {
  at: string;
  toolId: string;
  /** Position inside a compound shell request; repeated marks retain separate identities. */
  commandIndex: number;
  checklist: string | null;
  target: ProcessMarkTarget;
  /** A shell command's success does not prove each nested mark succeeded. */
  status: 'requested' | 'succeeded' | 'failed' | 'unknown';
  source: ProcessEventRef;
  resultSource?: ProcessEventRef;
}

export interface ProcessLabel {
  value: boolean | null;
  reason: string;
  references: ProcessEventRef[];
}

export interface ProcessChecklist {
  events: WorkerSignalChecklistEvent[] | null;
  expectedSteps: number | null;
  complete: boolean | null;
  source: ProcessEventRef | null;
  documentSource?: ProcessEventRef | null;
  workerStatus?: WorkerSignal['status'];
}

/** Frozen original-worker observations. No field grants lifecycle or publication authority. */
export interface RunProcessActivity {
  schemaVersion: 1;
  capturedAt: string;
  attempt: ProcessAttempt;
  sourceBundle?: RunArtifactBundleRef;
  sources: ProcessActivitySource[];
  checklist: ProcessChecklist;
  /** Graph order, oldest first; timestamps alone do not define commit order. */
  commits: ProcessCommit[] | null;
  firstProductEdit: ProcessProductEdit | null;
  firstBaselineRun: ProcessBaselineRun | null;
  rootCause: { present: boolean | null; source: ProcessEventRef | null };
  markCalls: ProcessMarkCall[] | null;
  coverage: Record<ProcessActivityField, ProcessCoverage>;
  labels: {
    skipped_checklist: ProcessLabel;
    fix_before_baseline: ProcessLabel;
  };
}
