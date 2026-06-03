// Common protocol primitives shared across domains.

export type OkResult = { ok: true };

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
}
