import type { MachinePauseRecoveryHandle } from '@farmslot/protocol';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  ensureTmuxWindow,
  listExactTmuxWindows,
  resolveTmuxSession,
  respawnTmuxPaneWithCommand,
  shellQuote,
  tmuxSendTextCommand,
  tmuxShellSnippet,
} from '../core/tmux.js';

import {
  buildRunnerSessionReloadCommand,
  RUNNER_LAUNCH_READY_TIMEOUT_MS,
} from './launch-command.js';
import { writeRunnerPromptSentinel } from './observability-sentinel.js';
import {
  captureRunnerPromptAcceptanceBaseline,
  getRunnerDefinition,
  isKnownRunner,
  normalizeRunner,
  runnerHasDurablePromptHandoff,
  runnerIdsRequiringExplicitTerminationIdentity,
  runnerIdsSafeForUnattributedTermination,
  type SessionReloadCapability,
  WORKER_ENV_PREFIX,
} from './registry.js';
import {
  findRunnerDescendantPid,
  probeRunnerDescendantPid,
  resumableSessionProbeCommand,
  verifyExactLiveRunnerSessionBinding,
} from './session-process.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export const RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS = 10_000;
export const RUNNER_PARK_RELOAD_ACCEPTANCE_TIMEOUT_MS = RUNNER_LAUNCH_READY_TIMEOUT_MS;

export interface RunnerRecoveryInspection {
  runnerId: string;
  supported: boolean;
  gracefulStop: { supported: boolean; command?: string };
  sessionReload: { supported: boolean; capability: SessionReloadCapability };
  recoveryHandle: { valid: boolean; reason?: string };
  liveTarget: {
    valid: boolean;
    paneTarget?: string;
    state?: 'live' | 'stopped';
    reason?: string;
  };
  liveBinding: {
    valid: boolean;
    sessionId?: string;
    canonicalSessionPath?: string;
    source?: string;
    reason?: string;
  };
  reason?: string;
}

export interface InspectRunnerRecoveryOptions {
  /**
   * Required only to probe a persisted session. A declaration-only inspection
   * (no `recoveryHandle`) reads the runner registry and returns before any
   * exec, so callers asking only "can this runner reload a session?" must not
   * be forced to load slot vars they will never use.
   */
  vars?: SlotVars;
  runnerId: string | null | undefined;
  recoveryHandle: MachinePauseRecoveryHandle | null | undefined;
  /** Release requires live; restore preview may accept stopped or live; reload requires stopped. */
  expectedRunnerState?: 'live' | 'stopped' | 'stopped-or-live';
}

