// self-review/worker-lifecycle.ts — worker liveness and relaunch target helpers for self-review fixes.

import { agentRoleWindow, isReviewerWindowName, primaryRoleForFlow } from '@farmslot/protocol';

import { resolveAgentTarget } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { ensureTmuxWindow, firstWindowTarget, shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import {
  readRunnerTurnState,
  resolvePrimaryWorkerTarget,
  runnerPaneLooksIdle,
  runnerProcessPatternSource,
} from '../runners/registry.js';
import { isRunnerAliveUnderPane } from '../runners/session-process.js';

export async function runnerTurnLeaseIsActive(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  expectedTurnToken: string,
): Promise<boolean> {
  const state = await readRunnerTurnState(vars, target, runner, expectedTurnToken);
  if (
    state?.confidence !== 'high' ||
    state.value !== 'active' ||
    state.turnToken !== expectedTurnToken
  ) {
    return false;
  }
  return paneHostsRunnerProcess(vars, target, runner);
}

function recreateRoleWindowName(roleWindowName?: string | null, flowType?: string | null): string {
  const named = roleWindowName?.trim();
  if (named) return named;
  if (flowType) return agentRoleWindow(primaryRoleForFlow(flowType)) ?? '';
  return '';
}

export async function ensureTmuxTargetReadyForRelaunch(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  target: string,
  roleWindowName?: string | null,
  flowType?: string | null,
): Promise<string> {
  const sessionReady =
    (await execOnSlot(vars, tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`)))
      .exitCode === 0;
  if (!sessionReady) {
    const created = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `new-session -d -s ${shellQuote(session)} -c ${shellQuote(vars.remoteRepo)} 2>/dev/null`,
      ),
    );
    if (created.exitCode !== 0) {
      throw new Error(
        `Cannot relaunch worker because tmux session ${session} is missing: ${created.stderr || created.stdout || `exit ${created.exitCode}`}`,
      );
    }
  }

  const windowPart = target.includes(':')
    ? target.slice(target.indexOf(':') + 1).split('.', 1)[0]
    : '';
  const paneReady = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(target)} -F '#{pane_index}' 2>/dev/null | head -1`,
      ),
    )
  ).stdout.trim();
  let recreateWindow = windowPart || recreateRoleWindowName(roleWindowName, flowType);
  if (paneReady) {
    // A bare session target resolves to whichever window is active. Recovery
    // must never promote an active reviewer window to the primary worker.
    if (!windowPart) {
      console.warn(
        `[self-review] bare tmux target ${target} has no worker identity; recreating role window ${recreateWindow || '(first window)'}`,
      );
    }
    // Legacy dispatches stored numeric targets like mm-2:1.1 while the logical
    // role window was `dev`. Infra windows (metro-*) can take over that index
    // after the worker pane exits, so never treat a live pane at a numeric
    // index as the worker unless the window name still matches.
    else if (/^\d+$/.test(windowPart)) {
      const windowName = (
        await execOnSlot(
          vars,
          tmuxShellSnippet(
            `display-message -p -t ${shellQuote(target)} '#{window_name}' 2>/dev/null`,
          ),
        )
      ).stdout.trim();
      if (windowName && windowName !== windowPart) {
        recreateWindow = recreateRoleWindowName(roleWindowName, flowType);
        console.warn(
          `[self-review] tmux target ${target} drifted to window ${windowName}; recreating role window ${recreateWindow || '(first window)'}`,
        );
      } else {
        return target;
      }
    } else {
      return target;
    }
  }
  // No parseable window in the supplied target, OR the caller asked for "0"
  // — both cases collapse to "give me the session's actual first window."
  // Resolve via firstWindowTarget so base-index-1 hosts get `${session}:1`
  // instead of the non-existent `${session}:0` the legacy fallback returned.
  if (!recreateWindow || recreateWindow === '0') return await firstWindowTarget(vars, session);

  const ensured = await ensureTmuxWindow(vars, session, recreateWindow);
  if (ensured.windows.length !== 1) {
    throw new Error(
      `Cannot relaunch worker because ${session}:${recreateWindow} resolves to ${ensured.windows.length} exact windows`,
    );
  }
  return `${session}:${recreateWindow}`;
}

