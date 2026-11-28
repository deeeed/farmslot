// Common protocol primitives shared across domains.

export type OkResult = { ok: true };

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** System error code when the process could not be started. */
  spawnErrorCode?: string;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
}
