/** An authoritative native runner failure, not missing observability. */
export class RunnerExecutionError extends Error {
  override name = 'RunnerExecutionError';
}

/**
 * A turn that ended because the runner's own model connection was torn down
 * mid-request ("terminated" is undici's bare message for it). The session is
 * intact and continues on the next prompt, so it is not a runner failure (F328).
 */
export function isRunnerTransportAbort(failure: string): boolean {
  return /^terminated$|ECONNRESET|socket hang up|other side closed|fetch failed/i.test(
    failure.trim(),
  );
}
