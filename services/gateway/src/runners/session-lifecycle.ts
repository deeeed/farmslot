import type { MachinePauseRecoveryHandle } from '@farmslot/protocol';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  respawnTmuxWindowWithCommand,
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
import { findRunnerDescendantPid, resumableSessionProbeCommand } from './session-process.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export const RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS = 10_000;
export const RUNNER_PARK_RELOAD_ACCEPTANCE_TIMEOUT_MS = RUNNER_LAUNCH_READY_TIMEOUT_MS;

export interface RunnerRecoveryInspection {
  runnerId: string;
  supported: boolean;
  gracefulStop: { supported: boolean; command?: string };
  sessionReload: { supported: boolean; capability: SessionReloadCapability };
  recoveryHandle: { valid: boolean; reason?: string };
  liveTarget: { valid: boolean; paneTarget?: string; reason?: string };
  reason?: string;
}

export interface InspectRunnerRecoveryOptions {
  vars: SlotVars;
  runnerId: string | null | undefined;
  recoveryHandle: MachinePauseRecoveryHandle | null | undefined;
  /** Release preflight defaults true; reload sets false because the parked runner is stopped. */
  requireLiveTarget?: boolean;
}

/** Inspect registry declarations and prove the exact persisted session still exists. */
export async function inspectRunnerRecovery(
  options: InspectRunnerRecoveryOptions,
  deps: Pick<RunnerSessionLifecycleDeps, 'exec' | 'findRunnerPid'> = {
    exec: execOnSlot,
    findRunnerPid: findRunnerDescendantPid,
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
    ...(reason ? { reason } : {}),
  };
  if (!inspection.supported || !options.recoveryHandle) return inspection;
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
      reason: pathReason,
    };
  }
  if (options.requireLiveTarget === false) {
    return {
      ...inspection,
      liveTarget: { valid: false, reason: 'live target check deferred for stopped-session reload' },
    };
  }
  const target = await runnerPids(
    options.vars,
    options.recoveryHandle.target.target,
    runnerId,
    deps,
  );
  if ('error' in target) {
    const targetReason = `Exact runner target is uninspectable: ${target.error}`;
    return {
      ...inspection,
      supported: false,
      liveTarget: { valid: false, reason: targetReason },
      reason: targetReason,
    };
  }
  if (target.processes.length !== 1) {
    const targetReason =
      target.processes.length === 0
        ? `Exact runner target ${options.recoveryHandle.target.target} has no live '${runnerId}' process`
        : `Exact runner target ${options.recoveryHandle.target.target} is ambiguous: found ${target.processes.length} live '${runnerId}' processes`;
    return {
      ...inspection,
      supported: false,
      liveTarget: { valid: false, reason: targetReason },
      reason: targetReason,
    };
  }
  return {
    ...inspection,
    liveTarget: { valid: true, paneTarget: target.processes[0]!.paneTarget },
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
  runnerId: string;
  target: string;
  timeoutMs?: number;
}

export interface RunnerRunningForParkOptions {
  vars: SlotVars;
  runnerId: string;
  target: string;
}

interface RunnerSessionLifecycleDeps {
  exec: typeof execOnSlot;
  findRunnerPid: typeof findRunnerDescendantPid;
  respawn: typeof respawnTmuxWindowWithCommand;
  capturePromptBaseline?: typeof captureRunnerPromptAcceptanceBaseline;
  probePromptHandoff?: typeof runnerHasDurablePromptHandoff;
  writePromptSentinel?: typeof writeRunnerPromptSentinel;
  sleep(ms: number): Promise<void>;
}

