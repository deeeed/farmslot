import { setTimeout as delay } from 'node:timers/promises';

import type { SlotVars } from '../../core/config.js';

import { runHealthCheck, runUnlockHook } from './check.js';
import type { PrepareCommandError } from './shared.js';

export interface PrepareHealthCommands {
  health: string;
  unlock: string;
  parse: string;
  failedCommand: string;
}

export const PREPARE_HEALTH_TIMEOUT_MS = 5 * 60_000;
const HEALTH_POLL_MS = 2_000;

/** Allow the first dev-server compile to finish, without restarting it. */
export async function verifyPrepareHealth(
  vars: SlotVars,
  commands: PrepareHealthCommands,
  readyIndicator: string,
  step: (name: string, detail: string) => void,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? PREPARE_HEALTH_TIMEOUT_MS);
  const readHealth = () => {
    options.signal?.throwIfAborted();
    return runHealthCheck(vars, commands.health, commands.parse, {
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal: options.signal,
    });
  };
  const heartbeat = setInterval(() => {
    step('health', `Waiting for health (${Math.round((Date.now() - started) / 1000)} s)...`);
  }, 15_000);
  try {
    let healthValue = await readHealth();
    if (!readyIndicator || healthValue === readyIndicator) return healthValue;

    let unlockFailure: string | null = null;
    if (commands.unlock) {
      step('health', 'Trying unlock...');
      unlockFailure = await runUnlockHook(vars, commands.unlock, {
        signal: options.signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      healthValue = await readHealth();
    }
    while (healthValue !== readyIndicator && Date.now() < deadline) {
      await delay(Math.min(options.pollMs ?? HEALTH_POLL_MS, deadline - Date.now()), undefined, {
        signal: options.signal,
      });
      if (Date.now() >= deadline) break;
      healthValue = await readHealth();
    }
    if (healthValue === readyIndicator) return healthValue;
    if (unlockFailure) step('health', `Unlock failed — ${unlockFailure}`);
    const error: PrepareCommandError = new Error(
      `Health not ready (value=${healthValue || 'none'}, expected ${readyIndicator})${unlockFailure ? `; ${unlockFailure}` : ''}`,
    );
    error.failedCommand = commands.failedCommand;
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
