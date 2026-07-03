import type { AgentRole } from '../contracts/index.js';

import { Methods } from './registry.js';

export const WorkerSessionHistoryMethods = {
  get: Methods.WORKER_SESSION_HISTORY_GET,
  subscribe: Methods.WORKER_SESSION_HISTORY_SUBSCRIBE,
  unsubscribe: Methods.WORKER_SESSION_HISTORY_UNSUBSCRIBE,
} as const;

export type WorkerSessionHistorySource = 'transcript' | 'pane-degraded' | 'unavailable';

export interface WorkerSessionHistoryTool {
  id?: string;
  name: string;
}

export interface WorkerSessionHistoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  tools?: WorkerSessionHistoryTool[];
  at?: string;
}

export interface WorkerSessionHistoryCursor {
  path: string;
  offset: number;
  mtimeMs?: number;
  messageCount: number;
}

export interface WorkerSessionHistoryTargetParams {
  /** Optional when runId is supplied; slot-scoped views use this to follow the loaded slot run. */
  slotId?: string;
  runId?: string;
  role?: AgentRole;
  contextId?: string;
}

export interface WorkerSessionHistoryGetParams extends WorkerSessionHistoryTargetParams {
  limit?: number;
}

export type WorkerSessionHistorySubscribeParams = WorkerSessionHistoryGetParams;

export interface WorkerSessionHistoryUnsubscribeParams extends WorkerSessionHistoryTargetParams {}

export interface WorkerSessionHistorySnapshot {
  slotId?: string | null;
  runId?: string | null;
  role?: AgentRole;
  contextId?: string;
  runner: string | null;
  model?: string | null;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
  source: WorkerSessionHistorySource;
  messages: WorkerSessionHistoryMessage[];
  cursor?: WorkerSessionHistoryCursor;
  truncated?: boolean;
  degradedReason?: string;
  generatedAt: string;
}

export interface WorkerSessionHistoryGetResult {
  snapshot: WorkerSessionHistorySnapshot;
}

export interface WorkerSessionHistorySubscribeResult extends WorkerSessionHistoryGetResult {
  subscribed: boolean;
}

export interface WorkerSessionHistoryUnsubscribeResult {
  unsubscribed: boolean;
}

export interface WorkerSessionHistoryDeltaPayload {
  slotId?: string | null;
  runId?: string | null;
  role?: AgentRole;
  contextId?: string;
  runner: string | null;
  model?: string | null;
  runnerSessionPath?: string | null;
  source: WorkerSessionHistorySource;
  messages: WorkerSessionHistoryMessage[];
  cursor?: WorkerSessionHistoryCursor;
  reset?: boolean;
  degradedReason?: string;
  generatedAt: string;
}