const DEFAULT_DEPS: RunnerSessionLifecycleDeps = {
  exec: execOnSlot,
  findRunnerPid: findRunnerDescendantPid,
  respawn: respawnTmuxWindowWithCommand,
  capturePromptBaseline: captureRunnerPromptAcceptanceBaseline,
  probePromptHandoff: runnerHasDurablePromptHandoff,
  writePromptSentinel: writeRunnerPromptSentinel,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Read-only residual liveness through the same runner-owned process matcher. */
export async function runnerRunningForPark(
  options: RunnerRunningForParkOptions,
  deps: RunnerSessionLifecycleDeps = DEFAULT_DEPS,
): Promise<'running' | 'stopped' | 'unknown'> {
  const rawRunnerId = options.runnerId.trim();
  if (!rawRunnerId) return 'unknown';
  const runnerId = normalizeRunner(rawRunnerId);
  if (!isKnownRunner(runnerId)) return 'unknown';
  const result = await runnerPids(options.vars, options.target.trim(), runnerId, deps);
  if ('error' in result) return 'unknown';
  return result.processes.length > 0 ? 'running' : 'stopped';
}

/** Gracefully exit a runner using only its registry-declared command. */
export async function stopRunnerForPark(
  options: StopRunnerForParkOptions,
  deps: RunnerSessionLifecycleDeps = DEFAULT_DEPS,
): Promise<StopRunnerForParkResult> {
  const rawRunnerId = options.runnerId.trim();
  const runnerId = rawRunnerId ? normalizeRunner(rawRunnerId) : '';
  const target = options.target.trim();
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

  const initial = await runnerPids(options.vars, target, runnerId, deps);
  if ('error' in initial) {
    return failure('failed', runnerId, target, 'unknown', initial.error);
  }
  if (initial.processes.length === 0) {
    return { ok: true, status: 'already-stopped', runnerId, target, residualRunner: 'stopped' };
  }
  if (initial.processes.length > 1) {
    return failure(
      'failed',
      runnerId,
      target,
      'unknown',
      `Refusing ambiguous graceful exit: found ${initial.processes.length} '${runnerId}' processes under ${target}`,
    );
  }

  const definition = getRunnerDefinition(runnerId);
  const sendTarget = initial.processes[0]!.paneTarget;
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
    const remaining = await runnerPids(options.vars, target, runnerId, deps);
    if ('error' in remaining) {
      return failure('failed', runnerId, target, 'unknown', remaining.error);
    }
    if (remaining.processes.length === 0) {
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
      requireLiveTarget: false,
    },
    { exec: deps.exec, findRunnerPid: deps.findRunnerPid },
  );
  const inspected = await inspection;
  const runnerId = inspected.runnerId;
  const target = handle.target.target;
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
    await deps.respawn(options.vars, target, command, { preserveWindowAfterExit: true });
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
      const running = await runnerPids(options.vars, target, runnerId, deps);
      if ('error' in running) {
        return reloadFailure('failed', runnerId, target, handle.sessionId, running.error);
      }
      if (running.processes.length > 0) {
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

async function runnerPids(
  vars: SlotVars,
  target: string,
  runnerId: string,
  deps: Pick<RunnerSessionLifecycleDeps, 'exec' | 'findRunnerPid'>,
): Promise<{ processes: Array<{ paneTarget: string; runnerPid: string }> } | { error: string }> {
  const panes = await deps.exec(
    vars,
    tmuxShellSnippet(
      `list-panes -t ${shellQuote(target)} -F '#{pane_id}\t#{pane_pid}' 2>/dev/null`,
    ),
    { timeout: 10_000 },
  );
  if (panes.exitCode !== 0) {
    return { error: panes.stderr || panes.stdout || `Cannot inspect tmux target ${target}` };
  }
  const processes: Array<{ paneTarget: string; runnerPid: string }> = [];
  for (const line of panes.stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [paneTarget, panePid] = line.split('\t', 2);
    if (!paneTarget || !panePid) continue;
    const runnerPid = await deps.findRunnerPid(vars, panePid, runnerId, { timeout: 10_000 });
    if (runnerPid) processes.push({ paneTarget, runnerPid });
  }
  return { processes };
}
