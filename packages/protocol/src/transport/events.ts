// Event definitions — server pushes to subscribed clients

import type {
  AgentRole,
  BacklogItem,
  ChatMessage,
  FleetStatus,
  MachineHealth,
  MonitorViolation,
  PendingDecision,
  PRStatus,
  QueueItem,
  ResourceStateUpdate,
  Run,
  ScriptComplete,
  ScriptOutput,
  SlotStatus,
  StreamFrame,
  StreamStatus,
  TerminalData,
  WorkGraphProjection,
} from '../contracts/index.js';
import type { CIWatchFixProgress, CIWatchFixTrigger, CIWatchPhase } from '../recipes/step-io.js';
import type {
  FileTransferProgress,
  TaskProgressResult,
  WorkerSessionHistoryDeltaPayload,
} from '../rpc/index.js';
import type { TmuxWorkerRef } from '../rpc/tmux.js';

import type { WorkerSignal } from './signal.js';

export const Events = {
  // Fleet state changes
  FLEET_UPDATED: 'fleet.updated',
  SLOT_CHANGED: 'slot.changed',

  // Script execution streaming
  SCRIPT_OUTPUT: 'script.output',
  SCRIPT_COMPLETE: 'script.complete',

  // Slot prepare streaming: structured phase/profile provenance (ADR-037).
  // Raw prepare output rides SCRIPT_OUTPUT.
  SLOT_PREPARE_STEP: 'slot.prepare.step',
  SLOT_PREPARE_DONE: 'slot.prepare.done',

  // Fleet bulk refresh (FLEET_REFRESH_SLOTS)
  FLEET_REFRESH_SCHEDULED: 'fleet.refresh.scheduled',
  FLEET_REFRESH_SLOT_UPDATE: 'fleet.refresh.slot-update',
  FLEET_REFRESH_SUMMARY: 'fleet.refresh.summary',

  // Terminal streaming
  TERMINAL_DATA: 'terminal.data',
  TERMINAL_MODE: 'terminal.mode',
  TERMINAL_EXITED: 'terminal.exited',
  WORKER_SESSION_HISTORY_DELTA: 'worker.session.history.delta',

  // PR updates
  PR_UPDATED: 'pr.updated',

  // Decisions
  DECISION_NEW: 'decision.new',
  DECISION_RESOLVED: 'decision.resolved',
  DECISION_UPDATED: 'decision.updated',

  // Monitor
  MONITOR_VIOLATION: 'monitor.violation',

  // Nodes (per-machine daemon)
  NODE_CONNECTED: 'node.connected',
  NODE_DISCONNECTED: 'node.disconnected',
  NODE_VERSION_MISMATCH: 'node.version.mismatch',

  // Task progress
  TASK_PROGRESS_UPDATED: 'task.progress.updated',

  // Worker signal (push-based completion/status)
  WORKER_SIGNAL: 'worker.signal',

  // Tmux worker inventory/status (node-pushed; gateway-enriched)
  TMUX_WORKER_INVENTORY_UPDATED: 'tmux.worker.inventory.updated',

  // Workspace
  WORKSPACE_METRO_DATA: 'workspace.metro.data',

  // Stream
  STREAM_FRAME: 'stream.frame',
  STREAM_STATUS: 'stream.status',

  // Dispatch queue
  QUEUE_UPDATED: 'queue.updated',

  // Backlog
  BACKLOG_UPDATED: 'backlog.updated',

  // Work graph
  WORK_GRAPH_UPDATED: 'workGraph.updated',

  // CI
  CI_CHECK_UPDATED: 'ci.check.updated',

  // Runs
  RUN_CREATED: 'run.created',
  RUN_UPDATED: 'run.updated',
  RUN_COMPLETED: 'run.completed',
  RUN_STEP_COMPLETED: 'run.step.completed',
  RUN_DECISION_NEW: 'run.decision.new',
  RUN_DECISION_RESOLVED: 'run.decision.resolved',
  RUN_DECISION_UPDATED: 'run.decision.updated',
  RUN_DELETED: 'run.deleted',
  RUN_IMPROVEMENT_FAILED: 'run.improvement.failed',

  // Connection
  HELLO: 'hello',

  // Co-Pilot Chat
  CHAT_RESPONSE: 'chat.response',
  CHAT_MEMORY_SAVED: 'chat.memory.saved',
  COPILOT_OBSERVER_NOTIFICATION: 'copilot.observer.notification',

  // Node Health
  NODE_HEALTH_UPDATED: 'node.health.updated',

  // Resource Health
  RESOURCE_STATUS_UPDATED: 'resource.status.updated',
  RESOURCE_RELAUNCHED: 'resource.relaunched',

  // Fleet Thumbnails
  FLEET_THUMBNAILS_UPDATED: 'fleet.thumbnails.updated',

  // GitHub API observability
  GITHUB_RATE_LIMIT: 'github.rateLimit',

  // LLM auth (browser-based login progress)
  LLM_AUTH_LOGIN_PROGRESS: 'llm.auth.login.progress',

  // Large remote file transfer progress (node ↔ gateway ↔ CC)
  FILE_TRANSFER_PROGRESS: 'file.transfer.progress',
} as const;

// ─── Event payload types ───
// Every event subscriber gets a typed payload via GatewayClient.subscribe<T>()

export interface FleetUpdatedPayload {
  fleet: FleetStatus;
}

export interface SlotChangedPayload {
  slot: SlotStatus;
}

export interface ScriptOutputPayload extends ScriptOutput {}

export interface ScriptCompletePayload extends ScriptComplete {}

export interface SlotPrepareStepPayload {
  requestId: string;
  slotId: string;
  name: string;
  detail: string;
}

export interface TerminalDataPayload extends TerminalData {}

