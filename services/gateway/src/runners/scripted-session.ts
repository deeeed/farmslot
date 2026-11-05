import { createHash } from 'node:crypto';
import path from 'node:path';

import { execOnSlot } from '../core/exec.js';
import { slotFileExists, slotReadFile, slotWriteFiles } from '../core/slot-io.js';
import { resolveExactTmuxWindowPane, shellQuote } from '../core/tmux.js';

import type { SlotVars } from './observability-types.js';
import { findRunnerDescendantPid } from './session-process.js';
import type {
  RetainedSessionDeliveryResult,
  RunnerSessionReactivationOptions,
} from './session-reactivation.js';

async function session(vars: SlotVars, target: string) {
  const pane = await resolveExactTmuxWindowPane(vars, target);
  if (!pane) return null;
  const directory = path.posix.join(vars.remoteRepo, '.agent', `scripted-${pane.paneId.slice(1)}`);
  const file = path.posix.join(directory, 'session.json');
  if (!(await slotFileExists(vars, file))) return null;
  const value: unknown = JSON.parse(await slotReadFile(vars, file));
  if (
    !value ||
    typeof value !== 'object' ||
    !('pid' in value) ||
    !('active' in value) ||
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    !('observedAt' in value) ||
    typeof value.observedAt !== 'number' ||
    typeof value.active !== 'boolean'
  )
    throw new Error('Invalid scripted session receipt');
  const livePid = await findRunnerDescendantPid(vars, pane.panePid, 'scripted');
  if (livePid !== String(value.pid)) return null;
  return {
    directory,
    active: value.active,
    observedAt: value.observedAt,
    acknowledged: 'acknowledged' in value && value.acknowledged === true,
    promptDigest: 'promptDigest' in value ? value.promptDigest : undefined,
  };
}

export async function deliverScriptedPrompt(
  options: RunnerSessionReactivationOptions,
): Promise<RetainedSessionDeliveryResult> {
  const current = await session(options.vars, options.target);
  if (!current || !options.taskDir)
    return {
      delivered: false,
      disposition: 'hold',
      retryable: false,
      reason: 'No scripted interactive session',
    };
  if (
    current.acknowledged &&
    current.promptDigest === createHash('sha256').update(options.prompt).digest('hex')
  )
    return { delivered: true, acknowledgement: 'structured' };
  if (!options.priorPromptSendAttempted) {
    await options.onPromptMutationStart?.();
    await slotWriteFiles(options.vars, current.directory, [
      {
        path: 'prompt.pending',
        content: Buffer.from(
          JSON.stringify({ prompt: options.prompt, taskDir: options.taskDir, sentAt: Date.now() }),
        ).toString('base64'),
        mode: 0o600,
      },
    ]);
    const result = await execOnSlot(
      options.vars,
      `mv -- ${shellQuote(path.posix.join(current.directory, 'prompt.pending'))} ${shellQuote(path.posix.join(current.directory, 'prompt.json'))}`,
      { noRetry: true, timeout: 2000 },
    );
    if (result.exitCode !== 0) throw new Error('Scripted prompt delivery failed');
  }
  // Receipt of a terminal task signal, rather than file delivery, acknowledges the prompt.
  return {
    delivered: false,
    disposition: 'hold',
    retryable: true,
    sendAttempted: true,
    reason: 'Scripted prompt queued; waiting for acknowledgement',
  };
}

export async function scriptedTurn(vars: SlotVars, target: string) {
  const current = await session(vars, target);
  return current
    ? {
        value: current.active ? ('active' as const) : ('idle' as const),
        source: 'signal' as const,
        confidence: 'high' as const,
        observedAt: current.observedAt,
      }
    : null;
}

export async function scriptedActivity(vars: SlotVars, target: string) {
  const current = await session(vars, target);
  return current
    ? {
        value: current.active ? ('tool-running' as const) : ('idle' as const),
        source: 'signal' as const,
        confidence: 'high' as const,
        observedAt: current.observedAt,
      }
    : null;
}
