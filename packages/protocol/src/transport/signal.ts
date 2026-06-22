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
  step?: string; // current step name
  reason?: string; // why blocked/failed
  prNumber?: number; // if worker created a PR
  timestamp: string;
}
