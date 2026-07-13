export class OutputContext {
  readonly json: boolean;

  constructor(json: boolean) {
    this.json = json;
  }

  writeJson(data: unknown): void {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }

  write(text: string): void {
    process.stdout.write(text);
  }

  error(msg: string): void {
    process.stderr.write(`Error: ${msg}\n`);
  }

  /** Print a failure and fail the process; when the error carries a userAction, teach the escape. */
  failure(err: unknown): void {
    this.error(err instanceof Error ? err.message : String(err));
    const userAction = (err as { userAction?: unknown })?.userAction;
    if (typeof userAction === 'string' && userAction.length > 0) {
      process.stderr.write(`Next: ${userAction}\n`);
    }
    // A printed failure must never exit 0 — silent-success was the root of the
    // 2026-07-09 onboarding incident.
    process.exitCode = 1;
  }
}
