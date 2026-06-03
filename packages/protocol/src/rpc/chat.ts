import { Methods } from './registry.js';

export const ChatMethods = {
  operatorSnapshot: Methods.OPERATOR_SNAPSHOT,
  send: Methods.CHAT_SEND,
  history: Methods.CHAT_HISTORY,
  clear: Methods.CHAT_CLEAR,
  newSession: Methods.CHAT_NEW,
  sessions: Methods.CHAT_SESSIONS,
  sessionCreate: Methods.CHAT_SESSION_CREATE,
  sessionDelete: Methods.CHAT_SESSION_DELETE,
  sessionsBulkDelete: Methods.CHAT_SESSIONS_BULK_DELETE,
  sessionPin: Methods.CHAT_SESSION_PIN,
  screenEvidence: Methods.CHAT_SCREEN_EVIDENCE,
  observerEvidence: Methods.CHAT_OBSERVER_EVIDENCE,
  saveMemory: Methods.CHAT_SAVE_MEMORY,
  confirmAction: Methods.CHAT_CONFIRM_ACTION,
  listActions: Methods.CHAT_LIST_ACTIONS,
  abort: Methods.CHAT_ABORT,
  context: Methods.CHAT_CONTEXT,
  sessionContext: Methods.CHAT_SESSION_CONTEXT,
} as const;

// ─── Co-Pilot Chat param/result types ───

export interface ChatSendParams {
  sessionId?: string;
  message: string;
  clientContext?: import('../contracts/index.js').ChatClientContext;
  intent?: import('../contracts/index.js').ChatSendIntent;
}

export interface ChatSendResult {
  messageId: string;
}

export interface ChatHistoryParams {
  sessionId?: string;
  limit?: number;
}

export interface ChatHistoryResult {
  messages: import('../contracts/index.js').ChatMessage[];
}

export interface ChatClearParams {
  sessionId?: string;
}

export interface ChatClearResult {}

export interface ChatNewParams {
  sessionId?: string;
}

export interface ChatNewResult {
  savedPath?: string;
}

export interface ChatSessionsResult {
  sessions: import('../contracts/index.js').ChatSessionSummary[];
}

export interface ChatSessionCreateParams {
  title?: string;
  sessionId?: string;
  /** When true, the new session is persisted to disk immediately. Default: false (ephemeral). */
  pinned?: boolean;
}

export interface ChatSessionCreateResult {
  session: import('../contracts/index.js').ChatSessionSummary;
}

export interface ChatSessionDeleteParams {
  sessionId: string;
}

export interface ChatSessionDeleteResult {
  ok: true;
  /** True when the session was found and removed (in-memory and on disk). */
  deleted: boolean;
}

export interface ChatSessionsBulkDeleteParams {
  sessionIds: string[];
}

export interface ChatSessionsBulkDeleteResult {
  /** Count of sessions actually removed (excludes ids that did not exist). */
  deleted: number;
}

export interface ChatSessionPinParams {
  sessionId: string;
}

export interface ChatSessionPinResult {
  session: import('../contracts/index.js').ChatSessionSummary;
}

export interface ChatScreenEvidenceParams {
  sessionId?: string;
}

export interface ChatScreenEvidenceResult {
  snapshot: import('../contracts/index.js').ScreenEvidenceSnapshot | null;
}

export type ChatObserverEvidenceParams = import('../contracts/index.js').ObserverEvidenceQuery;

export interface ChatObserverEvidenceResult {
  evidence: import('../contracts/index.js').ObserverEvidenceResult;
}

export interface ChatSaveMemoryParams {
  content: string;
}

export interface ChatSaveMemoryResult {}

export interface ChatConfirmActionParams {
  sessionId: string;
  actionId: string;
}

export interface ChatConfirmActionResult {
  ok: true;
  actionId: string;
  type: string;
  consumedAt: string;
  result?: Record<string, unknown>;
}

export interface ChatListActionsParams {
  sessionId: string;
}

export interface ChatListActionsResult {
  actions: Array<{
    actionId: string;
    type: string;
    params: Record<string, unknown>;
    issuedAt: string;
  }>;
}

export interface ChatAbortParams {
  sessionId?: string;
}
export interface ChatAbortResult {}

export interface ChatContextResult {
  context: string;
  generatedAt: string;
  charCount: number;
}

export interface ChatSessionContextParams {
  sessionId?: string;
}

export interface ChatSessionContextResult {
  sessionId: string;
  generatedAt: string;
  model: {
    provider: string;
    configuredModel: string;
    runtimeIdentity: string;
  };
  messages: {
    total: number;
    user: number;
    assistant: number;
    system: number;
  };
  usage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    lastInputTokens?: number;
    lastOutputTokens?: number;
    lastCostUsd?: number;
  };
  contextWindow: {
    estimatedMaxTokens: number | null;
    warningThresholdTokens: number;
    lastInputPct: number | null;
    remainingInputTokens: number | null;
    note: string;
  };
  compaction: {
    automatic: false;
    jumpsUntilCompact: null;
    status: 'not-implemented';
    note: string;
  };
}

export interface OperatorSnapshotResult {
  generatedAt: string;
  sources: Record<string, string>;
  counts: {
    totalSlots: number;
    readySlots: number;
    busySlots: number;
    heldSlots: number;
    activeRuns: number;
    queuedItems: number;
    pendingDecisions: number;
    recentEvents: number;
  };
  fleet: {
    checkedAt?: string;
    summary?: import('../contracts/index.js').FleetSummary;
  };
  machines: Array<{
    machine: string;
    online: boolean;
    headroom: string;
    cpuPercent?: number;
    memoryPercent?: number;
    diskPercent?: number;
    loadAvg1?: number;
  }>;
  activeRuns: Array<{
    id: string;
    flowType: string;
    status: string;
    step?: string;
    slotId?: string | null;
    ticketOrPr: string;
    pendingDecisions: number;
  }>;
  queue: Array<{
    id: string;
    flowType: string;
    project: string;
    ticketOrPr: string;
    slotId?: string;
    priority: number;
    createdAt: string;
  }>;
  pendingDecisions: Array<{
    id: string;
    type: string;
    title: string;
    runId?: string | null;
    slotId?: string | null;
    ticketOrPr?: string | null;
    createdAt: string;
    actions: string[];
  }>;
  recentEvents: Array<{
    id: string;
    ts: string;
    type: string;
    severity: 'info' | 'warn' | 'error';
    summary: string;
    slotId?: string;
    runId?: string;
  }>;
}

export interface RunContextBundleParams {
  runId: string;
}

export interface RunContextBundleResult {
  generatedAt: string;
  sources: Record<string, string>;
  run: {
    id: string;
    familyId: string;
    parentRunId?: string | null;
    flowType: string;
    status: string;
    project: string;
    ticketOrPr: string;
    slotId?: string | null;
    branch?: string | null;
    prNumber?: number;
    summary?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
  };
  currentSteps: Array<{
    name: string;
    status: string;
    detail?: string;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  }>;
  pendingDecisions: Array<{
    id: string;
    type: string;
    title: string;
    createdAt: string;
    actions: string[];
  }>;
  taskFiles: Array<{
    label: string;
    path: string;
    content: string;
    truncated: boolean;
  }>;
  artifacts: Array<{
    label: string;
    path: string;
    content: string;
    truncated: boolean;
  }>;
}

export interface RunRecoveryProposalParams {
  runId: string;
  stepName?: string;
  screenContext?: import('../contracts/index.js').RouteContextSelectors;
}

export interface RunRecoveryProposalResult {
  proposal: import('../contracts/index.js').RunRecoveryProposal;
}
