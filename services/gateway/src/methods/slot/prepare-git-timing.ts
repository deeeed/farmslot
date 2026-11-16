import type { ExecResult, SubStepRecord } from '@farmslot/protocol';

export type PrepareGitTiming = SubStepRecord & { detail: string };

/** Caller-supplied operation names contain no command arguments or output. */
export function createPrepareGitTimer(
  emit: (record: PrepareGitTiming) => void,
  now = () => performance.now(),
) {
  let sequence = 0;
  return async <T extends Pick<ExecResult, 'exitCode'>>(
    operation: string,
    execute: () => Promise<T>,
    scope: 'command' | 'guarded-mutation' = 'command',
  ): Promise<T> => {
    const name = `git.${++sequence}.${operation}`;
    const started = now();
    let exitCode: number | null = null;
    try {
      const result = await execute();
      exitCode = result.exitCode;
      return result;
    } finally {
      const durationMs = Math.round((now() - started) * 1_000) / 1_000;
      emit({
        name,
        outcome: exitCode === 0 ? 'ok' : 'failed',
        durationMs,
        detail: JSON.stringify({ operation, scope, durationMs, exitCode }),
      });
    }
  };
}
