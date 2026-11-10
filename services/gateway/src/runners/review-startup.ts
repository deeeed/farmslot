import path from 'node:path';

import type { Run, RunnerPromptAcceptance } from '@farmslot/protocol';

import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

import { getRunnerObservability } from './registry.js';
import { reviewWorkspaceRunnerVars } from './review-workspace-context.js';
export { reviewWorkspaceRunnerVars } from './review-workspace-context.js';

/** Reuse the runner protocol used by slot delivery, with the exact review cwd. */
export async function observeReviewPromptAcceptance(
  run: Run,
): Promise<RunnerPromptAcceptance | null> {
  assertNativeRunOwner(run);
  const workspace = run.reviewWorkspace;
  const context = run.agentContexts?.find((entry) => entry.id === 'review');
  const deliveryStartedAt = context?.promptDeliveryStartedAt;
  if (!workspace || !deliveryStartedAt || !context.target?.session) return null;
  if (
    context.promptAcceptance?.deliveryStartedAt === deliveryStartedAt &&
    context.promptAcceptance.runner === run.metrics.runner
  )
    return context.promptAcceptance;
  const observability = getRunnerObservability(run.metrics.runner);
  if (!observability?.getSessionBinding || !observability.promptAcceptedInSession) return null;
  const vars = await reviewWorkspaceRunnerVars(run);
  if (!vars) return null;
  const since = Date.parse(deliveryStartedAt);
  if (!Number.isFinite(since)) return null;
  // A retained conversation may have been created in the prior owned checkout.
  // Verify the new prompt against its exact file rather than selecting by the new cwd.
  const binding =
    context.runnerSessionId && context.runnerSessionPath
      ? { sessionId: context.runnerSessionId, sessionPath: context.runnerSessionPath }
      : await observability.getSessionBinding(vars, vars.session, since);
  if (!binding) return null;
  const prompt = await execOnSlot(
    vars,
    `cat ${shellQuote(path.posix.join(workspace.taskPath, '.terminal-prompt.txt'))}`,
    { timeout: 10000 },
  );
  if (prompt.exitCode !== 0) throw new Error('Review launch prompt unavailable');
  const reading = await observability.promptAcceptedInSession(
    vars,
    vars.session,
    binding.sessionId,
    binding.sessionPath,
    prompt.stdout,
    since,
  );
  if (reading?.value !== true || !reading.exactPromptMatch) return null;
  return {
    runner: run.metrics.runner!,
    deliveryStartedAt,
    ...binding,
    observedAt: reading.observedAt,
    ...(reading.turnToken ? { turnToken: reading.turnToken } : {}),
  };
}
