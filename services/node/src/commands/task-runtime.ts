import { parseTaskRuntimeRequest, runTaskRuntime } from '@farmslot/slot-config/task-runtime';

import { resolveExecPoolDir, resolveLoginEnvironment, SHELL_BOOKKEEPING_ENV } from './exec.js';

/** The socket's ExecRequests owner must be registered before any async setup. */
export async function executeTaskRuntime(params: unknown, signal: AbortSignal) {
  const request = parseTaskRuntimeRequest(params);
  const env = { ...process.env, ...(await resolveLoginEnvironment()) };
  for (const name of SHELL_BOOKKEEPING_ENV) delete env[name];
  return runTaskRuntime(
    request,
    process.cwd(),
    { ...env, FARMSLOT_POOL_DIR: resolveExecPoolDir() },
    signal,
  );
}