export interface TerminalModePayload {
  slotId?: string;
  worker?: TmuxWorkerRef;
  runId?: string;
  role?: AgentRole;
  contextId?: string;
  mode: string;
}

export interface TerminalExitedPayload {
  slotId?: string;
  worker?: TmuxWorkerRef;
  runId?: string;
  role?: AgentRole;
  contextId?: string;
  exitCode: number;
}

export interface WorkerSessionHistoryDeltaEventPayload extends WorkerSessionHistoryDeltaPayload {}

export interface PRUpdatedPayload {
  pr: PRStatus;
}

export interface DecisionNewPayload {
  decision?: PendingDecision;
  slotId?: string | null;
  runId?: string;
  // Some emitters spread the decision fields directly onto the payload root
  id?: string;
  type?: string;
  title?: string;
  description?: string;
  context?: Record<string, unknown>;
  actions?: PendingDecision['actions'];
  createdAt?: string;
}

export interface DecisionResolvedPayload {
  id?: string;
  decisionId?: string;
}

export interface DecisionUpdatedPayload {
  decision: PendingDecision;
  runId?: string;
}

export interface MonitorViolationPayload {
  violation: MonitorViolation;
}

export interface NodeConnectedPayload {
  machine: string;
  pid: number;
  protocolVersion?: string;
  versionMatch?: boolean;
  capabilities?: import('../recipe/common.js').RecipeRuntimeCapabilityDeclaration[];
}

export interface NodeDisconnectedPayload {
  machine: string;
}

export interface NodeVersionMismatchPayload {
  machine: string;
  nodeVersion: string;
  gatewayVersion: string;
}

export interface TaskProgressUpdatedPayload {
  slotId: string;
  runId: string | null;
  role?: AgentRole;
  contextId?: string;
  progress: TaskProgressResult;
}

export interface WorkerSignalPayload {
  slotId: string;
  runId?: string | null;
  role?: AgentRole;
  contextId?: string;
  signal: WorkerSignal;
}

export interface TmuxWorkerInventoryUpdatedPayload {
  result: import('../rpc/tmux.js').TmuxWorkerListResult;
}

export interface WorkspaceMetroDataPayload {
  slotId: string;
  data: string;
}

export interface StreamFramePayload extends StreamFrame {}

export interface StreamStatusPayload extends StreamStatus {}

export interface QueueUpdatedPayload {
  items: QueueItem[];
}

export interface BacklogUpdatedPayload {
  items: BacklogItem[];
}

export interface CiCheckSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** Optional: absent in persisted run outputs written before skipped tracking. */
  skipped?: number;
}

export interface CiCheckUpdatedPayload {
  runId: string;
  prNumber: number;
  checkSummary: CiCheckSummary;
  recommendation: string;
  passedNames: string[];
  failedNames: string[];
  pendingNames: string[];
  pollCount: number;
  pollIntervalMs?: number;
  lastCheckedAt?: string;
  phase?: CIWatchPhase;
  fixInProgress?: boolean;
  fixTrigger?: CIWatchFixTrigger;
  fixProgress?: CIWatchFixProgress;
  activeTaskFile?: string | null;
  nextPollAt?: string | null;
  lastSignalAt?: string | null;
  dedupReason?: string | null;
  lastFixCommitSha?: string | null;
  timeoutWindowStartedAt?: string;
  lastProgressAt?: string;
  lastProgressReason?: string;
}

export interface RunCreatedPayload {
  run: Run;
}

export interface RunUpdatedPayload {
  run: Run;
}

export interface RunCompletedPayload {
  run: Run;
}

export interface RunStepCompletedPayload {
  runId: string;
  stepName: string;
  run?: Run;
}

export interface RunDecisionNewPayload {
  runId: string;
  decision: PendingDecision;
  slotId?: string | null;
}

export interface RunDecisionResolvedPayload {
  runId: string;
  decisionId: string;
}

export interface RunImprovementFailedPayload {
  runId: string;
  error: string;
}

export interface RunDeletedPayload {
  runId: string;
}

export interface HelloPayload {
  fleet: FleetStatus | null;
}

export interface ChatResponsePayload {
  sessionId: string;
  seq?: number;
  state: 'delta' | 'final' | 'error' | 'aborted';
  text?: string;
  statusText?: string;
  message?: ChatMessage;
  suggestedActions?: ChatMessage['suggestedActions'];
  errorMessage?: string;
}

export interface ChatMemorySavedPayload {
  path: string;
  sessionId?: string;
}

export interface CopilotObserverNotificationPayload {
  id: string;
  ts: string;
  type: string;
  severity: 'warn' | 'error';
  summary: string;
  slotId?: string;
  runId?: string;
}

export interface NodeHealthUpdatedPayload {
  machine: string;
  health: MachineHealth;
}

export interface ResourceStatusUpdatedPayload {
  slotId: string;
  resources: ResourceStateUpdate[];
}

// Emitted by the node when a pid-file watcher observes a
// running -> stopped -> running cycle inside a short coalescing window.
// Consumers rebind streams to `newPid` instead of re-subscribing.
export interface ResourceRelaunchedPayload {
  slotId: string;
  resourceId: string;
  oldPid: number;
  newPid: number;
  at: string;
}

export interface GitHubRateLimitPayload {
  remaining: number;
  limit: number;
  resetAt: string;
  percentUsed: number;
}

export interface FleetThumbnail {
  data: string;
  width: number;
  height: number;
  ts: number;
}

export interface FleetThumbnailsUpdatedPayload {
  thumbnails: Record<string, FleetThumbnail>;
}

export interface WorkGraphUpdatedPayload {
  graph: WorkGraphProjection;
}

export interface FileTransferProgressPayload extends FileTransferProgress {}
