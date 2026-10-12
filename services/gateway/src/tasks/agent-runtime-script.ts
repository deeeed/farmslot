import path from 'node:path';

import { farmslotRoot, resolveRemoteRepo, type SlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';

/** Installed node support and the local checkout share one runtime script root. */
export function agentRuntimeScriptForSlot(vars: SlotVars, filename: string): string {
  const root = isLocal(vars.host, vars.machine)
    ? farmslotRoot
    : resolveRemoteRepo('~/farmslot-node', vars.osType, vars.sshUser);
  return path.posix.join(root, 'packages/agent-runtime/scripts', filename);
}
