import type { MachinePauseRecoveryHandle } from '@farmslot/protocol';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
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
  type SessionReloadCapability,
  WORKER_ENV_PREFIX,
} from './registry.js';
import {
  findRunnerDescendantPid,
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
      return failure('failed', runnerId, target, 'unknown', remaining.reason!);
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
