import type { SafetyTier } from '@farmslot/protocol';

import { type loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  resolveTmuxPaneId,
  respawnTmuxWindowWithCommand,
  shellQuote,
  tmuxShellSnippet,
} from '../core/tmux.js';

import {
  buildRunnerSessionReloadCommand,
  RUNNER_LAUNCH_READY_TIMEOUT_MS,
} from './launch-command.js';
import { writeRunnerPromptSentinel } from './observability-sentinel.js';
import type { LaunchAckSignalSnapshot } from './prompt-delivery-evidence.js';
import {
  captureRunnerPromptAcceptanceBaseline,
  getRunnerObservability,
  normalizeRunner,
  resolveLaunchBlockerWithFreshEvidence,
  resolveSafeSendTimeoutMs,
  runnerHasDurablePromptHandoff,
  runnerRetainedSessionHandoff,
  type RunnerSendRecoveryContext,
  sendRunnerInstructionSafely,
  WORKER_ENV_PREFIX,
} from './registry.js';
import { buildRunnerObservabilityInstallCommand } from './runner-observability.js';
import { resolveRunnerSessionBinding, resumableSessionProbeCommand } from './session-process.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;
const RUNNER_SESSION_ACCEPTANCE_POLL_MS = 2_000;
const RUNNER_TURN_TOKEN_GRACE_MS = 2_000;

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
  launchAckBaseline?: LaunchAckSignalSnapshot | null;
  acceptExistingLaunchAck?: boolean;
  priorPromptSendAttempted?: boolean;
  timeoutMs?: number;
  recovery?: RunnerSendRecoveryContext;
  sendLogPrefix?: string;
  forceBusyPoll?: boolean;
}

export type RetainedSessionDeliveryResult =
  | { delivered: true; acknowledgement: 'structured' | 'safe-send'; turnToken?: string }
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
        disposition: 'safe-send',
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

    const runtimeDir =
      options.runtimeDir ?? (await resolveProjectRuntimeDir(options.vars.projectName));
    const promptSentinel = await writeRunnerPromptSentinel(options.vars, options.prompt);
    const promptAcceptanceBaselineMs = await captureRunnerPromptAcceptanceBaseline(
      options.vars,
      options.target,
      runner,
      promptSentinel.sentAt,
    );
    if (promptAcceptanceBaselineMs == null) {
      return {
        delivered: false,
        disposition: 'safe-send',
        reason: `Retained ${runner} prompt acceptance baseline is unavailable`,
      };
    }
    const command = `${WORKER_ENV_PREFIX} && ${buildRunnerSessionReloadCommand(
      options.vars,
      runner,
      options.model,
      options.sessionId,
      {
        effort: options.effort,
        safetyTier: options.safetyTier,
        runtimeDir,
        taskDir: options.taskDir,
        initialPrompt: options.prompt,
      },
    )}`;
    paneMutationStarted = true;
    await respawnTmuxWindowWithCommand(options.vars, options.target, command, {
      preserveWindowAfterExit: true,
    });
    let trustPromptConfirmed = false;
    let acknowledgedWithoutTurnTokenAt: number | null = null;

    const deadline = Date.now() + (options.timeoutMs ?? RUNNER_LAUNCH_READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const accepted = await runnerHasDurablePromptHandoff(
        options.vars,
        options.target,
        runner,
        options.prompt,
        promptAcceptanceBaselineMs,
        {
          requirePromptDigest: true,
          promptAcceptanceBaselineMs,
          retainedSession: { sessionId: options.sessionId, sessionPath },
        },
      );
      // Only exact post-respawn prompt evidence is accepted; generic activity,
      // task signals, and pane text cannot acknowledge this resumed prompt.
      if (
        accepted.accepted &&
        (accepted.turnToken || !getRunnerObservability(runner)?.getTurnState)
      ) {
        return {
          delivered: true,
          acknowledgement: 'structured',
          ...(accepted.turnToken ? { turnToken: accepted.turnToken } : {}),
        };
      }
      if (accepted.accepted) acknowledgedWithoutTurnTokenAt ??= Date.now();
      if (
        acknowledgedWithoutTurnTokenAt != null &&
        Date.now() - acknowledgedWithoutTurnTokenAt >= RUNNER_TURN_TOKEN_GRACE_MS
      ) {
        return { delivered: true, acknowledgement: 'structured' };
      }
      if (!trustPromptConfirmed) {
        const trustResult = await resolveLaunchBlockerWithFreshEvidence({
          runnerId: runner,
          target: options.target,
          logPrefix: 'retained-handoff',
          exec: (tmuxCommand) =>
            execOnSlot(options.vars, tmuxShellSnippet(tmuxCommand), options.vars.remoteRepo),
          refreshCodexHooks:
            runner === 'codex'
              ? async () => {
                  const refreshed = await execOnSlot(
                    options.vars,
                    buildRunnerObservabilityInstallCommand(
                      options.vars,
                      runner,
                      options.vars.remoteRepo,
                      runtimeDir,
                    ),
                  );
                  if (refreshed.exitCode !== 0) {
                    throw new Error(
                      `Failed to refresh trusted Codex hooks: ${refreshed.stderr || refreshed.stdout || `exit ${refreshed.exitCode}`}`,
                    );
                  }
                }
              : undefined,
          logNoFreshEvidence: false,
        });
        trustPromptConfirmed = trustResult.outcome === 'sent';
      }
      await new Promise((resolve) => setTimeout(resolve, RUNNER_SESSION_ACCEPTANCE_POLL_MS));
    }
    if (acknowledgedWithoutTurnTokenAt != null) {
      return { delivered: true, acknowledgement: 'structured' };
    }
    return {
      delivered: false,
      disposition: 'hold',
      reason: `Reloaded ${runner} session ${options.sessionId}, but no exact structured prompt acknowledgement arrived`,
      retryable: false,
    };
  } catch (error) {
    return {
      delivered: false,
      disposition: paneMutationStarted ? 'hold' : 'safe-send',
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
    return deliverPromptInPlace(options);
  }
  return {
    delivered: false,
    disposition: 'safe-send',
    reason: `Runner '${runner}' does not support retained-session handoff`,
  };
}

