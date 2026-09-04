// session-rediscovery.ts — find the pane that currently owns a persisted runner
// session, anywhere in the slot's tmux session.
//
// A recorded tmux target goes stale for ordinary reasons: dispatch sets
// `remain-on-exit off` plus a `pane-died -> kill-pane` hook on role windows
// (methods/dispatch/execute.ts), so a runner that exits takes its pane — and
// with it a single-pane role window — away. An operator who then pastes the
// reopen command lands in a different window, and the gateway would keep
// reporting the session dead even though the conversation is live in front of
// them.
//
// Attribution is structural throughout: tmux pane inventory, a process probe,
// and an exact session-binding check. Pane text is never read.

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';

import {
  probeRunnerDescendantPid,
  verifyExactLiveRunnerSessionBinding,
} from './session-process.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export interface RediscoveredRunnerSessionPane {
  paneId: string;
  panePid: string;
  windowName: string;
  /** Exact `%N` pane id — the routing target stored on the agent context. */
  target: string;
  /** `session:window` for display; never used for routing. */
  displayTarget: string;
}

export interface RunnerSessionRediscoveryResult {
  pane: RediscoveredRunnerSessionPane | null;
  scannedPanes: number;
  /** Why no pane matched, for the caller's liveness reason. */
  reason?: string;
  /**
   * True when at least one pane could not be probed. A scan that could not read
   * part of the session has NOT proven the session absent, so the caller must
   * degrade to `unknown` rather than calling it dead.
   */
  indeterminate?: true;
}

export interface RunnerSessionRediscoveryDeps {
  exec: typeof execOnSlot;
  probeRunnerPid: typeof probeRunnerDescendantPid;
  verifyBinding: typeof verifyExactLiveRunnerSessionBinding;
}

const DEFAULT_DEPS: RunnerSessionRediscoveryDeps = {
  exec: execOnSlot,
  probeRunnerPid: probeRunnerDescendantPid,
  verifyBinding: verifyExactLiveRunnerSessionBinding,
};

export interface RediscoverRunnerSessionOptions {
  vars: SlotVars;
  /** tmux session name for the slot. */
  session: string;
  runner: string;
  expectedSessionId: string;
  expectedSessionPath: string;
  /** Pane already checked by the caller, skipped to avoid probing it twice. */
  skipPaneId?: string | null;
}

/**
 * Scan every pane of the slot's tmux session for a runner process that owns
 * exactly {@link RediscoverRunnerSessionOptions.expectedSessionId}. The first
 * exact owner wins; a same-type runner running a different session is not a
 * match, which is the whole point of using the binding check rather than a
 * process-name probe.
 */
export async function rediscoverRunnerSessionPane(
  options: RediscoverRunnerSessionOptions,
  deps: RunnerSessionRediscoveryDeps = DEFAULT_DEPS,
): Promise<RunnerSessionRediscoveryResult> {
  const listed = await deps.exec(
    options.vars,
    tmuxShellSnippet(
      `list-panes -s -t ${shellQuote(options.session)} -F '#{pane_id}|#{pane_pid}|#{window_name}' 2>/dev/null`,
    ),
    { timeout: 10_000 },
  );
  if (listed.exitCode !== 0) {
    // An unreadable inventory has proven nothing about the session. Reporting a
    // plain "not found" here let the caller call a live session dead.
    return {
      pane: null,
      scannedPanes: 0,
      indeterminate: true,
      reason: `tmux pane inventory for session ${options.session} is unavailable`,
    };
  }

  const panes = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [paneId, panePid, windowName] = line.split('|');
      return { paneId: paneId ?? '', panePid: panePid ?? '', windowName: windowName ?? '' };
    })
    .filter((pane) => /^%\d+$/.test(pane.paneId) && /^\d+$/.test(pane.panePid))
    .filter((pane) => pane.paneId !== options.skipPaneId);

  let indeterminate = false;
  for (const pane of panes) {
    const probe = await deps.probeRunnerPid(options.vars, pane.panePid, options.runner);
    // `unknown` is a failed probe, not an empty pane. Skipping it silently
    // turned an unreadable process tree into a confident "session is gone".
    if (probe.state === 'unknown') {
      indeterminate = true;
      continue;
    }
    if (probe.state !== 'present') continue;
    const owned = await deps.verifyBinding(options.vars, options.runner, {
      paneId: pane.paneId,
      slotId: options.vars.slotId,
      expectedSessionId: options.expectedSessionId,
      expectedSessionPath: options.expectedSessionPath,
      // The proven runner PID lets a RESUMED session be recognized: its
      // transcript is older than the pane that reopened it, so fresh-launch
      // attribution alone can never bind it.
      runnerPid: probe.pid,
    });
    if (!owned.ok) {
      // A verifier that could not decide has not ruled this pane out.
      if (owned.indeterminate) indeterminate = true;
      continue;
    }
    return {
      pane: {
        paneId: pane.paneId,
        panePid: pane.panePid,
        windowName: pane.windowName,
        // The exact pane is the proof and the routing target. `session:window`
        // is kept alongside for display only: a split window has several panes
        // and the name alone would let input reach a sibling.
        target: pane.paneId,
        displayTarget: pane.windowName ? `${options.session}:${pane.windowName}` : options.session,
      },
      scannedPanes: panes.length,
    };
  }

  return {
    pane: null,
    scannedPanes: panes.length,
    ...(indeterminate ? { indeterminate: true as const } : {}),
    reason: indeterminate
      ? `at least one pane in tmux session ${options.session} could not be probed`
      : panes.length === 0
        ? `tmux session ${options.session} has no panes to scan`
        : `no pane in tmux session ${options.session} runs ${options.runner} session ${options.expectedSessionId}`,
  };
}
