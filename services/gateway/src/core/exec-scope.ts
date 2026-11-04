import { AsyncLocalStorage } from 'node:async_hooks';

import type { SlotVars } from './config.js';
import type { ExecOnSlotOptions, ExecResult } from './exec.js';

export type SlotCommandExecutor = (
  vars: SlotVars,
  command: string,
  options: ExecOnSlotOptions,
) => Promise<ExecResult>;

const execution = new AsyncLocalStorage<SlotCommandExecutor>();

/** Owned workspaces keep nested runner reads and input on their authorized transport. */
export function withSlotCommandExecutor<T>(
  executor: SlotCommandExecutor,
  operation: () => Promise<T>,
): Promise<T> {
  return execution.run(executor, operation);
}

export function currentSlotCommandExecutor(): SlotCommandExecutor | undefined {
  return execution.getStore();
}
