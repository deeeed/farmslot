import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type AgentContext,
  type AgentContextTarget,
  type AgentRole,
  agentRoleWindow,
  DEFAULT_CLAUDE_MODEL,
  type DispatchExecuteParams,
  primaryRoleForFlow,
} from '@farmslot/protocol';

import { markAgentContextStatus, upsertAgentContext } from '../../agents/contexts.js';
import {
  applyProjectCommandEnv,
  execLocal,
  execOnSlot,
  farmslotRoot,
  getProjectField,
  isLocal,
  loadProjectVars,
  loadSlotVars,
  markSlotBusy,
  type RawProjectJson,
  readSlotField,
  resetSlot,
  resolveProjectTaskDirName,
  updateSlotStatus,
} from '../../core/index.js';
import {
  firstWindowTarget,
  resolveTmuxPaneId,
  resolveTmuxSession,
  shellQuote,
  tmuxSendTextCommand,
  tmuxShellSnippet,
} from '../../core/tmux.js';
import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../../live-recipe/context.js';
import {
  assertRunnerLaunchPrerequisites,
  buildLaunchCommand,
  RUNNER_LAUNCH_READY_TIMEOUT_MS,
} from '../../runners/launch-command.js';
import {
  assertSupportedRunnerSpelling,
  detectRunnerLaunchBlocker,
  normalizeRunner,
  runnerDefaultModel,
  runnerLaunchBlockerAutoActionKey,
  runnerNeedsPostLaunchPrompt,
  runnerPaneHasDeferredLaunchBlocker,
  runnerResolvesPreTaskLaunchBlockers,
  sendRunnerPostLaunchPrompt,
  WORKER_ENV_PREFIX,
} from '../../runners/registry.js';
import {
  assertScriptedRunnerConfig,
  resolveScriptedCommandFromRawProjectJson,
} from '../../runners/scripted-config.js';
import { dispatchStartedAtMs } from '../../runners/session-path-resolution.js';
import {
  captureRunnerSessionMetadata,
  isRunnerAliveUnderPane,
  listRunnerSessionFiles,
} from '../../runners/session-process.js';
import { resolveWorkerDispatchPrompt } from '../../runners/worker-prompt.js';
import { copyPreparedTaskRootSidecars } from '../../tasks/sidecars.js';
import { watchContext, watchSlot } from '../../tasks/watcher.js';
import { killAgentInSession, slotPrepare } from '../slot.js';

import { buildDispatchRoleShellCommand, parseCapturedAgentPaneTarget } from './role-target.js';
import { resolveDispatchSafetyTier } from './safety-tier.js';
import { buildSlotClaimStatus, evaluateSlotIdentityPolicy } from './slot-scoring.js';
import { flowTypeToKey } from './task-flow-key.js';

export {
  branchContainsJiraKey,
  buildSlotClaimStatus,
  evaluateSlotIdentityPolicy,
  isCdpLive,
  isFreeSlot,
  resolveJiraTargetBranchFromFleet,
  slotScore,
  validateSlot,
} from './slot-scoring.js';
export {
  assertTicketRefMatchesProjectRepo,
  normalizeTicketRef,
  resolvePrRef,
  validateTicketRef,
} from './ticket-ref.js';

/**
 * Wait between the pre-clear (C-c C-u) and post-clear in the launch prelude
 * (long enough for delayed DA1/DA2 escape responses to arrive on stdin and
 * be swept by the second clear). Empirically chosen for anaconda's `(base)`
 * activation on darwin/zsh — bump if you see DA-leak failures on slower
 * remote shells (look for `1;2c0;276;0c…` chatter in the worker pane).
 */
const LAUNCH_PRELUDE_DA_WAIT_MS = 250;

/**
 * Settle window after the post-clear so the second `C-u` takes effect before
 * `send-keys -l` appends the literal launch line. Short — the post-clear
 * already cleared the buffer; this just guards against the rare case where
 * tmux hasn't yet flushed the keystroke to the receiving shell.
 */
const LAUNCH_PRELUDE_SETTLE_MS = 50;

/**
 * Fresh role windows start a login shell before dispatch sends the runner
 * launch line. On macOS/zsh, an immediate C-c during shell startup can exit the
 * pane; with dispatch's pane-died hook that removes the whole role window.
 */
const ROLE_WINDOW_STARTUP_SETTLE_MS = 500;
const ROLE_LAUNCH_FAILURE_DIAGNOSTIC_HOLD_SECONDS = 45;

type EventEmitter = (event: string, payload: unknown) => void;

async function captureAgentPaneTarget(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  target = session,
): Promise<AgentContextTarget> {
  const raw = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `display-message -p -t ${shellQuote(target)} '#{session_name}:#{window_index}.#{pane_index}|#{window_name}' 2>/dev/null`,
      ),
    )
  ).stdout.trim();
  return parseCapturedAgentPaneTarget(session, raw);
}

function isAutoNamedTmuxWindow(name: string, session: string, runner: string): boolean {
  return (
    name === session ||
    name === '0' ||
    name === runner ||
    ['zsh', 'bash', 'sh', 'fish', 'node', 'pwsh', 'tcsh'].includes(name)
  );
}

async function renameDefaultWorkerWindow(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  runner: string,
  workerWindowName: string,
): Promise<void> {
  const target = await firstWindowTarget(vars, session);
  const currentName = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(`display-message -p -t ${shellQuote(target)} '#{window_name}' 2>/dev/null`),
    )
  ).stdout.trim();
  if (
    currentName &&
    currentName !== workerWindowName &&
    !isAutoNamedTmuxWindow(currentName, session, runner)
  ) {
    console.log(
      `[dispatch] preserving user-set tmux window name session=${session} window=${currentName} desired=${workerWindowName}`,
    );
    return;
  }
  const renamed = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `rename-window -t ${shellQuote(target)} ${shellQuote(workerWindowName)} 2>/dev/null`,
    ),
  );
  if (renamed.exitCode !== 0) {
    throw new Error(
      `Failed to rename tmux window ${target} to ${workerWindowName}: ${renamed.stderr || renamed.stdout || `exit ${renamed.exitCode}`}`,
    );
  }
  await applyRoleWindowOptions(vars, `${session}:${workerWindowName}`);
}