/** Inspect registry declarations and prove the exact persisted session still exists. */
export async function inspectRunnerRecovery(
  options: InspectRunnerRecoveryOptions,
  deps: Pick<RunnerSessionLifecycleDeps, 'exec' | 'findRunnerPid' | 'verifyLiveBinding'> = {
    exec: execOnSlot,
    findRunnerPid: findRunnerDescendantPid,
    verifyLiveBinding: verifyExactLiveRunnerSessionBinding,
  },
): Promise<RunnerRecoveryInspection> {
  const rawRunnerId = options.runnerId?.trim() ?? '';
  if (!rawRunnerId) return unsupportedInspection('', 'runner id is missing');
  const runnerId = normalizeRunner(rawRunnerId);
  if (!isKnownRunner(runnerId)) {
    return unsupportedInspection(runnerId, 'runner is not registered');
  }

  const definition = getRunnerDefinition(runnerId);
  const gracefulStop = definition.gracefulExit
    ? { supported: true, command: definition.gracefulExit.command }
    : { supported: false };
  const sessionReload = {
    supported: definition.sessionReload !== 'none',
    capability: definition.sessionReload,
  };
  const handleError = validateRecoveryHandle(runnerId, options.recoveryHandle);
  const recoveryHandle = handleError ? { valid: false, reason: handleError } : { valid: true };
  const reason = !gracefulStop.supported
    ? `runner '${runnerId}' has no graceful exit capability`
    : !sessionReload.supported
      ? `runner '${runnerId}' has no persisted session reload capability`
      : handleError;

  const inspection = {
    runnerId,
    supported: !reason,
    gracefulStop,
    sessionReload,
    recoveryHandle,
    liveTarget: { valid: false, reason: reason ?? 'live runner target not inspected' },
    liveBinding: { valid: false, reason: reason ?? 'live runner binding not inspected' },
    ...(reason ? { reason } : {}),
  };
  if (!inspection.supported || !options.recoveryHandle) return inspection;
  if (!options.vars) {
    throw new Error('inspectRunnerRecovery requires slot vars to probe a recovery handle');
  }
  const probe = await deps.exec(
    options.vars,
    resumableSessionProbeCommand(options.recoveryHandle.sessionPath),
    { timeout: 10_000 },
  );
  if (probe.exitCode !== 0) {
    const pathReason = `Persisted runner session path is unavailable: ${options.recoveryHandle.sessionPath}`;
    return {
      ...inspection,
      supported: false,
      recoveryHandle: { valid: false, reason: pathReason },
      liveTarget: { valid: false, reason: pathReason },
      liveBinding: { valid: false, reason: pathReason },
      reason: pathReason,
    };
  }
  const pane = await inspectExactPane(options.vars, options.recoveryHandle, deps);
  if ('error' in pane) {
    const targetReason = `Exact runner target is uninspectable: ${pane.error}`;
    return {
      ...inspection,
      supported: false,
      liveTarget: { valid: false, reason: targetReason },
      liveBinding: { valid: false, reason: targetReason },
      reason: targetReason,
    };
  }
  const runnerPid = await deps.findRunnerPid(options.vars, pane.panePid, runnerId, {
    timeout: 10_000,
  });
  const state = runnerPid ? 'live' : 'stopped';
  const expected = options.expectedRunnerState ?? 'live';
  if (expected !== 'stopped-or-live' && state !== expected) {
    const targetReason = `Exact runner pane ${pane.paneId} is ${state}; expected ${expected} '${runnerId}' process`;
    return {
      ...inspection,
      supported: false,
      liveTarget: { valid: false, reason: targetReason },
      liveBinding: { valid: false, reason: targetReason },
      reason: targetReason,
    };
  }
  if (state === 'live') {
    const binding = await (deps.verifyLiveBinding ?? verifyExactLiveRunnerSessionBinding)(
      options.vars,
      runnerId,
      {
        paneId: pane.paneId,
        slotId: options.vars.slotId,
        expectedSessionId: options.recoveryHandle.sessionId,
        expectedSessionPath: options.recoveryHandle.sessionPath,
      },
    );
    if (!binding.ok) {
      return {
        ...inspection,
        supported: false,
        liveTarget: { valid: true, paneTarget: pane.paneId, state },
        liveBinding: { valid: false, reason: binding.reason },
        reason: binding.reason,
      };
    }
    return {
      ...inspection,
      liveTarget: { valid: true, paneTarget: pane.paneId, state },
      liveBinding: {
        valid: true,
        sessionId: binding.binding.runnerSessionId,
        canonicalSessionPath: binding.binding.canonicalSessionPath,
        source: binding.binding.source,
      },
    };
  }
  return {
    ...inspection,
    liveTarget: { valid: true, paneTarget: pane.paneId, state },
    liveBinding: { valid: false, reason: 'runner is stopped' },
  };
}

function unsupportedInspection(runnerId: string, reason: string): RunnerRecoveryInspection {
  return {
    runnerId,
    supported: false,
    gracefulStop: { supported: false },
    sessionReload: { supported: false, capability: 'none' },
    recoveryHandle: { valid: false, reason },
    liveTarget: { valid: false, reason },
    liveBinding: { valid: false, reason },
    reason,
  };
}

function validateRecoveryHandle(
  runnerId: string,
  handle: MachinePauseRecoveryHandle | null | undefined,
): string | undefined {
  if (!handle) return 'persisted runner recovery handle is missing';
  if (handle.version !== 1) return 'persisted runner recovery handle version is unsupported';
  if (!handle.runnerId.trim()) return 'persisted runner id is missing';
  if (normalizeRunner(handle.runnerId) !== runnerId) {
    return `recovery handle runner '${handle.runnerId}' does not match '${runnerId}'`;
  }
  if (!handle.sessionId.trim()) return 'persisted runner session id is missing';
  if (!handle.sessionPath.trim()) return 'persisted runner session path is missing';
  if (!handle.contextId.trim()) return 'persisted runner context id is missing';
  if (!handle.target.session.trim() || !handle.target.target.trim()) {
    return 'persisted runner tmux target is incomplete';
  }
  if (!/^%\d+$/.test(handle.target.paneId)) {
    return 'persisted runner tmux pane id is missing or invalid';
  }
  if (!Number.isFinite(Date.parse(handle.capturedAt))) {
    return 'persisted runner recovery capture time is invalid';
  }
  return undefined;
}

