/**
 * A host that never answered. Callers that can wait for a restarting host need to
 * tell that apart from a request that may have been served, and a message is not a
 * contract, so both failures carry a code — and every adapter between the client and
 * its caller has to preserve them (`routeNativeSession`, `routeNativeWorkerSession`).
 */
export const NATIVE_HOST_UNAVAILABLE = 'NATIVE_HOST_UNAVAILABLE';
/** A passive read that found no host at all. */
export const NATIVE_SOURCE_UNAVAILABLE = 'NATIVE_SOURCE_UNAVAILABLE';
/** Admission refused while the loaded host runtime cannot safely serve the new node. */
export const NATIVE_HOST_VERSION_SKEW = 'NATIVE_HOST_VERSION_SKEW';

/** A live start that never produced a ready host within its ceiling. */
export function nativeHostUnavailableError(logPath: string): Error {
  return Object.assign(
    new Error(`Native host unavailable; inspect ${logPath}. No command was retried.`),
    { code: NATIVE_HOST_UNAVAILABLE },
  );
}

const codeOf = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : undefined;

/**
 * A live start that never became ready. This one proves nothing was sent: the throw
 * precedes any socket write, so a caller may send its request again after waiting.
 *
 * `NATIVE_SOURCE_UNAVAILABLE` deliberately does not count here. A passive read raises
 * it before sending too, but the observation layer also raises it *after* a read whose
 * source changed, and a mutation must not be replayed on a maybe.
 */
export function isNativeHostUnavailableError(error: unknown): boolean {
  return codeOf(error) === NATIVE_HOST_UNAVAILABLE;
}

/**
 * No host answered this read, for either reason. Only for retrying a read: a probe
 * that reads an existing host changes nothing, so replaying it is always safe.
 */
export function isNativeHostNotReadyError(error: unknown): boolean {
  const code = codeOf(error);
  return code === NATIVE_HOST_UNAVAILABLE || code === NATIVE_SOURCE_UNAVAILABLE;
}

/**
 * The code a native route must rethrow instead of flattening, or undefined for an
 * error that carries neither. Every adapter between a client and its caller has to
 * call this: a route that replaces these codes with a generic one silently turns the
 * caller's bounded wait into an immediate refusal.
 */
export function preservedNativeHostCode(
  error: unknown,
):
  | typeof NATIVE_HOST_UNAVAILABLE
  | typeof NATIVE_SOURCE_UNAVAILABLE
  | typeof NATIVE_HOST_VERSION_SKEW
  | undefined {
  const code = codeOf(error);
  if (code === NATIVE_HOST_UNAVAILABLE) return NATIVE_HOST_UNAVAILABLE;
  if (code === NATIVE_SOURCE_UNAVAILABLE) return NATIVE_SOURCE_UNAVAILABLE;
  if (code === NATIVE_HOST_VERSION_SKEW) return NATIVE_HOST_VERSION_SKEW;
  return undefined;
}
