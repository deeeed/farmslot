// launch-clear.ts — launch-input clearing with lost-session self-healing.

import { shellQuote } from '../../core/tmux.js';

/**
 * Clear the runner launch input line (C-c C-u), self-healing a lost session.
 * A concurrent slot teardown (a parent run's release racing its chained
 * follow-up dispatch) can kill the tmux session between two prelude sends,
 * failing the clear with "can't find session" even though this dispatch
 * legitimately owns the slot. When the SESSION is what vanished, re-ensure
 * the worker target (which recreates the session) and retry once; any other
 * send failure, or one that persists after recreation, still throws. Returns
 * the target the clear ultimately succeeded on.
 */
export async function clearLaunchInputWithSessionRecovery(opts: {
  stage: string;
  runner: string;
  target: string;
  session: string;
  exec: (
    tmuxCommand: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr?: string | undefined }>;
  reensureTarget: () => Promise<string>;
}): Promise<string> {
  const clearAt = (target: string): ReturnType<typeof opts.exec> =>
    opts.exec(`send-keys -t ${shellQuote(target)} C-c C-u`);
  const first = await clearAt(opts.target);
  if (first.exitCode === 0) return opts.target;
  const sessionAlive =
    (await opts.exec(`has-session -t ${shellQuote(opts.session)} 2>/dev/null`)).exitCode === 0;
  if (sessionAlive) {
    throw new Error(
      `Failed to clear ${opts.runner} launch input (${opts.stage}) in ${opts.target}: ${
        first.stderr || first.stdout || `exit ${first.exitCode}`
      }`,
    );
  }
  console.log(
    `[dispatch] tmux session ${opts.session} disappeared mid-launch (${opts.stage}); recreating it before retrying the clear`,
  );
  const freshTarget = await opts.reensureTarget();
  const retry = await clearAt(freshTarget);
  if (retry.exitCode !== 0) {
    throw new Error(
      `Failed to clear ${opts.runner} launch input (${opts.stage}) in ${freshTarget} after session recreation: ${
        retry.stderr || retry.stdout || `exit ${retry.exitCode}`
      }`,
    );
  }
  return freshTarget;
}
