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
}