export type StopRunnerForParkResult =
  | {
      ok: true;
      status: 'already-stopped' | 'stopped';
      runnerId: string;
      target: string;
      residualRunner: 'stopped';
    }
  | {
      ok: false;
      status: 'unsupported' | 'failed' | 'still-running';
      runnerId: string;
      target: string;
      residualRunner: 'running' | 'unknown';
      error: string;
    };

export interface StopRunnerForParkOptions {
  vars: SlotVars;
  recoveryHandle: MachinePauseRecoveryHandle;
  timeoutMs?: number;
}

export interface RunnerRunningForParkOptions {
  vars: SlotVars;
  recoveryHandle: MachinePauseRecoveryHandle;
}

interface RunnerSessionLifecycleDeps {
  exec: typeof execOnSlot;
  findRunnerPid: typeof findRunnerDescendantPid;
  respawnPane: typeof respawnTmuxPaneWithCommand;
  capturePromptBaseline?: typeof captureRunnerPromptAcceptanceBaseline;
  probePromptHandoff?: typeof runnerHasDurablePromptHandoff;
  writePromptSentinel?: typeof writeRunnerPromptSentinel;
  verifyLiveBinding?: typeof verifyExactLiveRunnerSessionBinding;
  /** Runner-neutral occupancy probe; preserves "unreadable" separately from "absent". */
  probeRunnerPid?: typeof probeRunnerDescendantPid;
  /** The slot's own tmux session, so a re-host cannot land in a foreign one. */
  resolveSession?: typeof resolveTmuxSession;
  /** Exact-name window listing, used to find or re-host a parked session's pane. */
  listWindows?: typeof listExactTmuxWindows;
  ensureWindow?: typeof ensureTmuxWindow;
  sleep(ms: number): Promise<void>;
}

