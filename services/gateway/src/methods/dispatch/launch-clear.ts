// launch-clear.ts — launch-prelude clears and launch-line send with
// lost-session self-healing, ownership-fenced.

import { shellQuote } from '../../core/tmux.js';

export interface LaunchSendExecResult {
  exitCode: number;
  stdout: string;
  stderr?: string | undefined;
}

export interface LaunchPreludeOptions {
  runner: string;
  target: string;
  session: string;
  /** Shell-ready launch command line, typed literally then submitted with Enter. */
  launchCommand: string;
  waits: {
    /** Wait between pre-clear and post-clear so in-flight DA responses land. */
    daWaitMs: number;
    /** Settle after the post-clear before the literal launch line types. */
    settleMs: number;
    /** Settle after recreating a session before sending anything into the fresh shell. */
    recreateSettleMs: number;
  };
  /** Runs a tmux subcommand on the slot. */
  exec: (tmuxCommand: string) => Promise<LaunchSendExecResult>;
  /**
   * Fences recreation: throws when this dispatch no longer owns the slot
   * (run cancelled/failed/completed, or the slot reassigned) so an
   * INTENTIONAL teardown is never undone by resurrecting the session.
   */
  assertOwnership: () => Promise<void>;
  /** Recreates the session/worker window and returns the fresh target. */
  reensureTarget: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function sendFailureMessage(
  what: string,
  runner: string,
  target: string,
  result: LaunchSendExecResult,
): string {
  return `Failed to ${what} ${runner} in ${target}: ${
    result.stderr || result.stdout || `exit ${result.exitCode}`
  }`;
}

/**
 * A parent run's slot release can race its chained follow-up dispatch and
 * kill the tmux session anywhere between the prelude clears and the launch
 * send. When a send fails AND the session is what vanished, recovery is only
 * legitimate if this dispatch still owns the slot — a cancel/recycle marks
 * the run terminal before killing tmux, and recreating the session then
 * would resurrect a worker on a deliberately torn-down slot. The fence
 * (assertOwnership) throws in that case; otherwise the session is recreated,
 * the fresh shell is given `recreateSettleMs` to finish startup (an immediate
 * C-c into a starting shell can kill the pane), and the send retried once.
 */
async function sendWithSessionRecovery(opts: {
  what: string;
  command: (target: string) => string;
  target: string;
  prelude: LaunchPreludeOptions;
}): Promise<string> {
  const { prelude } = opts;
  const sleep = prelude.sleep ?? defaultSleep;
  const first = await prelude.exec(opts.command(opts.target));
  if (first.exitCode === 0) return opts.target;
  const sessionAlive =
    (await prelude.exec(`has-session -t ${shellQuote(prelude.session)} 2>/dev/null`)).exitCode ===
    0;
  if (sessionAlive) {
    throw new Error(sendFailureMessage(opts.what, prelude.runner, opts.target, first));
  }
  await prelude.assertOwnership();
  console.log(
    `[dispatch] tmux session ${prelude.session} disappeared mid-launch (${opts.what}); recreating it before retrying`,
  );
  const freshTarget = await prelude.reensureTarget();
  await sleep(prelude.waits.recreateSettleMs);
  const retry = await prelude.exec(opts.command(freshTarget));
  if (retry.exitCode !== 0) {
    throw new Error(
      `${sendFailureMessage(opts.what, prelude.runner, freshTarget, retry)} (after session recreation)`,
    );
  }
  return freshTarget;
}

/**
 * Runs the full non-role-window launch sequence — pre-clear, DA wait,
 * post-clear, settle, literal launch line + Enter — with every send covered
 * by the same fenced lost-session recovery, and returns the target the
 * launch ultimately landed on so callers never keep using a stale one.
 */
export async function runLaunchPreludeAndSend(
  prelude: LaunchPreludeOptions,
): Promise<{ target: string }> {
  const sleep = prelude.sleep ?? defaultSleep;
  const clearCommand = (target: string): string => `send-keys -t ${shellQuote(target)} C-c C-u`;
  let target = prelude.target;
  target = await sendWithSessionRecovery({
    what: 'clear launch input (pre-clear) for',
    command: clearCommand,
    target,
    prelude,
  });
  await sleep(prelude.waits.daWaitMs);
  target = await sendWithSessionRecovery({
    what: 'clear launch input (post-clear) for',
    command: clearCommand,
    target,
    prelude,
  });
  await sleep(prelude.waits.settleMs);
  target = await sendWithSessionRecovery({
    what: 'type launch line for',
    command: (t) => `send-keys -t ${shellQuote(t)} -l ${shellQuote(prelude.launchCommand)}`,
    target,
    prelude,
  });
  // Enter is deliberately NOT recovery-wrapped: recreating the session here
  // would submit an empty prompt in a fresh shell, not the launch line that
  // just vanished with the old pane. A dead session at this point fails the
  // dispatch honestly.
  const submit = await prelude.exec(`send-keys -t ${shellQuote(target)} Enter`);
  if (submit.exitCode !== 0) {
    throw new Error(sendFailureMessage('submit launch line for', prelude.runner, target, submit));
  }
  return { target };
}
