import type { AgentContext, Run } from '@farmslot/protocol';

import { upsertAgentContext } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';

import type { SlotVars } from './observability-types.js';
import { getRunnerObservability } from './registry.js';
import { reviewWorkspaceExecutionVars } from './review-workspace-context.js';

/** Record the adapter's request decision on the exact attempt whose progress is being read. */
export async function captureRunnerReasoningReceipt(
  run: Run,
  context: AgentContext | null | undefined,
  vars?: SlotVars,
): Promise<void> {
  if (!context?.runnerSessionId || !context.runnerSessionPath || !context.model) return;
  const attemptStartedAt = context.attemptStartedAt ?? context.startedAt ?? run.createdAt;
  const captured = context.reasoningReceipt;
  if (
    captured?.sessionId === context.runnerSessionId &&
    captured.selectedModel === context.model &&
    captured.attemptStartedAt === attemptStartedAt
  )
    return;
  const runner = context.runner ?? run.metrics.runner;
  if (!runner) return;
  const read = getRunnerObservability(runner)?.getReasoningReceipt;
  if (!read) return;
  const expected = {
    sessionId: context.runnerSessionId,
    sessionPath: context.runnerSessionPath,
    model: context.model,
    attemptStartedAt,
  };
  vars ??= run.reviewWorkspace
    ? ((await reviewWorkspaceExecutionVars(run)) ?? undefined)
    : run.slotId
      ? await loadSlotVars(run.slotId)
      : undefined;
  if (!vars) return;
  const receipt = await read(vars, {
    ...expected,
    since: Date.parse(attemptStartedAt),
  });
  if (
    !receipt ||
    receipt.sessionId !== expected.sessionId ||
    receipt.selectedModel !== expected.model ||
    JSON.stringify(receipt) === JSON.stringify(context.reasoningReceipt)
  )
    return;
  // The remote read can overlap a relaunch or context transfer.
  await upsertAgentContext(
    run.id,
    context.role,
    { id: context.id },
    {
      resolvePatch: (latest) =>
        latest?.runnerSessionId === expected.sessionId &&
        latest.runnerSessionPath === expected.sessionPath &&
        latest.model === expected.model &&
        (latest.attemptStartedAt ?? latest.startedAt ?? run.createdAt) === expected.attemptStartedAt
          ? { reasoningReceipt: { ...receipt, attemptStartedAt } }
          : null,
    },
  );
}
