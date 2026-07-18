// launch-clear.ts — the non-role-window launch sequence (prelude clears +
// launch line) with lost-session self-healing, ownership-fenced.

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
   * (run terminal or moved, slot releasing/recycled) so an INTENTIONAL
   * teardown is never undone by resurrecting the session.
   */
  assertOwnership: () => Promise<void>;
  /** Recreates the session/worker window and returns the fresh target. */
  reensureTarget: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Pure recreation fence. Returns the reason recreation must NOT happen, or
 * null when this dispatch still owns the slot. Release/recycle mark the slot
 * `busy/releasing` (then `ready`) BEFORE killing tmux, so by the time a fence
 * runs after observing a dead session, an intentional teardown is always
 * visible either as the `releasing` phase (mid-teardown) or as a lifecycle
 * that is no longer `busy` (teardown finished / claim gone).
 */
export function recreationOwnershipViolation(opts: {
  run: { id: string; status: string; slotId: string | null } | null;
  hasRunContext: boolean;
  slotId: string;
  slotLifecycle: string | null;
  slotPhase: string | null;
}): string | null {
  if (!opts.hasRunContext) return 'dispatch has no run context to fence recreation on';
  if (!opts.run) return 'run disappeared mid-dispatch';
  if (['cancelled', 'failed', 'done'].includes(opts.run.status)) {
    return `run is ${opts.run.status}; the session teardown was intentional`;
  }
  if (opts.run.slotId !== opts.slotId) {
    // Strict equality: a null/detached slotId must block too — a run not
    // bound to THIS slot has no authority to recreate its session.
    return `run is bound to slot ${opts.run.slotId ?? 'none'}, not ${opts.slotId}`;
  }
  if (opts.slotPhase === 'releasing') {
    return 'slot is releasing; the session teardown is intentional';
  }
  if (opts.slotLifecycle !== 'busy') {
    return `slot lifecycle is ${opts.slotLifecycle ?? 'unknown'}; the claim on ${opts.slotId} is gone`;
  }
  return null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class SessionLostError extends Error {
  constructor(session: string, what: string) {
    super(`tmux session ${session} disappeared mid-launch (${what})`);
    this.name = 'SessionLostError';
  }
}

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
 * Runs the full non-role-window launch sequence — pre-clear, DA wait,
 * post-clear, settle, literal launch line, Enter. A parent run's slot release
 * can race a chained follow-up dispatch and kill the session at any point in
 * that sequence; when a send fails because the SESSION vanished (not a plain
 * send error), recovery re-runs assertOwnership, recreates the session, lets
 * the fresh shell settle, and RESTARTS THE WHOLE SEQUENCE from the pre-clear —
 * a fresh shell emits its own DA responses, so resuming mid-sequence would
 * reintroduce the prompt-poisoning bug the prelude exists to prevent. One
 * recreation total: a second session loss fails the dispatch honestly.
 * Returns the target the launch landed on so callers never keep a stale one.
 */
export async function runLaunchPreludeAndSend(
  prelude: LaunchPreludeOptions,
): Promise<{ target: string }> {
  const sleep = prelude.sleep ?? defaultSleep;
  const sendOrLost = async (what: string, target: string, command: string): Promise<void> => {
    const result = await prelude.exec(command);
    if (result.exitCode === 0) return;
    const sessionAlive =
      (await prelude.exec(`has-session -t ${shellQuote(prelude.session)} 2>/dev/null`)).exitCode ===
      0;
    if (sessionAlive) throw new Error(sendFailureMessage(what, prelude.runner, target, result));
    throw new SessionLostError(prelude.session, what);
  };
  const sequence = async (target: string): Promise<void> => {
    const clear = `send-keys -t ${shellQuote(target)} C-c C-u`;
    await sendOrLost('clear launch input (pre-clear) for', target, clear);
    await sleep(prelude.waits.daWaitMs);
    await sendOrLost('clear launch input (post-clear) for', target, clear);
    await sleep(prelude.waits.settleMs);
    await sendOrLost(
      'type launch line for',
      target,
      `send-keys -t ${shellQuote(target)} -l ${shellQuote(prelude.launchCommand)}`,
    );
    await sendOrLost('submit launch line for', target, `send-keys -t ${shellQuote(target)} Enter`);
  };

  let target = prelude.target;
  try {
    await sequence(target);
    return { target };
  } catch (err) {
    if (!(err instanceof SessionLostError)) throw err;
    await prelude.assertOwnership();
    console.log(`[dispatch] ${err.message}; recreating it and restarting the launch sequence`);
    target = await prelude.reensureTarget();
    await sleep(prelude.waits.recreateSettleMs);
    // Close the check/recreate TOCTOU: a teardown that began after the fence
    // above marks the slot BEFORE its kill, so re-validating ownership now —
    // after the recreate — necessarily observes it. On violation, destroy the
    // session we just resurrected instead of leaving it squatting on a slot
    // that was deliberately torn down. (A teardown whose kill lands after this
    // point kills the recreated session; that surfaces as a second loss below
    // and fails the dispatch honestly.)
    try {
      await prelude.assertOwnership();
    } catch (ownershipErr) {
      const killed = await prelude.exec(`kill-session -t ${shellQuote(prelude.session)}`);
      const cleanup =
        killed.exitCode === 0
          ? 'recreated session destroyed'
          : `recreated session cleanup failed: ${killed.stderr || killed.stdout || `exit ${killed.exitCode}`}`;
      throw new Error(`${(ownershipErr as Error).message} (detected after recreation; ${cleanup})`);
    }
    // Second loss is NOT recovered — it propagates as an honest dispatch
    // failure rather than looping against a slot something keeps tearing down.
    try {
      await sequence(target);
    } catch (retryErr) {
      if (retryErr instanceof SessionLostError) {
        throw new Error(`${retryErr.message} again after recreation; failing the dispatch`);
      }
      throw retryErr;
    }
    return { target };
  }
}
