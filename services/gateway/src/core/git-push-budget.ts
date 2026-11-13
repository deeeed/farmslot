import { loadProjectVars, type SlotVars } from './config.js';

/** Push includes repository pre-push hooks; short Git probe budgets do not apply. */
export const PUBLICATION_PUSH_TIMEOUT_MS = 900_000;
const setting = 'FARMSLOT_GIT_PUSH_TIMEOUT_MS';

export async function gitPushTimeoutMs(vars: SlotVars): Promise<number> {
  let raw = vars.machineEnv?.[setting];
  if (raw === undefined && vars.projectName) {
    const project = await loadProjectVars(vars.projectName);
    raw = project.projectJson.command_env?.set?.[setting];
  }
  if (raw === undefined) return PUBLICATION_PUSH_TIMEOUT_MS;
  const value = Number(raw);
  // Node timers overflow beyond the signed 32-bit range and would fire immediately.
  if (!raw.trim() || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new Error(`${setting} must be a positive integer in milliseconds, at most 2147483647`);
  return value;
}

export function gitPushTimeoutError(timeoutMs: number): Error {
  return new Error(
    `git push timed out after ${timeoutMs} ms including the repository's pre-push hook budget; increase ${setting} in project command_env.set or pool env if hooks need more time (hooks were not skipped)`,
  );
}
