import { PipelineSteps as PS, type Run } from '../contracts/runs.js';

/** Resolved slot binding for display and replay — top-level slotId, then agent context, then find-slot. */
export function resolveRunSlotId(
  run: Pick<Run, 'slotId' | 'steps' | 'agentContexts'>,
): string | null {
  const topLevel = run.slotId?.trim();
  if (topLevel) return topLevel;

  const preferredRoles = ['self-review-fix', 'self-review', 'dev'] as const;
  for (const role of preferredRoles) {
    const context = run.agentContexts
      ?.slice()
      .reverse()
      .find((candidate) => candidate.role === role && candidate.slotId?.trim());
    if (context?.slotId?.trim()) return context.slotId.trim();
  }

  const anyContext = run.agentContexts?.find((candidate) => candidate.slotId?.trim());
  if (anyContext?.slotId?.trim()) return anyContext.slotId.trim();

  const findSlot = run.steps.find((step) => step.name === PS.FIND_SLOT);
  const selectedSlot = (
    findSlot?.outputs as { selectedSlot?: string } | undefined
  )?.selectedSlot?.trim();
  return selectedSlot || null;
}