async function tmuxWindowExists(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
): Promise<boolean> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `list-panes -t ${shellQuote(target)} -F '#{pane_index}' 2>/dev/null | head -1`,
    ),
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

// Role windows must be live or gone, never parked as "Pane is dead". Runner
// postmortems belong in run artifacts/logs; leaving a dead tmux pane blocks the
// next dispatch from having an interactive target and makes the operator UI look
// broken. Set per-window because tmux doesn't apply remain-on-exit to existing
// windows via -g.
async function applyRoleWindowOptions(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
): Promise<void> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(`set-window-option -t ${shellQuote(target)} remain-on-exit off`),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to disable remain-on-exit on ${target}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }

  // Defensive cleanup for panes created by older gateway builds that still had
  // remain-on-exit enabled. With remain-on-exit off this hook is normally inert,
  // but if tmux fires it for a retained dead pane we remove the pane instead of
  // letting it block input.
  const hookResult = await execOnSlot(
    vars,
    tmuxShellSnippet(`set-hook -w -t ${shellQuote(target)} pane-died 'kill-pane'`),
  );
  if (hookResult.exitCode !== 0) {
    throw new Error(
      `Failed to set pane-died hook on ${target}: ${hookResult.stderr || hookResult.stdout || `exit ${hookResult.exitCode}`}`,
    );
  }
}

// True when the role window's pane is in tmux's "dead" state (process exited while
// remain-on-exit was on). Such panes accept no input — `respawn-window -k` revives them.
// Inspecting pane[0] alone is sufficient: dispatch only ever creates single-pane role
// windows, and respawn-window -k replaces every pane in the target window regardless.
//
// Caller (`ensureWorkerRoleTarget`) gates this behind `tmuxWindowExists`, so a non-zero
// exit here means tmux actually failed (auth, missing socket) rather than "window gone."
// Surface that as an error instead of silently treating it as "alive" — pretending alive
// would then send the dispatch into a window we can't talk to.
async function isRoleWindowDead(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
): Promise<boolean> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(`list-panes -t ${shellQuote(target)} -F '#{pane_dead}' | head -1`),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to inspect tmux role window ${target}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.trim() === '1';
}

async function cleanupDeadPanesInSession(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
): Promise<void> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `
list-windows -t ${shellQuote(session)} -F '#I' 2>/dev/null | while IFS= read -r win; do
  [ -n "$win" ] || continue
  "$TMUX_BIN" list-panes -t ${shellQuote(session)}:"$win" -F '#{pane_index} #{pane_dead}' 2>/dev/null | while read -r pane dead; do
    if [ "$dead" = "1" ]; then
      "$TMUX_BIN" kill-pane -t ${shellQuote(session)}:"$win"."$pane" 2>/dev/null || true
    fi
  done
done
`,
    ),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to clean dead panes in tmux session ${session}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

/**
 * True when the runner process is alive under ANY pane of the target window.
 * A tmux window can hold more than one pane (a leftover split from a prior
 * session, a sandbox layout, etc.), and the runner may launch into any of
 * them — so probing only the first pane (`list-panes … | head -1`) misreads a
 * live worker in a sibling pane as "no runner process".
 */
async function isRunnerAliveInAnyPane(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
): Promise<boolean> {
  const panePids = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(`list-panes -t ${shellQuote(target)} -F '#{pane_pid}' 2>/dev/null`),
    )
  ).stdout
    .split('\n')
    .map((pid) => pid.trim())
    .filter(Boolean);
  for (const panePid of panePids) {
    if (await isRunnerAliveUnderPane(vars, panePid, runner)) return true;
  }
  return false;
}

export async function waitForRunnerProcessExit(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isRunnerAliveInAnyPane(vars, target, runner))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${runner} process to exit from ${target}`);
}

interface DispatchFailureCleanupDeps {
  killAgentInSession?: typeof killAgentInSession;
  waitForRunnerProcessExit?: typeof waitForRunnerProcessExit;
}

export async function cleanupLaunchedWorkerAfterDispatchFailure(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  role: AgentRole,
  deps: DispatchFailureCleanupDeps = {},
): Promise<void> {
  const killRunner = deps.killAgentInSession ?? killAgentInSession;
  const waitForExit = deps.waitForRunnerProcessExit ?? waitForRunnerProcessExit;

  await killRunner(vars, runner, role);
  await waitForExit(vars, target, runner, 5_000);
}

/**
 * Confirm the launch send-keys actually started the runner. If the runner
 * process never appears in the pane's descendant tree within {@link timeoutMs},
 * the shell ate the launch line — usually because some terminal init left
 * bytes in stdin that mangled it. Throw an explicit dispatch failure rather
 * than letting run-monitor downstream misread "no agent process" as "worker
 * done" (the false-success path that left review-pr runs blocked at human-gate
 * waiting for an artifact that was never going to be written).
 *
 * Default timeout is 30s — generous enough for a cold-start codex over SSH to
 * a remote Linux node (sustained ~1s per remote exec, with 250ms polls that
 * leaves ~12 effective probes for the runner to appear). Bump if you see
 * legitimate dispatches timing out on slower remotes; keep it well under the
 * monitor's poll interval so a real launch failure surfaces before the human
 * gate ever opens.
 *
 * Captures the pane content on failure so the operator gets the actual zsh
 * "command not found" trail back instead of a context-free timeout.
 */
async function assertRunnerProcessStarted(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isRunnerAliveInAnyPane(vars, target, runner)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const pane = await execOnSlot(
    vars,
    tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} -S -50 2>/dev/null`),
  );
  const tail = pane.stdout.trim().split('\n').slice(-15).join('\n');
  throw new Error(
    `${runner} did not start in ${target} within ${Math.round(timeoutMs / 1000)}s — launch line never produced a runner process. ` +
      `Last pane content:\n${tail}`,
  );
}