const DEFAULT_DEPS: RunnerSessionLifecycleDeps = {
  exec: execOnSlot,
  findRunnerPid: findRunnerDescendantPid,
  respawnPane: respawnTmuxPaneWithCommand,
  capturePromptBaseline: captureRunnerPromptAcceptanceBaseline,
  probePromptHandoff: runnerHasDurablePromptHandoff,
  writePromptSentinel: writeRunnerPromptSentinel,
  verifyLiveBinding: verifyExactLiveRunnerSessionBinding,
  probeRunnerPid: probeRunnerDescendantPid,
  resolveSession: resolveTmuxSession,
  listWindows: listExactTmuxWindows,
  ensureWindow: ensureTmuxWindow,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Read-only residual liveness through the same runner-owned process matcher. */
export async function runnerRunningForPark(
  options: RunnerRunningForParkOptions,
  deps: RunnerSessionLifecycleDeps = DEFAULT_DEPS,
): Promise<'running' | 'stopped' | 'unknown'> {
  const handle = options.recoveryHandle;
  const inspection = await inspectRunnerRecovery(
    {
      vars: options.vars,
      runnerId: handle.runnerId,
      recoveryHandle: handle,
      expectedRunnerState: 'stopped-or-live',
    },
    deps,
  );
  if (!inspection.supported) return 'unknown';
  return inspection.liveTarget.state === 'live' ? 'running' : 'stopped';
}

/** Gracefully exit a runner using only its registry-declared command. */
export async function stopRunnerForPark(
  options: StopRunnerForParkOptions,
  deps: RunnerSessionLifecycleDeps = DEFAULT_DEPS,
): Promise<StopRunnerForParkResult> {
  const handle = options.recoveryHandle;
  const rawRunnerId = handle.runnerId.trim();
  const runnerId = rawRunnerId ? normalizeRunner(rawRunnerId) : '';
  const target = handle.target.paneId;
  if (!isKnownRunner(runnerId) || !getRunnerDefinition(runnerId).gracefulExit) {
    return {
      ok: false,
      status: 'unsupported',
      runnerId,
      target,
      residualRunner: 'unknown',
      error: `Runner '${runnerId}' has no graceful exit capability`,
    };
  }

  const inspection = await inspectRunnerRecovery(
    {
      vars: options.vars,
      runnerId,
      recoveryHandle: handle,
      expectedRunnerState: 'stopped-or-live',
    },
    deps,
  );
  if (!inspection.supported) {
    return failure('failed', runnerId, target, 'unknown', inspection.reason!);
  }
  if (inspection.liveTarget.state === 'stopped') {
    return { ok: true, status: 'already-stopped', runnerId, target, residualRunner: 'stopped' };
  }

  const definition = getRunnerDefinition(runnerId);
  const sendTarget = handle.target.paneId;
  const sent = await deps.exec(
    options.vars,
    tmuxSendTextCommand(sendTarget, definition.gracefulExit!.command, {
      enter: true,
      submitKey: definition.promptSubmitKey,
      submitDelayMs: definition.gracefulExit!.submitDelayMs,
    }),
    { timeout: 10_000 },
  );
  if (sent.exitCode !== 0) {
    return failure(
      'failed',
      runnerId,
      target,
      'unknown',
      sent.stderr || sent.stdout || `graceful exit command failed with exit ${sent.exitCode}`,
    );
  }

  const deadline = Date.now() + (options.timeoutMs ?? RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS);
  let lastUnusable: string | null = null;
  while (Date.now() < deadline) {
    const remaining = await inspectRunnerRecovery(
      {
        vars: options.vars,
        runnerId,
        recoveryHandle: handle,
        expectedRunnerState: 'stopped-or-live',
      },
      deps,
    );
    if (!remaining.supported) {
      // The inspection proves the live process still OWNS the persisted
      // session, and a worker in the middle of the exit we just asked for
      // cannot: one probe still sees the process while the next no longer
      // finds it to read a start time from. Treating that as a stop failure
      // fails the park at the exact moment the exit is landing — which is the
      // outcome this loop is waiting for.
      //
      // So ask the question the loop actually cares about, structurally: is a
      // runner process still there? Absence is the exit; presence keeps
      // waiting; an unreadable tree neither concludes nor gives up.
      lastUnusable = remaining.reason ?? 'runner recovery inspection is unusable';
      const pane = await inspectExactPane(options.vars, handle, deps);
      if (!('error' in pane)) {
        const probe = await (deps.probeRunnerPid ?? probeRunnerDescendantPid)(
          options.vars,
          pane.panePid,
          runnerId,
          { timeout: 10_000 },
        );
        if (probe.state === 'absent') {
          return {
            ok: true,
            status: 'stopped',
            runnerId,
            target: sendTarget,
            residualRunner: 'stopped',
          };
        }
      }
      await deps.sleep(200);
      continue;
    }
    if (remaining.liveTarget.state === 'stopped') {
      return {
        ok: true,
        status: 'stopped',
        runnerId,
        target: sendTarget,
        residualRunner: 'stopped',
      };
    }
    await deps.sleep(200);
  }
  if (lastUnusable) {
    return failure('failed', runnerId, target, 'unknown', lastUnusable);
  }
  return failure(
    'still-running',
    runnerId,
    target,
    'running',
    `Runner '${runnerId}' did not exit gracefully from ${target}`,
  );
}

function failure(
  status: 'failed' | 'still-running',
  runnerId: string,
  target: string,
  residualRunner: 'running' | 'unknown',
  error: string,
): StopRunnerForParkResult {
  return { ok: false, status, runnerId, target, residualRunner, error };
}

export type ReloadRunnerForParkResult =
  | {
      ok: true;
      status: 'reloaded';
      runnerId: string;
      target: string;
      sessionId: string;
      live: true;
      acknowledgement: {
        kind: 'structured';
        source: string;
        reason: string;
        turnToken?: string;
      };
    }
  | {
      ok: false;
      status:
        | 'unsupported'
        | 'session-unavailable'
        | 'invalid-prompt'
        | 'failed'
        | 'acceptance-failed';
      runnerId: string;
      target: string;
      sessionId: string;
      error: string;
    };

export interface ReloadRunnerForParkOptions {
  vars: SlotVars;
  recoveryHandle: MachinePauseRecoveryHandle;
  initialPrompt: string;
  timeoutMs?: number;
}

/** Reload exactly the persisted runner session; never falls back to a fresh launch. */
export async function reloadRunnerForPark(
  options: ReloadRunnerForParkOptions,
  deps: RunnerSessionLifecycleDeps = DEFAULT_DEPS,
): Promise<ReloadRunnerForParkResult> {
  const handle = options.recoveryHandle;
  const inspection = inspectRunnerRecovery(
    {
      vars: options.vars,
      runnerId: handle.runnerId,
      recoveryHandle: handle,
      expectedRunnerState: 'stopped',
    },
    { exec: deps.exec, findRunnerPid: deps.findRunnerPid },
  );
  const inspected = await inspection;
  const runnerId = inspected.runnerId;
  const target = handle.target.paneId;
  if (!inspected.supported) {
    return reloadFailure(
      inspected.reason?.includes('session path is unavailable')
        ? 'session-unavailable'
        : 'unsupported',
      runnerId,
      target,
      handle.sessionId,
      inspected.reason!,
    );
  }
  const initialPrompt = options.initialPrompt.trim();
  if (!initialPrompt) {
    return reloadFailure(
      'invalid-prompt',
      runnerId,
      target,
      handle.sessionId,
      'Runner park reload requires a non-empty continuation prompt',
    );
  }

  let command: string;
  let promptAcceptanceBaselineMs: number;
  try {
    const sentinel = await (deps.writePromptSentinel ?? writeRunnerPromptSentinel)(
      options.vars,
      initialPrompt,
    );
    const baseline = await (deps.capturePromptBaseline ?? captureRunnerPromptAcceptanceBaseline)(
      options.vars,
      target,
      runnerId,
      sentinel.sentAt,
    );
    if (baseline == null) {
      return reloadFailure(
        'acceptance-failed',
        runnerId,
        target,
        handle.sessionId,
        'Runner prompt acceptance baseline is unavailable',
      );
    }
    promptAcceptanceBaselineMs = baseline;
    command = `${WORKER_ENV_PREFIX} && ${buildRunnerSessionReloadCommand(
      options.vars,
      runnerId,
      handle.model,
      handle.sessionId,
      {
        effort: handle.effort,
        safetyTier: handle.safetyTier,
        runtimeDir: handle.runtimeDir,
        taskDir: handle.taskDir,
        initialPrompt,
      },
    )}`;
    await deps.respawnPane(options.vars, target, command, { preservePaneAfterExit: true });
  } catch (error) {
    return reloadFailure('failed', runnerId, target, handle.sessionId, (error as Error).message);
  }

  const deadline = Date.now() + (options.timeoutMs ?? RUNNER_PARK_RELOAD_ACCEPTANCE_TIMEOUT_MS);
  let lastReason = 'exact structured prompt acknowledgement did not arrive';
  while (Date.now() < deadline) {
    const acknowledgement = await (deps.probePromptHandoff ?? runnerHasDurablePromptHandoff)(
      options.vars,
      target,
      runnerId,
      initialPrompt,
      promptAcceptanceBaselineMs,
      {
        requirePromptDigest: true,
        promptAcceptanceBaselineMs,
        retainedSession: { sessionId: handle.sessionId, sessionPath: handle.sessionPath },
      },
    );
    lastReason = acknowledgement.reason;
    if (acknowledgement.accepted) {
      const running = await inspectRunnerRecovery(
        {
          vars: options.vars,
          runnerId,
          recoveryHandle: handle,
          expectedRunnerState: 'live',
        },
        deps,
      );
      if (running.supported) {
        return {
          ok: true,
          status: 'reloaded',
          runnerId,
          target,
          sessionId: handle.sessionId,
          live: true,
          acknowledgement: {
            kind: 'structured',
            source: acknowledgement.source ?? 'runner-observability',
            reason: acknowledgement.reason,
            ...(acknowledgement.turnToken ? { turnToken: acknowledgement.turnToken } : {}),
          },
        };
      }
      lastReason = 'exact prompt was accepted but the restored runner is no longer live';
    }
    await deps.sleep(200);
  }
  return reloadFailure(
    'acceptance-failed',
    runnerId,
    target,
    handle.sessionId,
    `Reloaded runner '${runnerId}' session '${handle.sessionId}' was not accepted/live: ${lastReason}`,
  );
}

function reloadFailure(
  status: 'unsupported' | 'session-unavailable' | 'invalid-prompt' | 'failed' | 'acceptance-failed',
  runnerId: string,
  target: string,
  sessionId: string,
  error: string,
): ReloadRunnerForParkResult {
  return { ok: false, status, runnerId, target, sessionId, error };
}

async function inspectExactPane(
  vars: SlotVars,
  handle: MachinePauseRecoveryHandle,
  deps: Pick<RunnerSessionLifecycleDeps, 'exec'>,
): Promise<
  { paneId: string; panePid: string; session: string; windowName: string } | { error: string }
> {
  const paneId = handle.target.paneId;
  const panes = await deps.exec(
    vars,
    tmuxShellSnippet(
      `display-message -p -t ${shellQuote(paneId)} '#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_pid}' 2>/dev/null`,
    ),
    { timeout: 10_000 },
  );
  if (panes.exitCode !== 0) {
    return { error: panes.stderr || panes.stdout || `Cannot inspect tmux pane ${paneId}` };
  }
  const rows = panes.stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (rows.length !== 1) {
    return { error: `Expected one exact tmux pane ${paneId}, found ${rows.length}` };
  }
  const [session, windowName, observedPaneId, panePid] = rows[0]!.split('\t', 4);
  if (observedPaneId !== paneId || !panePid) {
    return { error: `Tmux pane identity changed for ${paneId}` };
  }
  if (session !== handle.target.session) {
    return {
      error: `Tmux pane ${paneId} moved from session ${handle.target.session} to ${session ?? 'unknown'}`,
    };
  }
  const expectedWindow = handle.target.window?.trim();
  if (expectedWindow && !/^\d+$/.test(expectedWindow) && windowName !== expectedWindow) {
    return {
      error: `Tmux pane ${paneId} moved from window ${expectedWindow} to ${windowName ?? 'unknown'}`,
    };
  }
  return { paneId, panePid, session, windowName: windowName ?? '' };
}

// ─── Re-hosting a parked session (ADR-054 `free-slot`) ───────────────────────
//
// A park that frees the slot hands the whole slot — tmux session included — to
// the next occupant, and that occupant's dispatch replaces the windows in it.
// So by the time an operator restores a freed park, the exact pane the recovery
// handle names is routinely gone. Requiring it would make restore-after-a-
// successor impossible, which is the entire point of freeing the slot.
//
// The pane was never the identity. The persisted runner SESSION is: the reload
// command resumes it by id, and the structured acknowledgement proves the
// reload landed in that exact session. So restore re-hosts the session on a
// fresh pane in the slot's own tmux session and reloads into it, and refuses
// rather than respawning over a pane where a runner is still alive.
//
// Runner-agnostic by construction: window/pane mechanics and the registry's
// declarations only, no runner-name branch and no pane-text reading.

export type RunnerParkHostDisposition = 'exact' | 'rehost';

export type RunnerParkHostPlan =
  | {
      ok: true;
      disposition: RunnerParkHostDisposition;
      /**
       * The handle a reload must use. Identical to the input for `exact`; bound
       * to the re-hosted pane for `rehost`. The session id and path never move.
       */
      recoveryHandle: MachinePauseRecoveryHandle;
    }
  | { ok: false; reason: string };

/**
 * What the caller can prove about who owns a live worker on this slot.
 *
 * A matching native session id proves CONVERSATION identity, not Farmslot run
 * ownership: a successor dispatched with `--resume` inherits the same
 * conversation and would otherwise be adopted, and then respawned over. So
 * adopting a live worker needs evidence from the slot's own session records
 * that the pane belongs to THIS run.
 */
export interface RunnerParkHostOwnership {
  /** The run the restore is for. */
  runId: string;
  /** Exact pane ids the slot's session records bind to that run id. */
  ownedPaneIds: readonly string[];
}

export interface RunnerParkHostOptions {
  vars: SlotVars;
  recoveryHandle: MachinePauseRecoveryHandle;
  /** Omit to refuse every live occupant; nothing is adopted without evidence. */
  ownership?: RunnerParkHostOwnership;
}

/**
 * Read-only: can this persisted session be reloaded on this slot, and would it
 * need a new pane? Creates nothing, so a preview can call it.
 */
export function inspectRunnerParkHost(
  options: RunnerParkHostOptions,
  deps: RunnerSessionLifecycleDeps = DEFAULT_DEPS,
): Promise<RunnerParkHostPlan> {
  return resolveRunnerParkHost(options, deps, false);
}

/**
 * Bind the persisted session to a pane it can be reloaded into, creating the
 * slot's window when the freed slot's successor removed it. Refuses rather than
 * taking a pane a runner still occupies.
 */
export function rehostRunnerParkTarget(
  options: RunnerParkHostOptions,
  deps: RunnerSessionLifecycleDeps = DEFAULT_DEPS,
): Promise<RunnerParkHostPlan> {
  return resolveRunnerParkHost(options, deps, true);
}

async function resolveRunnerParkHost(
  options: RunnerParkHostOptions,
  deps: RunnerSessionLifecycleDeps,
  create: boolean,
): Promise<RunnerParkHostPlan> {
  const handle = options.recoveryHandle;
  const rawRunnerId = handle.runnerId.trim();
  const runnerId = rawRunnerId ? normalizeRunner(rawRunnerId) : '';
  if (!runnerId || !isKnownRunner(runnerId)) {
    return { ok: false, reason: `runner '${rawRunnerId || 'unknown'}' is not registered` };
  }
  const definition = getRunnerDefinition(runnerId);
  if (!definition.gracefulExit) {
    return { ok: false, reason: `runner '${runnerId}' has no graceful exit capability` };
  }
  if (definition.sessionReload === 'none') {
    return { ok: false, reason: `runner '${runnerId}' has no persisted session reload capability` };
  }
  const handleError = validateRecoveryHandle(runnerId, handle);
  if (handleError) return { ok: false, reason: handleError };

  // The conversation itself must still exist. Everything below only decides
  // WHERE to reload it; without this the restore would create a pane for a
  // session that cannot be resumed.
  const probe = await deps.exec(options.vars, resumableSessionProbeCommand(handle.sessionPath), {
    timeout: 10_000,
  });
  if (probe.exitCode !== 0) {
    return {
      ok: false,
      reason: `Persisted runner session path is unavailable: ${handle.sessionPath}`,
    };
  }

  // The slot's own session is the only one this restore may touch. The retained
  // path proves this before every stop and reload; the re-host has to as well,
  // or a same-named but foreign or stale session gets a window created in it
  // and this run's worker reloaded there.
  let slotSession: string;
  try {
    slotSession = await (deps.resolveSession ?? resolveTmuxSession)(
      options.vars.slotId,
      options.vars,
      { strict: true },
    );
  } catch (error) {
    return { ok: false, reason: `slot tmux session is unresolvable: ${messageOf(error)}` };
  }
  if (slotSession !== handle.target.session) {
    return {
      ok: false,
      reason: `slot session changed from '${handle.target.session}' to '${slotSession}'; recovery handle is stale`,
    };
  }

  const windowName = parkHostWindowName(handle);
  if (!windowName) {
    return {
      ok: false,
      reason: `persisted runner target '${handle.target.target}' names no exact tmux window to re-host into`,
    };
  }
  const listWindows = deps.listWindows ?? listExactTmuxWindows;
  // Lowest index wins, so two windows sharing a name resolve the same way on
  // every call rather than however tmux happened to order them.
  const windows = (await listWindows(options.vars, handle.target.session, windowName)).sort(
    (a, b) => a.windowIndex - b.windowIndex,
  );
  const recorded = windows.find((window) => window.paneId === handle.target.paneId);
  const candidate = recorded ?? windows[0];
  if (candidate) {
    // Runner-NEUTRAL, because the pane is not this runner's to assume. A freed
    // slot is handed to whoever dispatch picked, and that successor can be any
    // runner: probing only the parked runner's own process pattern makes a
    // surviving codex worker invisible to a claude restore, which then respawns
    // the pane and kills it.
    const occupant = await probeAnyRunnerOccupant(options.vars, candidate.panePid, runnerId, deps);
    if (occupant.state === 'unknown') {
      // Never destructive on an unreadable process tree.
      return {
        ok: false,
        reason: `tmux pane ${candidate.paneId} in ${handle.target.session}:${windowName} has an unreadable process tree: ${occupant.reason}`,
      };
    }
    if (occupant.state === 'present') {
      const refuse = (reason: string): RunnerParkHostPlan => ({
        ok: false,
        reason: `tmux pane ${candidate.paneId} in ${handle.target.session}:${windowName} is already running '${occupant.runnerId}' (pid ${occupant.pid}): ${reason}`,
      });
      // A live runner is not automatically someone else's: a restore retried
      // after one that reloaded the worker and then failed later finds ITS OWN
      // worker alive, and refusing that would make the retry impossible for
      // exactly the record that needs it.
      //
      // Two independent things have to hold, and the second is the one a
      // session id alone cannot give. Conversation identity says the process is
      // resuming this session; a successor dispatched with the same `--resume`
      // satisfies that too. OWNERSHIP is the slot's own session record binding
      // this pane to this run id, and without it nothing is adopted.
      if (occupant.runnerId !== runnerId) {
        return refuse(`a '${occupant.runnerId}' worker is not this run's '${runnerId}' session`);
      }
      if (!options.ownership) {
        return refuse('the caller supplied no run-ownership evidence for this slot');
      }
      if (!options.ownership.ownedPaneIds.includes(candidate.paneId)) {
        return refuse(
          `the slot's session records do not bind this pane to run '${options.ownership.runId}'`,
        );
      }
      const binding = await (deps.verifyLiveBinding ?? verifyExactLiveRunnerSessionBinding)(
        options.vars,
        runnerId,
        {
          paneId: candidate.paneId,
          slotId: options.vars.slotId,
          expectedSessionId: handle.sessionId,
          expectedSessionPath: handle.sessionPath,
          runnerPid: occupant.pid,
        },
      );
      if (!binding.ok) return refuse(binding.reason);
    }
    return recorded
      ? { ok: true, disposition: 'exact', recoveryHandle: handle }
      : {
          ok: true,
          disposition: 'rehost',
          recoveryHandle: reboundParkHandle(handle, windowName, candidate.paneId),
        };
  }
  if (!create) {
    // Nothing exists to bind to yet, and an inspection must not create it. The
    // verdict is still "re-hostable": the window is this slot's to make.
    return { ok: true, disposition: 'rehost', recoveryHandle: handle };
  }
  const ensured = await (deps.ensureWindow ?? ensureTmuxWindow)(
    options.vars,
    handle.target.session,
    windowName,
  );
  const created = [...ensured.windows].sort((a, b) => a.windowIndex - b.windowIndex)[0];
  if (!created) {
    return {
      ok: false,
      reason: `tmux window ${handle.target.session}:${windowName} could not be created for the re-hosted session`,
    };
  }
  return {
    ok: true,
    disposition: 'rehost',
    recoveryHandle: reboundParkHandle(handle, windowName, created.paneId),
  };
}

type RunnerParkOccupant =
  | { state: 'present'; runnerId: string; pid: string }
  | { state: 'absent' }
  | { state: 'unknown'; reason: string };

/**
 * Every runner that could be alive under this pane, not just the parked one.
 *
 * Uses the registry's own termination-identity vocabulary rather than a local
 * list, so a runner added to the registry is covered here without a second
 * edit. A runner that needs explicit identity to be attributed is reported as
 * `unknown` unless it is the one we are restoring: "cannot attribute" must not
 * read as "nobody is there" when the next step respawns the pane.
 */
async function probeAnyRunnerOccupant(
  vars: SlotVars,
  panePid: string,
  parkedRunnerId: string,
  deps: RunnerSessionLifecycleDeps,
): Promise<RunnerParkOccupant> {
  const probe = deps.probeRunnerPid ?? probeRunnerDescendantPid;
  const attributable = new Set([parkedRunnerId, ...runnerIdsSafeForUnattributedTermination()]);
  const ambiguous = runnerIdsRequiringExplicitTerminationIdentity().filter(
    (candidate) => !attributable.has(candidate),
  );
  for (const runnerId of [...attributable, ...ambiguous]) {
    const result = await probe(vars, panePid, runnerId, { timeout: 10_000 });
    if (result.state === 'unknown') return { state: 'unknown', reason: result.reason ?? 'unknown' };
    if (result.state === 'present') {
      if (attributable.has(runnerId)) return { state: 'present', runnerId, pid: result.pid };
      return {
        state: 'unknown',
        reason: `a '${runnerId}' process is present but cannot be attributed without its recorded runner identity`,
      };
    }
  }
  return { state: 'absent' };
}

/**
 * The exact window a re-host may use. A numeric window reference identifies a
 * position rather than a window, and positions shift when a successor's
 * dispatch rewrites the session — re-hosting onto one would be a guess.
 */
function parkHostWindowName(handle: MachinePauseRecoveryHandle): string | null {
  const explicit = handle.target.window?.trim();
  if (explicit && !/^\d+$/.test(explicit)) return explicit;
  const separator = handle.target.target.indexOf(':');
  const derived = separator > 0 ? handle.target.target.slice(separator + 1).trim() : '';
  return derived && !/^\d+$/.test(derived) ? derived : null;
}

function reboundParkHandle(
  handle: MachinePauseRecoveryHandle,
  windowName: string,
  paneId: string,
): MachinePauseRecoveryHandle {
  return {
    ...handle,
    target: {
      ...handle.target,
      window: windowName,
      // The recorded pane INDEX belonged to a layout that no longer exists;
      // keeping it would name a different pane than `paneId` does.
      pane: null,
      paneId,
      target: `${handle.target.session}:${windowName}`,
    },
    capturedAt: new Date().toISOString(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
