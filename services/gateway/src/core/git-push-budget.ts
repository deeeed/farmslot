import {
  GIT_PUSH_TIMEOUT_SETTING,
  gitPushTimeoutMs as parseGitPushTimeoutMs,
} from '@farmslot/agent-runtime/scripts/farm-git.cjs';
export {
  gitPushTimeoutError,
  PUBLICATION_PUSH_TIMEOUT_MS,
} from '@farmslot/agent-runtime/scripts/farm-git.cjs';

import { loadProjectVars, type SlotVars } from './config.js';

const setting = GIT_PUSH_TIMEOUT_SETTING;

export async function gitPushTimeoutMs(vars: SlotVars): Promise<number> {
  let raw = vars.machineEnv?.[setting];
  if (raw === undefined && vars.projectName) {
    const project = await loadProjectVars(vars.projectName);
    raw = project.projectJson.command_env?.set?.[setting];
  }
  return parseGitPushTimeoutMs(raw);
}
