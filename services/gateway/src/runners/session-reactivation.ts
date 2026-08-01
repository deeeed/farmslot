import type { SafetyTier } from '@farmslot/protocol';

import { type loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { respawnTmuxWindowWithCommand, shellQuote, tmuxShellSnippet } from '../core/tmux.js';

import {
  buildRunnerSessionReloadCommand,
  RUNNER_LAUNCH_READY_TIMEOUT_MS,
} from './launch-command.js';
import { writeRunnerPromptSentinel } from './observability-sentinel.js';
import { readLaunchAckSignalSnapshot } from './prompt-delivery-evidence.js';
import {
  getRunnerObservability,
  normalizeRunner,
  resolveSafeSendTimeoutMs,
  runnerHasDurablePromptHandoff,
  runnerRetainedSessionHandoff,
  type RunnerSendRecoveryContext,
  sendRunnerInstructionSafely,
  WORKER_ENV_PREFIX,
} from './registry.js';
import { resumableSessionProbeCommand } from './session-process.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;
const RUNNER_SESSION_ACCEPTANCE_POLL_MS = 2_000;

export interface RunnerSessionReactivationOptions {
  vars: SlotVars;
  target: string;
  runnerId: string;
  sessionId?: string | null;
  sessionPath?: string | null;
  model?: string | null;
  prompt: string;
  effort?: string | null;
  safetyTier?: SafetyTier;
  runtimeDir?: string;
  taskDir?: string;
  launchAckSignalPath?: string | null;
  timeoutMs?: number;
  recovery?: RunnerSendRecoveryContext;
  sendLogPrefix?: string;
  forceBusyPoll?: boolean;
}

export type RetainedSessionDeliveryResult =
  | { delivered: true; acknowledgement: 'structured' | 'safe-send' }
  | {
      delivered: false;
      disposition: 'safe-send' | 'hold';
      reason: string;
      retryable?: boolean;
    };

/**
 * Replace an idle retained TUI with a resumed instance that receives its next
 * task through the runner's argv contract. This avoids interpreting TUI glyphs
 * or mutating an unknown composer buffer with send-keys.
 */
async function reactivateRunnerSessionWithPrompt(
  options: RunnerSessionReactivationOptions & { sessionId: string },
): Promise<RetainedSessionDeliveryResult> {
  const runner = normalizeRunner(options.runnerId);
  if (runnerRetainedSessionHandoff(runner) !== 'resume-with-prompt') {
    return {
      delivered: false,
      disposition: 'safe-send',
      reason: `Runner '${runner}' does not support retained resume-with-prompt handoff`,
    };
  }
  const observability = getRunnerObservability(runner);
  if (!observability) {
    return {
      delivered: false,
      disposition: 'safe-send',
      reason: `Runner '${runner}' has no structured session-delivery provider`,
    };
  }
  let idleProven = false;
  let paneMutationStarted = false;
  try {
    const panes = await execOnSlot(
      options.vars,
      tmuxShellSnippet(`list-panes -t ${shellQuote(options.target)} -F '#{pane_id}'`),
    );
    if (panes.exitCode !== 0) {
      return {
        delivered: false,
        disposition: 'safe-send',
        reason: `Cannot inspect retained runner window ${options.target}: ${panes.stderr || panes.stdout || `exit ${panes.exitCode}`}`,
      };
    }
    const paneCount = panes.stdout.split('\n').filter((line) => line.trim()).length;
    if (paneCount !== 1) {
      return {
        delivered: false,
        disposition: 'hold',
        reason: `Retained runner window ${options.target} has ${paneCount} panes; refusing window-wide replacement`,
      };
    }

    const sessionPath = options.sessionPath?.trim();
    if (!sessionPath) {
      return {
        delivered: false,
        disposition: 'safe-send',
        reason: `Retained ${runner} session ${options.sessionId} has no resumable session path`,
      };
    }

    const state = await observability.getSessionDeliveryState(
      options.vars,
      options.target,
      options.sessionId,
      sessionPath,
    );
    if (state?.value !== 'idle' || state.confidence !== 'high') {
      return {
        delivered: false,
        disposition: 'safe-send',
        reason: `Retained ${runner} session ${options.sessionId} is ${state?.value ?? 'unknown'}; refusing to replace a session without terminal hook proof`,
      };
    }
    idleProven = true;

    const probe = await execOnSlot(options.vars, resumableSessionProbeCommand(sessionPath), {
      timeout: 10_000,
    });
    if (probe.exitCode !== 0) {
      return {
        delivered: false,
        disposition: 'safe-send',
        reason: `Retained ${runner} session path is unavailable: ${sessionPath}`,
      };
    }

    const launchAckBaseline = options.launchAckSignalPath
      ? await readLaunchAckSignalSnapshot(options.vars, options.launchAckSignalPath)
      : null;
    const launchAckUnavailable = Boolean(options.launchAckSignalPath && !launchAckBaseline);
    const sentinel = await writeRunnerPromptSentinel(options.vars, options.prompt);
    const command = `${WORKER_ENV_PREFIX} && ${buildRunnerSessionReloadCommand(
      options.vars,
      runner,
      options.model,
      options.sessionId,
      {
        effort: options.effort,
        safetyTier: options.safetyTier,
        runtimeDir:
          options.runtimeDir ?? (await resolveProjectRuntimeDir(options.vars.projectName)),
        taskDir: options.taskDir,
        initialPrompt: options.prompt,
      },
    )}`;
    paneMutationStarted = true;
    await respawnTmuxWindowWithCommand(options.vars, options.target, command);

    const deadline = Date.now() + (options.timeoutMs ?? RUNNER_LAUNCH_READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const accepted = await runnerHasDurablePromptHandoff(
        options.vars,
        options.target,
        runner,
        options.prompt,
        sentinel.sentAt - 500,
        {
          launchAckSignalPath: options.launchAckSignalPath,
          launchAckBaseline,
          promptAcceptanceBaselineMs: sentinel.sentAt - 500,
        },
      );
      if (accepted.accepted) return { delivered: true, acknowledgement: 'structured' };
      await new Promise((resolve) => setTimeout(resolve, RUNNER_SESSION_ACCEPTANCE_POLL_MS));
    }
    return {
      delivered: false,
      disposition: 'hold',
      reason: `Reloaded ${runner} session ${options.sessionId}, but no structured prompt or task-signal acknowledgement arrived${launchAckUnavailable ? '; the task-signal baseline was unavailable' : ''}`,
      retryable: false,
    };
  } catch (error) {
    return {
      delivered: false,
      disposition: idleProven && !paneMutationStarted ? 'safe-send' : 'hold',
      reason: `Retained ${runner} handoff failed: ${(error as Error).message}`,
      ...(paneMutationStarted ? { retryable: false } : {}),
    };
  }
}

/**
 * Deliver a task to a retained runner session through the runner's declared
 * protocol. Callers provide session facts; they never interpret runner UI.
 */
export async function deliverPromptToRetainedRunnerSession(
  options: RunnerSessionReactivationOptions,
): Promise<RetainedSessionDeliveryResult> {
  const runner = normalizeRunner(options.runnerId);
  const handoff = runnerRetainedSessionHandoff(runner);
  if (handoff === 'resume-with-prompt') {
    const sessionId = options.sessionId?.trim();
    if (!sessionId) {
      return {
        delivered: false,
        disposition: 'safe-send',
        reason: `Runner '${runner}' requires a persisted session id for retained handoff`,
      };
    }
    return reactivateRunnerSessionWithPrompt({ ...options, sessionId });
  }
  if (handoff === 'in-place') {
    try {
      const timeoutMs = options.timeoutMs ?? resolveSafeSendTimeoutMs(runner);
      const accepted = await sendRunnerInstructionSafely(
        options.vars,
        options.target,
        runner,
        options.prompt,
        options.sendLogPrefix ?? '[retained-handoff]',
        timeoutMs,
        {
          forceBusyPoll: options.forceBusyPoll ?? true,
          recovery: options.recovery,
        },
      );
      if (accepted) return { delivered: true, acknowledgement: 'safe-send' };
      return {
        delivered: false,
        disposition: 'hold',
        reason: `Live ${runner} retained handoff was not accepted; refusing a destructive fresh-dispatch fallback`,
        retryable: true,
      };
    } catch (error) {
      return {
        delivered: false,
        disposition: 'hold',
        reason: `Live ${runner} retained handoff failed: ${(error as Error).message}`,
      };
    }
  }
  return {
    delivered: false,
    disposition: 'safe-send',
    reason: `Runner '${runner}' does not support retained-session handoff`,
  };
}
