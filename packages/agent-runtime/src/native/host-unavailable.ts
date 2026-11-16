/**
 * A host that never answered: the failure happens before any socket write, so no
 * command reached a host and none was retried. Callers that can wait for a host
 * to come back need to tell this apart from a request that may have been served,
 * and a message is not a contract: both failures carry a code.
 */
export const NATIVE_HOST_UNAVAILABLE = 'NATIVE_HOST_UNAVAILABLE';

/** A live start that never produced a ready host within its ceiling. */
export function nativeHostUnavailableError(logPath: string): Error {
  return Object.assign(
    new Error(`Native host unavailable; inspect ${logPath}. No command was retried.`),
    { code: NATIVE_HOST_UNAVAILABLE },
  );
}

/**
 * This failure proves the request was never sent: either a live start never became
 * ready (NATIVE_HOST_UNAVAILABLE) or a passive read found no host at all
 * (NATIVE_SOURCE_UNAVAILABLE). Both are raised before a request reaches a host.
 */
export function isNativeHostUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === NATIVE_HOST_UNAVAILABLE || code === 'NATIVE_SOURCE_UNAVAILABLE';
}