type RunnerLaunchBlockerResolverDeps = {
  exec?: typeof execOnSlot;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export async function resolveRunnerLaunchBlockers(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  runner: string,
  timeoutMs = 60_000,
  deps: RunnerLaunchBlockerResolverDeps = {},
): Promise<void> {
  const exec = deps.exec ?? execOnSlot;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  const autoActionAttempts = new Map<string, number>();
  const loggedExhaustedAutoActions = new Set<string>();
  let lastBlockerSummary = '';
  while (now() < deadline) {
    const paneResult = await exec(
      vars,
      tmuxShellSnippet(`capture-pane -p -t ${shellQuote(target)} 2>/dev/null`),
    );
    if (paneResult.exitCode !== 0) {
      throw new Error(
        `Failed to inspect ${runner} launch blocker state in ${target}: ${paneResult.stderr || paneResult.stdout || `exit ${paneResult.exitCode}`}`,
      );
    }
    const pane = paneResult.stdout;
    const blocker = detectRunnerLaunchBlocker(pane, runner);
    if (!blocker) return;
    lastBlockerSummary = blocker.summary;

    const key = runnerLaunchBlockerAutoActionKey(blocker.autoAction);
    if (key) {
      const attempts = autoActionAttempts.get(blocker.kind) ?? 0;
      if (attempts < 2) {
        const result = await exec(
          vars,
          tmuxShellSnippet(`send-keys -t ${shellQuote(target)} ${shellQuote(key)} 2>/dev/null`),
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to resolve ${runner} launch blocker ${blocker.kind} in ${target}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
          );
        }
        autoActionAttempts.set(blocker.kind, attempts + 1);
      } else if (!loggedExhaustedAutoActions.has(blocker.kind)) {
        console.log(
          `[dispatch] launch blocker ${blocker.kind} in ${target} still visible after ${attempts} ${key} auto-action attempts; waiting for it to clear`,
        );
        loggedExhaustedAutoActions.add(blocker.kind);
      }
    } else if (!runnerPaneHasDeferredLaunchBlocker(pane, runner, blocker)) {
      throw new Error(
        `${blocker.summary} Launch blocker has no safe automatic action; dispatch cannot continue.`,
      );
    }
    await sleep(1500);
  }
  const attemptedKinds = [...autoActionAttempts].map(
    ([kind, attempts]) => `${kind}${attempts > 1 ? ` (${attempts} attempts)` : ''}`,
  );
  throw new Error(
    `${runner} launch blocker did not clear in ${target} within ${Math.round(timeoutMs / 1000)}s. ${lastBlockerSummary}${
      attemptedKinds.length ? ` Auto-action was sent for: ${attemptedKinds.join(', ')}.` : ''
    }`,
  );
}

