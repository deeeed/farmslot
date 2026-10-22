/** An authoritative native runner failure, not missing observability. */
export class RunnerExecutionError extends Error {
  override name = 'RunnerExecutionError';
}