/** Deliver through the shared non-destructive in-place runner contract. */
export async function deliverPromptInPlace(
  options: RunnerSessionReactivationOptions,
): Promise<RetainedSessionDeliveryResult> {
  const runner = normalizeRunner(options.runnerId);
  try {
    const delayedAcknowledgement = await probeDelayedPromptAcknowledgement(options);
    if (delayedAcknowledgement) return delayedAcknowledgement;
    if (options.priorPromptSendAttempted) {
      return unacknowledgedPriorSendHold(runner);
    }
    const timeoutMs = options.timeoutMs ?? resolveSafeSendTimeoutMs(runner);
    const sentAtMs = Date.now();
    const promptAcceptanceBaselineMs = await captureRunnerPromptAcceptanceBaseline(
      options.vars,
      options.target,
      runner,
      sentAtMs,
    );
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
        ...(options.sessionId && options.sessionPath
          ? {
              retainedSession: {
                sessionId: options.sessionId,
                sessionPath: options.sessionPath,
              },
            }
          : {}),
      },
    );
    if (accepted && options.launchAckSignalPath) {
      // Pane-only runners have no exact prompt hook/native acknowledgement.
      // Probe the generic task signal once, then preserve the runner-specific
      // safe-send result instead of waiting for a capability they do not expose.
      const observability = getRunnerObservability(runner);
      if (!observability) {
        const acknowledgement = await runnerHasDurablePromptHandoff(
          options.vars,
          options.target,
          runner,
          options.prompt,
          sentAtMs,
          {
            launchAckSignalPath: options.launchAckSignalPath,
            launchAckBaseline: options.launchAckBaseline,
            requirePromptDigest: true,
            acceptExistingLaunchAck: options.acceptExistingLaunchAck,
            promptAcceptanceBaselineMs,
            ...(options.sessionId && options.sessionPath
              ? {
                  retainedSession: {
                    sessionId: options.sessionId,
                    sessionPath: options.sessionPath,
                  },
                }
              : {}),
          },
        );
        return acknowledgement.accepted
          ? {
              delivered: true,
              acknowledgement: 'structured',
              ...(acknowledgement.turnToken ? { turnToken: acknowledgement.turnToken } : {}),
            }
          : { delivered: true, acknowledgement: 'safe-send' };
      }
      const acknowledgementDeadline = Date.now() + Math.min(timeoutMs, 30_000);
      let acknowledgedWithoutTurnTokenAt: number | null = null;
      while (Date.now() < acknowledgementDeadline) {
        const acknowledgement = await runnerHasDurablePromptHandoff(
          options.vars,
          options.target,
          runner,
          options.prompt,
          sentAtMs,
          {
            launchAckSignalPath: options.launchAckSignalPath,
            launchAckBaseline: options.launchAckBaseline,
            requirePromptDigest: true,
            acceptExistingLaunchAck: options.acceptExistingLaunchAck,
            promptAcceptanceBaselineMs,
            ...(options.sessionId && options.sessionPath
              ? {
                  retainedSession: {
                    sessionId: options.sessionId,
                    sessionPath: options.sessionPath,
                  },
                }
              : {}),
          },
        );
        if (acknowledgement.accepted) {
          if (acknowledgement.turnToken || !observability.getTurnState) {
            return {
              delivered: true,
              acknowledgement: 'structured',
              ...(acknowledgement.turnToken ? { turnToken: acknowledgement.turnToken } : {}),
            };
          }
          acknowledgedWithoutTurnTokenAt ??= Date.now();
          if (Date.now() - acknowledgedWithoutTurnTokenAt >= RUNNER_TURN_TOKEN_GRACE_MS) {
            return { delivered: true, acknowledgement: 'structured' };
          }
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(
              0,
              Math.min(RUNNER_SESSION_ACCEPTANCE_POLL_MS, acknowledgementDeadline - Date.now()),
            ),
          ),
        );
      }
      if (acknowledgedWithoutTurnTokenAt != null) {
        return { delivered: true, acknowledgement: 'structured' };
      }
      return {
        delivered: false,
        disposition: 'hold',
        reason: `Live ${runner} retained handoff was sent, but the task signal or exact prompt hook did not acknowledge it`,
        retryable: false,
      };
    }
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