export async function ensureWorkerRoleTarget(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  runner: string,
  role: AgentRole,
): Promise<string> {
  const windowName = agentRoleWindow(role);
  // Self-heal: if the tmux session doesn't exist, recreate it. Otherwise downstream calls
  // (firstWindowTarget, tmuxWindowExists) throw "has no windows — cannot resolve a worker
  // target" because list-windows on a missing session returns empty stdout. The session can
  // legitimately disappear mid-dispatch when `killAllAgentWindows` hits the last-window case
  // — tmux's `kill-window` of the only window in a session also kills the session itself
  // (slot.ts:1625-1627 explicitly uses `kill-session` when windows.length === 1, but the
  // semantics are the same either way). Recreate with a role-named window in one step.
  const sessionExists =
    (await execOnSlot(vars, tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`)))
      .exitCode === 0;
  if (!sessionExists) {
    const initialWindow = windowName ?? 'worker';
    const created = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `new-session -d -s ${shellQuote(session)} -n ${shellQuote(initialWindow)} -c ${shellQuote(vars.remoteRepo)} ` +
          `${shellQuote(buildDispatchRoleShellCommand(vars.remoteRepo))} 2>/dev/null`,
      ),
    );
    if (created.exitCode !== 0) {
      throw new Error(
        `Failed to recreate tmux session ${session}: ${created.stderr || created.stdout || `exit ${created.exitCode}`}`,
      );
    }
    if (!windowName) return await firstWindowTarget(vars, session);
    const target = `${session}:${windowName}`;
    await applyRoleWindowOptions(vars, target);
    return target;
  }

  const windowList = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(`list-windows -t ${shellQuote(session)} -F '#I' 2>/dev/null | head -1`),
    )
  ).stdout.trim();
  if (!windowList) {
    const initialWindow = windowName ?? 'worker';
    const recreated = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `kill-session -t ${shellQuote(session)} 2>/dev/null; ` +
          `new-session -d -s ${shellQuote(session)} -n ${shellQuote(initialWindow)} -c ${shellQuote(vars.remoteRepo)} ` +
          `${shellQuote(buildDispatchRoleShellCommand(vars.remoteRepo))} 2>/dev/null`,
      ),
    );
    if (recreated.exitCode !== 0) {
      throw new Error(
        `Failed to recreate empty tmux session ${session}: ${recreated.stderr || recreated.stdout || `exit ${recreated.exitCode}`}`,
      );
    }
    if (!windowName) return await firstWindowTarget(vars, session);
    const target = `${session}:${windowName}`;
    await applyRoleWindowOptions(vars, target);
    return target;
  }

  // Orchestration roles have no role-window — they share the session's first
  // window with whatever the operator left open. Look up the actual first
  // window target instead of assuming index 0 so this works on hosts where
  // tmux is configured with `base-index 1`.
  if (!windowName) return await firstWindowTarget(vars, session);

  const roleTarget = `${session}:${windowName}`;
  if (await tmuxWindowExists(vars, roleTarget)) {
    if (await isRoleWindowDead(vars, roleTarget)) {
      // Pane sat on its postmortem (remain-on-exit) view — revive with a fresh shell so the
      // upcoming dispatch can send-keys the runner launch line into a live process. No stderr
      // suppression: when respawn-window fails we want the actual tmux message in the thrown
      // error, not "exit 1" with no context.
      const respawned = await execOnSlot(
        vars,
        tmuxShellSnippet(
          `respawn-window -k -t ${shellQuote(roleTarget)} -c ${shellQuote(vars.remoteRepo)} ` +
            shellQuote(buildDispatchRoleShellCommand(vars.remoteRepo)),
        ),
      );
      if (respawned.exitCode !== 0) {
        throw new Error(
          `Failed to respawn dead tmux role window ${roleTarget}: ${respawned.stderr || respawned.stdout || `exit ${respawned.exitCode}`}`,
        );
      }
      await applyRoleWindowOptions(vars, roleTarget);
    }
    return roleTarget;
  }

  const firstTarget = await firstWindowTarget(vars, session);
  const currentName = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `display-message -p -t ${shellQuote(firstTarget)} '#{window_name}' 2>/dev/null`,
      ),
    )
  ).stdout.trim();
  if (!currentName || isAutoNamedTmuxWindow(currentName, session, runner)) {
    await renameDefaultWorkerWindow(vars, session, runner, windowName);
    return roleTarget;
  }

  const created = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `new-window -t ${shellQuote(session)} -n ${shellQuote(windowName)} -c ${shellQuote(vars.remoteRepo)} -d ` +
        `${shellQuote(buildDispatchRoleShellCommand(vars.remoteRepo))} 2>/dev/null`,
    ),
  );
  if (created.exitCode !== 0) {
    throw new Error(
      `Failed to create tmux role window ${roleTarget}: ${created.stderr || created.stdout || `exit ${created.exitCode}`}`,
    );
  }
  await applyRoleWindowOptions(vars, roleTarget);
  return roleTarget;
}

async function respawnRoleWindowForDispatch(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
): Promise<void> {
  const respawned = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `respawn-window -k -t ${shellQuote(target)} -c ${shellQuote(vars.remoteRepo)} ` +
        shellQuote(buildDispatchRoleShellCommand(vars.remoteRepo)),
    ),
  );
  if (respawned.exitCode !== 0) {
    throw new Error(
      `Failed to reset tmux role window ${target}: ${respawned.stderr || respawned.stdout || `exit ${respawned.exitCode}`}`,
    );
  }
  const collapse = await execOnSlot(
    vars,
    tmuxShellSnippet(`kill-pane -a -t ${shellQuote(target)} 2>/dev/null || true`),
  );
  if (collapse.exitCode !== 0) {
    throw new Error(
      `Failed to collapse tmux role window ${target} to a single pane: ${collapse.stderr || collapse.stdout || `exit ${collapse.exitCode}`}`,
    );
  }
  await applyRoleWindowOptions(vars, target);
}

async function respawnRoleWindowWithCommand(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  command: string,
): Promise<void> {
  const launchCommand = buildRoleLaunchCommandWithDiagnosticHold(command);
  const respawned = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `respawn-window -k -t ${shellQuote(target)} -c ${shellQuote(vars.remoteRepo)} ` +
        shellQuote(launchCommand),
    ),
  );
  if (respawned.exitCode !== 0) {
    throw new Error(
      `Failed to launch command in tmux role window ${target}: ${respawned.stderr || respawned.stdout || `exit ${respawned.exitCode}`}`,
    );
  }
  const collapse = await execOnSlot(
    vars,
    tmuxShellSnippet(`kill-pane -a -t ${shellQuote(target)} 2>/dev/null || true`),
  );
  if (collapse.exitCode !== 0) {
    throw new Error(
      `Failed to collapse tmux role window ${target} to a single pane after launch: ${collapse.stderr || collapse.stdout || `exit ${collapse.exitCode}`}`,
    );
  }
  await applyRoleWindowOptions(vars, target);
}

export function buildRoleLaunchCommandWithDiagnosticHold(command: string): string {
  // Keep the wrapper as the tmux pane process so launch failures can preserve
  // stderr briefly for diagnostics. If dispatch cleanup kills the child runner,
  // or a runner exits non-zero during launch/user quit, this outer shell can
  // remain until the diagnostic hold elapses, but the runner process itself is
  // already gone.
  const lines = [
    `bash -lc ${shellQuote(command)}`,
    '__farmslot_status=$?',
    'if [ "$__farmslot_status" -ne 0 ]; then',
    '  echo "[farmslot] runner launch command exited $__farmslot_status; preserving pane for diagnostics" >&2',
    `  sleep ${ROLE_LAUNCH_FAILURE_DIAGNOSTIC_HOLD_SECONDS}`,
    'fi',
    'exit "$__farmslot_status"',
  ];
  return `bash -c ${shellQuote(lines.join('\n'))}`;
}

async function tmuxSessionExists(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
): Promise<boolean> {
  return (
    (await execOnSlot(vars, tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`)))
      .exitCode === 0
  );
}

async function tmuxTargetHasPane(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
): Promise<boolean> {
  const pane = await execOnSlot(
    vars,
    tmuxShellSnippet(`list-panes -t ${shellQuote(target)} -F '#{pane_pid}' 2>/dev/null | head -1`),
  );
  return pane.exitCode === 0 && pane.stdout.trim().length > 0;
}

async function optionalFirstWindowTarget(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
): Promise<string | null> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(`list-windows -t ${shellQuote(session)} -F '#I' 2>/dev/null | head -1`),
  );
  const firstIdx = result.stdout.trim();
  return firstIdx ? `${session}:${firstIdx}` : null;
}