export async function paneHostsRunnerProcess(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  knownPanePid?: string,
): Promise<boolean> {
  const paneCommand = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `display-message -p -t ${shellQuote(target)} '#{pane_current_command}' 2>/dev/null`,
      ),
    )
  ).stdout
    .trim()
    .toLowerCase();
  const matcherParts = runnerProcessPatternSource(runner)
    .split('|')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (paneCommand && matcherParts.some((part) => paneCommand.includes(part))) {
    return true;
  }
  const panePid =
    knownPanePid ??
    (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `list-panes -t ${shellQuote(target)} -F '#{pane_pid}' 2>/dev/null | head -1`,
        ),
      )
    ).stdout.trim();
  return await isRunnerAliveUnderPane(vars, panePid, runner);
}

export async function isWorkerAlive(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  runId?: string,
): Promise<boolean> {
  let workerTarget = '<unresolved>';
  try {
    workerTarget = runId
      ? (await resolveAgentTarget(vars.slotId, { runId, role: 'primary' })).target
      : await resolvePrimaryWorkerTarget(vars);
    return await paneHostsRunnerProcess(vars, workerTarget, runner);
  } catch (err) {
    console.warn(
      `[self-review] failed to check worker liveness for ${workerTarget}: ${(err as Error).message}`,
    );
    return false;
  }
}

export interface WorkerPaneRediscovery {
  /** Delivery target: the stored one while it still hosts the runner, else a discovered accepting pane, else null. */
  target: string | null;
  /** Window name (or index) of the adopted target, for agent-context persistence. */
  window: string | null;
  /** Per-pane inventory of the session (window, name, pane, command) for delivery-failure errors. */
  seenWindows: string[];
}

/**
 * Re-resolve which pane in the slot's session should receive worker prompts.
 * A stored target can outlive its pane — the runner may come back in a
 * different window with a bare shell left at the recorded one. Keep the
 * stored target while its pane still hosts the runner process; otherwise
 * scan the session's non-reviewer panes for one whose runner is at an
 * accepting prompt. Errors degrade to keeping the stored target.
 */
export async function rediscoverAcceptingWorkerPane(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  runner: string,
  storedTarget: string,
): Promise<WorkerPaneRediscovery> {
  try {
    const listed = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `list-panes -s -t ${shellQuote(session)} -F '#{window_index}|#{window_name}|#{pane_index}|#{pane_current_command}|#{pane_pid}' 2>/dev/null`,
        ),
      )
    ).stdout.trim();
    const panes = listed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [windowIndex, windowName, paneIndex, command, panePid] = line.split('|');
        return { windowIndex, windowName, paneIndex, command, panePid };
      })
      .filter((pane) => pane.windowIndex && pane.paneIndex);
    const seenWindows = panes.map(
      (pane) =>
        `${pane.windowIndex}:${pane.windowName || '(unnamed)'} pane ${pane.paneIndex} (${pane.command || 'unknown'})`,
    );

    const storedWindow = storedTarget.includes(':')
      ? storedTarget.slice(storedTarget.indexOf(':') + 1).split('.', 1)[0] || null
      : null;
    const storedPaneIndex = storedTarget.includes('.')
      ? storedTarget.slice(storedTarget.lastIndexOf('.') + 1)
      : null;
    const storedPane = panes.find(
      (pane) =>
        (pane.windowName === storedWindow || pane.windowIndex === storedWindow) &&
        (!storedPaneIndex || pane.paneIndex === storedPaneIndex),
    );
    if (await paneHostsRunnerProcess(vars, storedTarget, runner, storedPane?.panePid)) {
      return { target: storedTarget, window: storedWindow, seenWindows };
    }

    const storedWindowPart = storedTarget.includes(':')
      ? storedTarget.slice(storedTarget.indexOf(':') + 1).split('.', 1)[0]
      : '';
    for (const pane of panes) {
      if (isReviewerWindowName(pane.windowName)) continue;
      const windowRef = pane.windowName || pane.windowIndex;
      // The stored target's window already failed the liveness check above.
      if (windowRef === storedWindowPart || pane.windowIndex === storedWindowPart) continue;
      const candidate = `${session}:${windowRef}.${pane.paneIndex}`;
      if (!(await paneHostsRunnerProcess(vars, candidate, runner, pane.panePid))) continue;
      const content = (
        await execOnSlot(
          vars,
          tmuxShellSnippet(`capture-pane -p -t ${shellQuote(candidate)} 2>/dev/null`),
        )
      ).stdout;
      if (runnerPaneLooksIdle(content.split('\n'), runner)) {
        return { target: candidate, window: windowRef, seenWindows };
      }
    }
    return { target: null, window: null, seenWindows };
  } catch (err) {
    console.warn(
      `[self-review] worker pane re-resolution failed for ${session}: ${(err as Error).message}`,
    );
    return { target: storedTarget, window: null, seenWindows: [] };
  }
}
