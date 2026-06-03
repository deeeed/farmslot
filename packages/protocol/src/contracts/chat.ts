import type { AgentRole } from './agents.js';
import type { RunStatus } from './runs.js';

export interface ChatToolTraceEntry {
  callId: string;
  toolName: string;
  round: number;
  status: 'ok' | 'error';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  argsSummary?: string;
  resultSummary: string;
  outputSize: number;
  truncated: boolean;
  summaryKind:
    | 'json-shape'
    | 'text'
    | 'file-read'
    | 'log-read'
    | 'run-bundle'
    | 'investigation-report'
    | 'error';
}

export type ChatSendIntent = 'general' | 'diagnostic-readonly';

export interface RouteContextSelectors {
  route?: string;
  hash?: string;
  routePattern?: string;
  query?: Record<string, string>;
  selectedRunId?: string;
  selectedFamilyId?: string;
  selectedStepName?: string;
  selectedSlotId?: string;
  selectedDecisionId?: string;
  selectedConfigName?: string;
  selectedPullRequestNumber?: string;
  selectedPullRequestRepo?: string;
  selectedPullRequestRef?: string;
  compareRunIds?: string[];
  affordances?: string[];
  visibleElementTags?: string[];
  visibleTextSnippets?: string[];
  visibleControls?: string[];
}

export interface ChatClientContext extends RouteContextSelectors {
  url?: string;
  surfaceId?: string;
}

export interface ScreenEvidenceSnapshot extends RouteContextSelectors {
  snapshotId: string;
  sessionId: string;
  requestId?: string;
  surfaceId: string;
  preferredTools?: string[];
  capturedAt: string;
  ttlMs: number;
  expiresAt: string;
  freshness: 'fresh' | 'stale' | 'expired';
  provenance: Array<
    'ui-client-context' | 'surface-registry' | 'visible-dom-snippets' | 'gateway-cache'
  >;
  uncertainty: Array<
    | 'none'
    | 'unknown-route'
    | 'missing-ui-context'
    | 'stale'
    | 'expired'
    | 'partial-visible-context'
  >;
}

export type ObserverEvidenceSeverity = 'info' | 'warn' | 'error';

export interface ObserverEvidenceFilters {
  severity?: ObserverEvidenceSeverity;
  type?: string;
  runId?: string;
  slotId?: string;
}

export interface ObserverEvidenceQuery extends ObserverEvidenceFilters {
  windowMs?: number;
  limit?: number;
}

export interface ObserverEvidenceEvent {
  id: string;
  ts: string;
  type: string;
  severity: ObserverEvidenceSeverity;
  summary: string;
  runId?: string;
  slotId?: string;
}

export interface ObserverAttentionRecommendation {
  id: string;
  severity: Exclude<ObserverEvidenceSeverity, 'info'>;
  summary: string;
  runId?: string;
  slotId?: string;
  sourceEventIds: string[];
}

export interface ObserverEvidenceResult {
  generatedAt: string;
  windowMs: number;
  limit: number;
  truncated: boolean;
  filters: ObserverEvidenceFilters;
  events: ObserverEvidenceEvent[];
  attention: ObserverAttentionRecommendation[];
  provenance: string[];
  freshness: 'fresh' | 'empty';
  uncertainty: Array<
    'none' | 'empty' | 'filtered' | 'filter-truncated' | 'truncated' | 'events-dropped-by-window'
  >;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  scope: 'global' | 'run' | 'family' | 'slot' | 'manual' | 'unknown';
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastPreview?: string;
  lastSavedAt?: string;
  /** False when the session is ephemeral (in-memory only). Pinned sessions persist to disk. */
  pinned?: boolean;
}

export interface ChatNextStep {
  id: string;
  label: string;
  kind: 'prompt' | 'read';
  safety: 'read-only';
  params: Record<string, unknown>;
}

// ─── Run recovery proposal ───

export type RunRecoveryProposalStatus = 'ready' | 'insufficient-evidence' | 'unavailable';
export type RunRecoveryProposalConfidence = 'high' | 'medium' | 'low';

export interface RunRecoveryProposalTarget {
  runId: string;
  stepName?: string;
  flowType?: string;
  status?: RunStatus;
  project?: string;
  ticketOrPr?: string;
  slotId?: string | null;
}

export interface RunRecoveryEvidence {
  id: string;
  source:
    | 'run-state'
    | 'run-context-bundle'
    | 'task-artifact'
    | 'observer-evidence'
    | 'screen-context'
    | 'source-inspection'
    | 'registered-log';
  label: string;
  provenance: string;
  excerpt?: string;
  path?: string;
}

export type FailureCategory = 'flake' | 'infra' | 'env-drift' | 'timeout';

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  'flake',
  'infra',
  'env-drift',
  'timeout',
] as const;

export const RECOVERABLE_FAILURE_CATEGORIES: ReadonlySet<FailureCategory> =
  new Set<FailureCategory>(['flake', 'infra', 'env-drift', 'timeout']);

export interface RunRecoveryDescriptor {
  id: string;
  label: string;
  description: string;
  policyRef?: string;
  failureCategory?: FailureCategory;
  proposedActions?: ChatSuggestedAction[];
}

export interface RunRecoveryProposal {
  status: RunRecoveryProposalStatus;
  target: RunRecoveryProposalTarget;
  finding: string;
  evidence: RunRecoveryEvidence[];
  confidence: RunRecoveryProposalConfidence;
  inferenceNotes: string[];
  nextSteps: ChatNextStep[];
  remediationDescriptors?: RunRecoveryDescriptor[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  suggestedActions?: ChatSuggestedAction[];
  nextSteps?: ChatNextStep[];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  toolTrace?: ChatToolTraceEntry[];
}

export interface ChatSuggestedAction {
  actionId?: string;
  type: string; // Gateway-owned action type, e.g. 'run.delete', 'terminal.send', or 'decision.resolve'
  label: string;
  params: Record<string, unknown>;
  expiresAt?: string;
}

export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  title?: string;
  lastSavedAt?: string;
  /** False/missing = ephemeral (in-memory only). True = persisted to disk. */
  pinned?: boolean;
}

/** Typed reasons the gateway rejects a chat.confirmAction request. The WS
 *  error frame surfaces these as `code: 'CHAT_ACTION_REJECT_<UPPER_SNAKE>'`
 *  via `chatActionRejectCode()` so the UI can classify rejections without
 *  parsing message text. New reasons must be added in one place; both the
 *  gateway throw and the UI's "unavailable" set derive from this list. */
export type ChatActionRejectReason =
  | 'unknown'
  | 'expired'
  | 'consumed'
  | 'cross-session'
  | 'snapshot-mismatch'
  | 'precondition-fail';

export const CHAT_ACTION_REJECT_REASONS: readonly ChatActionRejectReason[] = [
  'unknown',
  'expired',
  'consumed',
  'cross-session',
  'snapshot-mismatch',
  'precondition-fail',
];

export function chatActionRejectCode(reason: ChatActionRejectReason): string {
  return `CHAT_ACTION_REJECT_${reason.toUpperCase().replace(/-/g, '_')}`;
}

export interface MonitorViolation {
  slotId: string;
  role?: AgentRole;
  contextId?: string;
  target?: string;
  type: 'stuck' | 'skipped' | 'idle' | 'waiting' | 'error';
  message: string;
  nudgeSent: string | null;
  timestamp: string;
}