async function probeDelayedPromptAcknowledgement(
  options: RunnerSessionReactivationOptions,
): Promise<RetainedSessionDeliveryResult | null> {
  if (!options.priorPromptSendAttempted) return null;
  const acknowledgement = await runnerHasDurablePromptHandoff(
    options.vars,
    options.target,
    normalizeRunner(options.runnerId),
    options.prompt,
    // The prompt contains the task-scoped path, so its digest is the durable
    // recovery identity. Unlike gateway timestamps, it is safe across node
    // clock skew and proves whether the lost in-memory send already happened.
    0,
    {
      launchAckSignalPath: options.launchAckSignalPath,
      launchAckBaseline: options.launchAckBaseline,
      acceptExistingLaunchAck: false,
      requirePromptDigest: true,
      promptAcceptanceBaselineMs: 0,
      ...(options.sessionId && options.sessionPath
        ? {
            retainedSession: {
              sessionId: options.sessionId,
              sessionPath: options.sessionPath,
            },
          }
        : {}),
    },
  );
  return acknowledgement.accepted
    ? {
        delivered: true,
        acknowledgement: 'structured',
        ...(acknowledgement.turnToken ? { turnToken: acknowledgement.turnToken } : {}),
      }
    : null;
}

function unacknowledgedPriorSendHold(runner: string): RetainedSessionDeliveryResult {
  return {
    delivered: false,
    disposition: 'hold',
    reason: `A prior ${runner} retained handoff send was recorded, but no exact prompt acknowledgement is available; refusing duplicate delivery`,
    retryable: false,
  };
}

/** Prefer native retained resume, then use the shared non-destructive in-place contract. */
export async function deliverPromptWithRetainedFallback(
  options: RunnerSessionReactivationOptions,
): Promise<RetainedSessionDeliveryResult> {
  let resolvedOptions = options;
  try {
    const delayedAcknowledgement = await probeDelayedPromptAcknowledgement(options);
    if (delayedAcknowledgement) return delayedAcknowledgement;
    if (options.priorPromptSendAttempted) {
      return unacknowledgedPriorSendHold(normalizeRunner(options.runnerId));
    }
  } catch (error) {
    return {
      delivered: false,
      disposition: 'hold',
      reason: `Delayed retained handoff acknowledgement probe failed: ${(error as Error).message}`,
    };
  }

  const runner = normalizeRunner(options.runnerId);
  if (
    runnerRetainedSessionHandoff(runner) === 'resume-with-prompt' &&
    (!options.sessionId?.trim() || !options.sessionPath?.trim())
  ) {
    try {
      const paneId = await resolveTmuxPaneId(options.vars, options.target);
      const binding = paneId
        ? await resolveRunnerSessionBinding(options.vars, runner, [], {
            paneId,
            slotId: options.vars.slotId,
          })
        : null;
      if (binding) {
        resolvedOptions = {
          ...options,
          sessionId: binding.runnerSessionId,
          sessionPath: binding.runnerSessionPath,
        };
      }
    } catch (error) {
      // Binding enrichment is optional; retain the caller's persisted identity
      // and let the standard native/in-place delivery contract decide safely.
      console.warn(
        `[retained-handoff] failed to enrich runner session binding for ${options.target}: ${(error as Error).message}`,
      );
    }
  }
  const retained = await deliverPromptToRetainedRunnerSession(resolvedOptions);
  if (!retained.delivered && retained.disposition === 'safe-send') {
    return deliverPromptInPlace(resolvedOptions);
  }
  return retained;
}
