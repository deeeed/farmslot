import type { SafetyTier } from '@farmslot/protocol';

import { type loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { respawnTmuxWindowWithCommand } from '../core/tmux.js';

import { buildRunnerSessionReloadCommand } from './launch-command.js';
import { writeRunnerPromptSentinel } from './observability-sentinel.js';
import {
  getRunnerObservability,
  normalizeRunner,
  resolveSafeSendTimeoutMs,
  runnerRetainedSessionHandoff,
  type RunnerSendRecoveryContext,
  sendRunnerInstructionSafely,
  WORKER_ENV_PREFIX,
} from './registry.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export interface RunnerSessionReactivationOptions {
  vars: SlotVars;
  target: string;
  runnerId: string;
  sessionId?: string | null;
  model?: string | null;
  prompt: string;
  effort?: string | null;
  safetyTier?: SafetyTier;
  runtimeDir?: string;
  taskDir?: string;
  timeoutMs?: number;
  recovery?: RunnerSendRecoveryContext;
}

/**
 * Replace an idle retained TUI with a resumed instance that receives its next
 * task through the runner's argv contract. This avoids interpreting TUI glyphs
 * or mutating an unknown composer buffer with send-keys.
 */
async function reactivateRunnerSessionWithPrompt(
  options: RunnerSessionReactivationOptions & { sessionId: string },
): Promise<void> {
  const runner = normalizeRunner(options.runnerId);
  if (runnerRetainedSessionHandoff(runner) !== 'resume-with-prompt') {
    throw new Error(`Runner '${runner}' does not support retained resume-with-prompt handoff`);
  }
  const observability = getRunnerObservability(runner);
  if (!observability) {
    throw new Error(`Runner '${runner}' has no structured session-delivery provider`);
  }
  const state = await observability.getSessionDeliveryState(
    options.vars,
    options.target,
    options.sessionId,
  );
  if (state?.value !== 'idle' || state.confidence !== 'high') {
    throw new Error(
      `Retained ${runner} session ${options.sessionId} is ${state?.value ?? 'unknown'}; refusing to replace a session without terminal hook proof`,
    );
  }

  const sentinel = await writeRunnerPromptSentinel(options.vars, options.prompt);
  const command = `${WORKER_ENV_PREFIX} && ${buildRunnerSessionReloadCommand(
    options.vars,
    runner,
    options.model,
    options.sessionId,
    {
      effort: options.effort,
      safetyTier: options.safetyTier,
      runtimeDir: options.runtimeDir ?? (await resolveProjectRuntimeDir(options.vars.projectName)),
      taskDir: options.taskDir,
      initialPrompt: options.prompt,
    },
  )}`;
  await respawnTmuxWindowWithCommand(options.vars, options.target, command);

  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const accepted = await observability.promptAccepted(
      options.vars,
      options.target,
      sentinel.digest,
      sentinel.sentAt - 500,
      true,
    );
    if (accepted?.value === true && accepted.confidence === 'high') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Reloaded ${runner} session ${options.sessionId}, but no matching UserPromptSubmit hook arrived`,
  );
}

/**
 * Deliver a task to a retained runner session through the runner's declared
 * protocol. Callers provide session facts; they never interpret runner UI.
 */
export async function deliverPromptToRetainedRunnerSession(
  options: RunnerSessionReactivationOptions,
): Promise<void> {
  const runner = normalizeRunner(options.runnerId);
  const handoff = runnerRetainedSessionHandoff(runner);
  if (handoff === 'resume-with-prompt') {
    const sessionId = options.sessionId?.trim();
    if (!sessionId) {
      throw new Error(`Runner '${runner}' requires a persisted session id for retained handoff`);
    }
    await reactivateRunnerSessionWithPrompt({ ...options, sessionId });
    return;
  }
  if (handoff === 'in-place') {
    const timeoutMs = options.timeoutMs ?? resolveSafeSendTimeoutMs(runner);
    const accepted = await sendRunnerInstructionSafely(
      options.vars,
      options.target,
      runner,
      options.prompt,
      '[retained-handoff]',
      timeoutMs,
      { forceBusyPoll: true, recovery: options.recovery },
    );
    if (!accepted) {
      throw new Error(
        `Live ${runner} retained handoff was not accepted; refusing a destructive fresh-dispatch fallback`,
      );
    }
    return;
  }
  throw new Error(`Runner '${runner}' does not support retained-session handoff`);
}
