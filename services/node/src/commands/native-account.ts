import { observeAntigravityAccount } from '@farmslot/agent-runtime/native/antigravity';
import type { NativeAccountObservation } from '@farmslot/protocol';

import { resolveLoginEnvironment, SHELL_BOOKKEEPING_ENV } from './exec.js';

/**
 * Observe a native runner's account login status on this execution node using the
 * shared runtime observer (structured protocol probe with verified child cleanup)
 * and the node's operator login environment.
 */
export async function observeNodeNativeAccount(
  params: Record<string, unknown>,
  resolveEnv: () => Promise<NodeJS.ProcessEnv> = resolveLoginEnvironment,
): Promise<NativeAccountObservation> {
  if (params.runner !== 'antigravity') {
    throw Object.assign(
      new Error(`Unsupported native account observer runner: ${String(params.runner)}`),
      {
        code: 'INVALID_PARAMS',
      },
    );
  }
  const cwd = typeof params.cwd === 'string' && params.cwd.trim() ? params.cwd.trim() : '/';
  const executable =
    typeof params.executable === 'string' && params.executable.trim()
      ? params.executable.trim()
      : undefined;
  const loginEnv = await resolveEnv();
  const env: NodeJS.ProcessEnv = { ...process.env, ...loginEnv };
  for (const name of SHELL_BOOKKEEPING_ENV) delete env[name];
  if (params.env && typeof params.env === 'object' && !Array.isArray(params.env)) {
    for (const [key, value] of Object.entries(params.env as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  return observeAntigravityAccount({
    cwd,
    ...(executable ? { executable } : {}),
    env,
  });
}
