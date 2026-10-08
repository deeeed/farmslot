// Typed exit-code error: carries exitCode so both the global catch (the host bin)
// and the host's delegate() wrapper classify the error correctly rather than always
// returning 1.  Usage errors (bad args / unsupported flags) carry EXIT.usage (2);
// validation errors carry EXIT.validation (5).  Never throw a plain new Error() for
// user-facing bad-args cases — use usageError() so the exit code is preserved.
// Its own module, so modules parse-args depends on can extend it.
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