export async function dispatchExecute(
  params: DispatchExecuteParams,
  emit: EventEmitter,
): Promise<{ dispatched: boolean; launchCommand?: string }> {
  const vars = await loadSlotVars(params.slotId);

  // Check dispatchability
  if (vars.slotMode === 'disabled') throw new Error(`Slot ${params.slotId} is disabled`);
  if (vars.slotMode === 'custom' && !params.force)
    throw new Error(`Slot ${params.slotId} is in manual mode — use force`);

  let projectVars;
  let projectJson: RawProjectJson = {};
  try {
    projectVars = await loadProjectVars(vars.projectName);
    projectJson = projectVars.projectJson;
  } catch (err) {
    // Missing project.json or unreadable resources: fall back to an empty record so the
    // dispatcher can still launch with defaults. Per-field reads below null-check the result.
    console.warn(
      `[dispatch] project vars load failed for ${vars.projectName}, using empty defaults: ${(err as Error).message}`,
    );
  }

  // Resolve task file path
  let taskFilePath = params.taskFile;
  if (!path.isAbsolute(taskFilePath)) {
    taskFilePath = path.join(farmslotRoot, taskFilePath);
  }
  if (!existsSync(taskFilePath)) throw new Error(`Task file not found: ${taskFilePath}`);

  const step = (name: string, detail: string) => emit('dispatch.step', { name, detail });

  // Parse task file for metadata
  const taskContent = await readFile(taskFilePath, 'utf-8');
  const taskDir = path.dirname(taskFilePath);
  const taskFolderId = path.basename(taskDir);
  const flowSubdir = path.basename(path.dirname(taskDir));
  const { getRun, updateRun: updateRunStore } = await import('../../runs/store.js');
  const currentRun = params.runId ? getRun(params.runId) : null;

  const branch =
    extractField(taskContent, /^\*\*Branch:\*\*\s*`?([^`\n]+)/m) ||
    extractField(taskContent, /^PR_BRANCH:\s*(\S+)/m) ||
    extractField(taskContent, /^BRANCH:\s*(\S+)/m) ||
    '';

  const parsedTaskId = taskFolderId.split('-').slice(0, 2).join('-').toUpperCase();
  const taskId = currentRun?.ticketOrPr ?? parsedTaskId;
  const taskProfileFlowType = extractField(taskContent, /^- Task profile:\s*(\S+)/m);
  const workerHeadingFlowType =
    extractField(taskContent, /^# Worker:\s*(.+)/m)
      ?.toLowerCase()
      .replace(/\s+/g, '-') || '';
  const flowType = currentRun?.flowType || taskProfileFlowType || workerHeadingFlowType;
  const defaultFlowKey =
    flowTypeToKey(taskProfileFlowType) ||
    flowTypeToKey(flowType) ||
    flowTypeToKey(workerHeadingFlowType);
  const selectedApp = params.app || extractField(taskContent, /^APP:\s*(\S+)/m) || '';
  const requestedRunner =
    params.runner ||
    extractField(taskContent, /^\*\*Runner:\*\*\s*`?([^`\n]+)/m) ||
    (defaultFlowKey ? getProjectField(projectJson, `defaults.${defaultFlowKey}.runner`) : '') ||
    'claude';
  assertSupportedRunnerSpelling(requestedRunner);
  const runner = normalizeRunner(requestedRunner);
  const model =
    params.model ||
    extractField(taskContent, /^\*\*Model:\*\*\s*`?([^`\n]+)/m) ||
    (defaultFlowKey ? getProjectField(projectJson, `defaults.${defaultFlowKey}.model`) : '') ||
    runnerDefaultModel(runner) ||
    DEFAULT_CLAUDE_MODEL;
  const effort =
    params.effort ||
    extractField(taskContent, /^\*\*Effort:\*\*\s*`?([^`\n]+)/m) ||
    (defaultFlowKey ? getProjectField(projectJson, `defaults.${defaultFlowKey}.effort`) : '') ||
    currentRun?.effort;
  const scripted = currentRun?.scripted ?? params.scripted;
  const scriptedCommand =
    runner === 'scripted' && scripted?.mode === 'command'
      ? resolveScriptedCommandFromRawProjectJson(scripted.commandRef, projectJson, vars.projectName)
      : undefined;
  assertScriptedRunnerConfig({
    runner,
    scripted,
    projectName: vars.projectName,
    projectConfig:
      scripted?.mode === 'command' && scriptedCommand
        ? { scripted: { commands: { [scripted.commandRef]: scriptedCommand } } }
        : null,
  });
  assertRunnerLaunchPrerequisites(vars, runner);

  step(
    'info',
    `${flowSubdir}/${taskFolderId} → ${params.slotId} (${runner}/${model}${effort ? `/${effort}` : ''})`,
  );
  if (params.mode === 'validation') {
    step(
      'warn',
      'Validation mode is active — review/human gates may auto-resolve. Use only for explicit validation lanes.',
    );
    console.warn(
      `[dispatch] validation mode enabled for ${params.slotId}/${taskId} (${flowType || 'unknown-flow'})`,
    );
  }

  // 0. Guard against slot contamination from a different run/task.
  const existingRunId = (await readSlotField(params.slotId, 'current_run_id')) as string | null;
  const existingTicket = (await readSlotField(params.slotId, 'current_ticket_or_pr')) as
    | string
    | null;
  const existingFlow = (await readSlotField(params.slotId, 'current_flow_type')) as string | null;
  const existingRunner = (await readSlotField(params.slotId, 'runner')) as string | null;
  const existingFamily = (await readSlotField(params.slotId, 'current_family_id')) as string | null;
  const existingLane = (await readSlotField(params.slotId, 'current_lane')) as string | null;
  const existingVariant = (await readSlotField(params.slotId, 'current_variant')) as string | null;
  const identityPolicy = evaluateSlotIdentityPolicy(
    {
      runId: existingRunId,
      ticket: existingTicket,
      flow: existingFlow,
      familyId: existingFamily,
      lane: existingLane,
      variant: existingVariant,
    },
    {
      runId: params.runId ?? null,
      ticket: taskId,
      flow: flowType || null,
      familyId: currentRun?.familyId ?? null,
      lane: currentRun?.lane ?? params.lane ?? null,
      variant: currentRun?.variant ?? params.variant ?? null,
      parentRunId: currentRun?.parentRunId ?? null,
    },
    params.mode,
  );
  if (identityPolicy.action !== 'allow') {
    if (identityPolicy.action === 'warn') {
      step(
        'warn',
        `Compatibility reuse on legacy slot identity (${existingRunId}/${existingFlow}/${existingTicket}/${existingFamily}/${existingLane}/${existingVariant})`,
      );
    } else if (identityPolicy.action === 'scrub') {
      step(
        'clean',
        `Validation mode auto-scrub for stale slot identity (${existingRunId}/${existingFlow}/${existingTicket}/${existingFamily}/${existingLane}/${existingVariant})`,
      );
      const slotMod = await import('../slot.js');
      await slotMod.killAllAgentWindows(vars);
      // Role windows are canonical; keep a base-pane kill as a fallback for
      // unnamed/manual windows without trusting possibly stale flow metadata.
      await slotMod.killAgentInSession(vars, existingRunner ?? undefined);
      await resetSlot(params.slotId, true);
    } else {
      throw new Error(
        `Slot contamination detected on ${params.slotId}: current_run_id=${existingRunId}, flow=${existingFlow}, ticket=${existingTicket}, family=${existingFamily}, lane=${existingLane}, variant=${existingVariant}`,
      );
    }
  }

  // 1. Claim slot
  step('claim', 'Claiming slot...');
  await updateSlotStatus(
    params.slotId,
    buildSlotClaimStatus({
      runId: params.runId ?? null,
      taskId,
      flowSubdir,
      taskFolderId,
      flowType: flowType || null,
      mode: params.mode,
      runner,
      model,
      currentRun,
      fallbackLane: params.lane ?? null,
      fallbackVariant: params.variant ?? null,
    }),
  );
  step('claim', 'Slot claimed, lifecycle=busy(dispatching)');

  // 2. Prepare slot
  if (!params.skipPrepare) {
    step('prepare', 'Preparing slot...');
    try {
      // pr-complete and merge-main leave integration to the worker. review-pr
      // checks out origin/<branch> unless mergeMain is explicitly requested on prepare.
      const mergeMain = false;
      await slotPrepare(
        {
          slotId: params.slotId,
          branch: branch || undefined,
          mergeMain,
          flowType: flowType || undefined,
          app: selectedApp || undefined,
        },
        emit,
      );
      step('prepare', 'Slot prepared');
    } catch (err) {
      // Rollback on prepare failure
      await updateSlotStatus(params.slotId, {
        lifecycle: 'ready',
        phase: null,
        task_id: null,
        task_file: null,
        dispatched_at: null,
      });
      throw new Error(`Prepare failed: ${(err as Error).message}`);
    }
  }
  if (params.runId) {
    const { captureWorktreeHeadSha } = await import('../../run-engine/diff-artifacts.js');
    const worktreeHeadAtDispatch = await captureWorktreeHeadSha(params.slotId);
    if (worktreeHeadAtDispatch) {
      updateRunStore(params.runId, { worktreeHeadAtDispatch });
    }
  }
  if (selectedApp) {
    await updateSlotStatus(params.slotId, { app: selectedApp });
  }

  // 3. Copy task to worker
  step('copy', 'Copying task files...');
  const taskDirName = resolveProjectTaskDirName(projectJson);
  const workerTaskDir = `${taskDirName}/${flowSubdir}/${taskFolderId}`;
  const workerTaskAbs = `${vars.remoteRepo}/${workerTaskDir}`;

  if (isLocal(vars.host, vars.machine)) {
    await mkdir(workerTaskAbs, { recursive: true });
    await copyFile(taskFilePath, path.join(workerTaskAbs, 'TASK.md'));
  } else {
    await execOnSlot(vars, `mkdir -p '${workerTaskAbs}'`);
    await execLocal(`scp -q '${taskFilePath}' '${vars.sshTarget}:${workerTaskAbs}/TASK.md'`);
  }
  step('copy', `TASK.md copied to ${workerTaskDir}/TASK.md`);
  for (const sidecar of await copyPreparedTaskRootSidecars({
    taskDir,
    workerTaskAbs,
    host: vars.host,
    machine: vars.machine,
    sshTarget: vars.sshTarget,
  })) {
    step('copy', `${sidecar} copied`);
  }

  // Copy assets/, inputs/, artifacts/ if they exist
  for (const subdir of ['assets', 'inputs', 'artifacts']) {
    const localDir = path.join(taskDir, subdir);
    if (existsSync(localDir)) {
      if (isLocal(vars.host, vars.machine)) {
        await cp(localDir, path.join(workerTaskAbs, subdir), { recursive: true });
      } else {
        await execLocal(`rsync -az '${localDir}/' '${vars.sshTarget}:${workerTaskAbs}/${subdir}/'`);
      }
      step('copy', `${subdir}/ copied`);
    }
  }

  // We just wrote artifacts/recipe.json + artifacts/recipe-flows/ into the
  // worker task dir. loadLiveRecipeContextForRun tries the worker-prefix path
  // first via shouldPreferLocalPortableArtifacts, so any UI panel that warmed
  // the cache before dispatch would serve the previous worker-side values for
  // 5s without this invalidation. Slot-scoped + per-run memo bust.
  invalidateArtifactTextCache(path.join(workerTaskAbs, 'artifacts'), vars.slotId);
  if (currentRun?.id) invalidateLiveRecipeContextMemo(currentRun.id);

  // 4. Clean pane (kill any existing agent)
  step('clean', 'Cleaning pane...');
  const slotMod = await import('../slot.js');
  const session = await resolveTmuxSession(vars.slotId, vars, { strict: true });
  const workerRole = primaryRoleForFlow(currentRun?.flowType ?? flowType);
  // workerTarget gets reassigned by ensureWorkerRoleTarget below; the
  // unbound-window placeholder here is only consulted by waitForRunnerProcessExit
  // when no role window exists, and we resolve it via firstWindowTarget so
  // base-index-1 hosts don't get pointed at a non-existent `${session}:0`.
  let workerTarget = '';
  let primaryTarget: AgentContextTarget = {
    session,
    window: null,
    pane: null,
    target: workerTarget,
  };
  let primaryWatchContext: AgentContext | null = null;
  const hasSession = await tmuxSessionExists(vars, session);
  if (hasSession) {
    await cleanupDeadPanesInSession(vars, session);
    // Starting a new dispatch must clear role windows left by the previous run,
    // including orchestration flows that do not map to a role-scoped worker.
    // Exclude this dispatch's own role so a sibling concurrent flow's window
    // (comparison lane, family follow-up) is not collateral damage when its
    // dispatch is racing this one through the same slot session.
    await slotMod.killAllAgentWindows(vars, session, { exclude: [workerRole] });
    const cleanupRunners = [
      ...new Set(
        [existingRunner, runner]
          .filter(
            (candidate): candidate is string =>
              typeof candidate === 'string' && candidate.trim().length > 0,
          )
          .map((candidate) => normalizeRunner(candidate)),
      ),
    ];
    for (const cleanupRunner of cleanupRunners) {
      await slotMod.killAgentInSession(vars, cleanupRunner, workerRole);
    }
    const stillHasSession = await tmuxSessionExists(vars, session);
    if (stillHasSession) {
      const existingRoleWindow = agentRoleWindow(workerRole);
      const exitTarget = existingRoleWindow
        ? `${session}:${existingRoleWindow}`
        : await optionalFirstWindowTarget(vars, session);
      if (exitTarget && (await tmuxTargetHasPane(vars, exitTarget))) {
        await waitForRunnerProcessExit(vars, exitTarget, runner);
      }
    }
  }
  workerTarget = await ensureWorkerRoleTarget(vars, session, runner, workerRole);
  if (agentRoleWindow(workerRole)) {
    // Role windows can contain a different runner than the new dispatch when a
    // slot is reused across runners. Killing only the requested runner can
    // leave the stale foreground process in control; the launch prelude's C-c
    // then interrupts that stale process and can leave the pane dead before
    // the new runner line is typed. Always start role-scoped worker dispatches
    // from a freshly respawned shell after cleanup.
    await respawnRoleWindowForDispatch(vars, workerTarget);
  }
  primaryTarget = {
    session,
    window: agentRoleWindow(workerRole),
    pane: null,
    target: workerTarget,
  };
  if (params.runId && currentRun) {
    await upsertAgentContext(params.runId, workerRole, {
      status: 'launching',
      taskFile: `${workerTaskDir}/TASK.md`,
      signalFile: `${workerTaskDir}/SIGNAL.json`,
      runner,
      model,
      target: primaryTarget,
    });
  }
  step('clean', 'Pane ready');

  // 5. Launch agent
  step('launch', 'Launching agent...');
  const workerTaskFile = `${workerTaskDir}/TASK.md`;
  const taskPrompt = await resolveWorkerDispatchPrompt(vars.projectName, {
    taskFile: workerTaskFile,
    taskDir: workerTaskDir,
  });
  const sessionFilesBefore = await listRunnerSessionFiles(vars, runner);
  const safetyTier = resolveDispatchSafetyTier({
    paramsTier: params.safetyTier,
    runTier: currentRun?.safetyTier,
    projectDefaultRaw: projectJson.default_safety_tier,
  });
  let agentLaunch = buildLaunchCommand(vars, runner, model, taskPrompt, {
    taskFile: `${workerTaskDir}/TASK.md`,
    taskDir: workerTaskDir,
    scripted,
    scriptedCommand,
    claudeUsesDispatchCmd: true,
    effort,
    safetyTier,
    runtimeDir: projectVars?.runtimeDir,
  });

  agentLaunch = applyProjectCommandEnv(projectJson, `${WORKER_ENV_PREFIX} && ${agentLaunch}`);

  let sessionMeta: Awaited<ReturnType<typeof captureRunnerSessionMetadata>> = {
    runnerSessionPath: null,
    runnerSessionId: null,
  };
  let runnerProcessStarted = false;
  try {
    const roleWindowName = agentRoleWindow(workerRole);
    const usesRoleWindow = Boolean(roleWindowName);
    const settleFreshRoleWindow = async () => {
      if (!usesRoleWindow) return;
      await new Promise((resolve) => setTimeout(resolve, ROLE_WINDOW_STARTUP_SETTLE_MS));
    };
    const sendPreludeClear = async (stage: string) => {
      const result = await execOnSlot(
        vars,
        tmuxShellSnippet(`send-keys -t ${shellQuote(workerTarget)} C-c C-u`),
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to clear ${runner} launch input (${stage}) in ${workerTarget}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
        );
      }
    };

    if (usesRoleWindow) {
      workerTarget = await ensureWorkerRoleTarget(vars, session, runner, workerRole);
      await respawnRoleWindowWithCommand(vars, workerTarget, agentLaunch);
      await settleFreshRoleWindow();
    } else {
      // Some shell init paths (e.g. anaconda's `(base)` prompt activation) query
      // the terminal for DA1/DA2 attributes during prompt setup. The terminal's
      // response (`\033[?1;2c`, `\033[>0;276;0c`) lands on stdin AFTER the
      // prompt is drawn, so zsh interprets it as typed input. If our send-keys
      // appends the launch line to the same prompt buffer, the result is a
      // single zsh command line of `1;2c0;276;0cexport DISABLE_OMC=1 …` that
      // fails before codex/claude ever runs — and the monitor then misreads
      // "no agent process" as "completed" because the worker never started.
      //
      // Double-flush sequence: a single clear-then-wait would leave a race
      // where DA responses landing during the wait re-poison the prompt buffer
      // before the launch line types. Pre-clear discards anything the shell
      // already absorbed, the wait lets in-flight responses arrive, and the
      // post-clear sweeps the late arrivals before any user-visible keystrokes.
      // C-c covers heredoc/quote parsing on garbage; C-u clears the prompt line.
      await sendPreludeClear('pre-clear');
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_PRELUDE_DA_WAIT_MS));
      await sendPreludeClear('post-clear');
      // Tiny settle so the second C-u takes effect before the literal-text
      // send-keys below appends the launch line to (now-empty) prompt input.
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_PRELUDE_SETTLE_MS));
      const launchResult = await execOnSlot(
        vars,
        tmuxSendTextCommand(workerTarget, agentLaunch, { enter: true }),
      );
      if (launchResult.exitCode !== 0) {
        throw new Error(
          `Failed to launch ${runner} in ${workerTarget}: ${launchResult.stderr || launchResult.stdout || `exit ${launchResult.exitCode}`}`,
        );
      }
    }
    // tmux send-keys returning exit 0 only proves the keystrokes were typed,
    // NOT that the receiving shell parsed them as the launch command. If shell
    // init garbage prefixed the line (DA escape responses, etc.), the shell
    // splits it into a series of "command not found" lines and no runner
    // process ever spawns. Without an explicit start-check here, run-monitor
    // sees "no agent process" downstream and reports the run as 'done'
    // instead of 'failed' — the false-success path that left review-pr runs
    // sitting at human-gate waiting for artifacts that were never produced.
    await assertRunnerProcessStarted(vars, workerTarget, runner);
    runnerProcessStarted = true;
    if (runnerResolvesPreTaskLaunchBlockers(runner)) {
      await resolveRunnerLaunchBlockers(vars, workerTarget, runner);
      // Cursor receives the task prompt on argv, so resolving a launch blocker
      // is the last gate before monitor starts; verify the runner survived it.
      await assertRunnerProcessStarted(vars, workerTarget, runner, 5_000);
    }
    step('launch', `${runner} launched in tmux target ${workerTarget}`);
    primaryTarget = await captureAgentPaneTarget(vars, session, workerTarget);
    const workerPaneId = await resolveTmuxPaneId(vars, primaryTarget.target ?? workerTarget);
    sessionMeta = await captureRunnerSessionMetadata(vars, runner, sessionFilesBefore, {
      sinceMs: currentRun ? (dispatchStartedAtMs(currentRun) ?? Date.now()) : Date.now(),
      paneId: workerPaneId,
      slotId: vars.slotId,
    });

    // For Claude runner: wait for prompt readiness then send task.
    //
    // Two defects in the previous implementation caused silent prompt loss after
    // Claude Code upgraded from 2.1.77 → 2.1.90:
    //   1. The readiness check short-circuited on first sight of `❯` or `⏵⏵`,
    //      but Claude renders those markers on its welcome-screen chrome BEFORE
    //      the JS input handler is wired up. Keys sent at that moment go nowhere.
    //   2. `tmux send-keys` returns 0 whenever the target session exists; it
    //      does NOT confirm the attached process consumed the characters. The
    //      old code trusted that exit code and marked `task: ok`, leaving the
    //      run to enter `monitor` with an idle worker.
    //
    // Fix: wait for N consecutive identical pane captures (stability), then
    // verify after every send by re-capturing the pane and asserting it changed
    // AND now contains a unique marker from our prompt (`TASK.md`). Retry up to
    // 3 times before failing the step loudly so the run stops instead of hanging
    // in monitor.
    if (runnerNeedsPostLaunchPrompt(runner)) {
      step('task', 'Waiting for agent ready...');
      const handoffAckSinceMs = Date.now();
      await sendRunnerPostLaunchPrompt(
        vars,
        workerTarget,
        runner,
        taskPrompt,
        'TASK.md',
        'dispatch',
        {
          readyTimeoutMs: RUNNER_LAUNCH_READY_TIMEOUT_MS,
          blockerSnapshotPath: `${workerTaskDir}/artifacts/runner-blockers/dispatch-launch.txt`,
          signalPath: `${workerTaskDir}/SIGNAL.json`,
          launchAckSignalPath: `${workerTaskDir}/SIGNAL.json`,
          handoffAckSinceMs,
          softAcceptOnHandoffAck: true,
        },
      );
      step('task', 'Task prompt delivered and verified');
    }
  } catch (err) {
    if (params.runId && currentRun) {
      await markAgentContextStatus(params.runId, workerRole, 'failed', {
        lastSignalAt: new Date().toISOString(),
        target: primaryTarget,
      });
    }
    if (runnerProcessStarted) {
      try {
        step('cleanup', `Stopping launched ${runner} after dispatch failure...`);
        await cleanupLaunchedWorkerAfterDispatchFailure(vars, workerTarget, runner, workerRole);
        step('cleanup', `Stopped launched ${runner} after dispatch failure`);
      } catch (cleanupErr) {
        throw new Error(
          `${(err as Error).message}\n\nDispatch cleanup also failed after ${runner} launched in ${workerTarget}: ${(cleanupErr as Error).message}`,
          { cause: err },
        );
      }
    }
    throw err;
  }

  // 6. Update status + start TASK.md watching
  await markSlotBusy(params.slotId, 'working', 'working');
  if (params.runId) {
    const latestRun = getRun(params.runId);
    if (latestRun) {
      if (sessionMeta.runnerSessionId || sessionMeta.runnerSessionPath) {
        updateRunStore(params.runId, {
          metrics: {
            ...latestRun.metrics,
            runnerSessionId: sessionMeta.runnerSessionId,
            runnerSessionPath: sessionMeta.runnerSessionPath,
          },
        });
      }
      primaryWatchContext = await upsertAgentContext(params.runId, workerRole, {
        status: 'working',
        taskFile: `${workerTaskDir}/TASK.md`,
        signalFile: `${workerTaskDir}/SIGNAL.json`,
        runner,
        model,
        target: primaryTarget,
        runnerSessionId: sessionMeta.runnerSessionId,
        runnerSessionPath: sessionMeta.runnerSessionPath,
      });
    }
  }
  if (primaryWatchContext) {
    await watchContext(params.slotId, primaryWatchContext);
  } else {
    await watchSlot(params.slotId);
  }

  emit('dispatch.done', { slotId: params.slotId, taskId, runner, model });
  return { dispatched: true, launchCommand: agentLaunch };
}

function extractField(content: string, pattern: RegExp): string {
  const match = content.match(pattern);
  return match?.[1]?.trim() || '';
}
