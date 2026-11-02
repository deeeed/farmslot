/** An authoritative native runner failure, not missing observability. */
export class RunnerExecutionError extends Error {
  override name = 'RunnerExecutionError';

  /** @param observedAt When the runner recorded this failure, if a record says so. */
  constructor(
    message: string,
    readonly observedAt?: number,
  ) {
    super(message);
  }
}
