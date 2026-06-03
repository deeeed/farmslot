const DEFAULT_GATEWAY_TIMEOUT_MS = 30_000;
const DEFAULT_PROJECT_HOOK_EXEC_TIMEOUT_MS = 60_000;
const PROJECT_HOOK_TIMEOUT_GRACE_MS = 5_000;

function parsePositiveTimeout(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveRecipeProjectHookGatewayTimeoutMs(
  globalTimeout: unknown,
  hookTimeoutMs?: number,
): number {
  const baseTimeout = parsePositiveTimeout(globalTimeout) ?? DEFAULT_GATEWAY_TIMEOUT_MS;
  const hookExecTimeout = hookTimeoutMs ?? DEFAULT_PROJECT_HOOK_EXEC_TIMEOUT_MS;
  return Math.max(baseTimeout, hookExecTimeout + PROJECT_HOOK_TIMEOUT_GRACE_MS);
}
