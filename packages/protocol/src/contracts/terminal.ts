import type { TmuxWorkerRef } from '../rpc/tmux.js';

import type { AgentRole } from './agents.js';

export interface TerminalData {
  slotId?: string;
  worker?: TmuxWorkerRef;
  runId?: string;
  role?: AgentRole;
  contextId?: string;
  data: string; // terminal output chunk
  timestamp: number;
}
