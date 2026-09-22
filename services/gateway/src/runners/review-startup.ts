import path from 'node:path';

import type { Run, RunnerPromptAcceptance } from '@farmslot/protocol';

import { loadMachinePool, type SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

import { getRunnerObservability } from './registry.js';

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
  const pool = await loadMachinePool(workspace.machine);
  const vars: SlotVars = {
    slotId: `review-${workspace.workspaceId}`,
    machine: workspace.machine,
    platform: pool.platform,
    host: pool.host,
    sshUser: pool.ssh_user,
    osType: pool.os || 'darwin',
    claudePath: pool.claude_path || 'claude',
    codexPath: pool.codex_path || 'codex',
    cursorPath: pool.cursor_path || 'cursor-agent',
    grokPath: pool.grok_path || 'grok',
    opencodePath: pool.opencode_path || 'opencode',
    piPath: pool.pi_path,
    dispatchCmd: '',
    recycleCmd: '',
    repo: workspace.checkoutPath,
    remoteRepo: workspace.checkoutPath,
    session: context.target.session,
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: `${pool.ssh_user}@${pool.host}`,
    projectName: run.project,
    resourceVars: {},
  };
  const since = Date.parse(deliveryStartedAt);
  if (!Number.isFinite(since)) return null;
  const binding = await observability.getSessionBinding(vars, vars.session, since);
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
