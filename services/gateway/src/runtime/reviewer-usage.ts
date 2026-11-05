import type { Run, RunnerSessionUsage } from '@farmslot/protocol';

/** Keep the most complete verified total; a failed lookup never erases spent work. */
export function preferSessionUsage(
  previous: RunnerSessionUsage | undefined,
  next: RunnerSessionUsage,
): RunnerSessionUsage {
  if (
    !previous ||
    previous.runner !== next.runner ||
    previous.runnerSessionId !== next.runnerSessionId
  )
    return next;
  const verified = (usage: RunnerSessionUsage) => usage.source !== 'unavailable' && !usage.error;
  if (verified(previous) !== verified(next)) return verified(previous) ? previous : next;
  const before = previous.totalTokens ?? -1;
  const after = next.totalTokens ?? -1;
  if (before !== after) return before > after ? previous : next;
  return Date.parse(previous.measuredAt) >= Date.parse(next.measuredAt) ? previous : next;
}

/** Result rows retain presentation priority on equal receipts; no verdicts are synthesized. */
export function reviewerUsageReceipts(
  run: Run,
): Array<{ id: string; model: string | null; usage: RunnerSessionUsage }> {
  const candidates: Array<{ id: string; model: string | null; usage: RunnerSessionUsage }> = (
    run.engineState?.publishGate?.reviews ?? []
  ).flatMap((review) =>
    review.usage
      ? [
          {
            id: review.id,
            model: review.model ?? null,
            usage: {
              ...review.usage,
              runner: review.usage.runner ?? review.runner,
              runnerSessionId: review.usage.runnerSessionId ?? review.reviewerSessionId,
            },
          },
        ]
      : [],
  );
  for (const usage of run.sessionUsage ?? []) {
    if (usage.role === 'review')
      candidates.push({
        id: usage.contextIds?.[0] ?? usage.runnerSessionId ?? 'review',
        model: usage.model ?? null,
        usage,
      });
  }
  for (const context of run.agentContexts ?? []) {
    if (
      context.role !== 'review' ||
      !context.reviewId ||
      !context.nativeSession ||
      !context.usage ||
      context.usage.source !== 'runner-transcript' ||
      context.usage.runner !== context.runner ||
      context.usage.runnerSessionId !== context.runnerSessionId
    )
      continue;
    candidates.push({ id: context.id, model: context.model ?? null, usage: context.usage });
  }
  const receipts: typeof candidates = [];
  const indices = new Map<string, number>();
  for (const candidate of candidates) {
    const { usage } = candidate;
    if (usage.source === 'unavailable' || usage.error || !(Number(usage.totalTokens) > 0)) continue;
    const key =
      usage.runner && usage.runnerSessionId
        ? JSON.stringify([usage.runner, usage.runnerSessionId])
        : null;
    const index = key ? indices.get(key) : undefined;
    if (index === undefined) {
      if (key) indices.set(key, receipts.length);
      receipts.push(candidate);
    } else if (preferSessionUsage(receipts[index].usage, usage) === usage)
      receipts[index] = candidate;
  }
  return receipts;
}
