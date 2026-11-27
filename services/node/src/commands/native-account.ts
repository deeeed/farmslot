import { observeAntigravityAccount } from '@farmslot/agent-runtime/native/antigravity';
import type { NativeAccountObservation } from '@farmslot/protocol';

/**
 * Observe a native runner's account login status on this execution node using the
 * shared runtime observer (structured protocol probe with verified child cleanup).
 */
export async function observeNodeNativeAccount(
  params: Record<string, unknown>,
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
  const extraEnv: Record<string, string> = {};
  if (params.env && typeof params.env === 'object' && !Array.isArray(params.env)) {
    for (const [key, value] of Object.entries(params.env as Record<string, unknown>)) {
      if (typeof value === 'string') extraEnv[key] = value;
    }
  }
  return observeAntigravityAccount({
    cwd,
    ...(executable ? { executable } : {}),
    env: { ...process.env, ...extraEnv },
  });
}
