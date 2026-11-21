import type { RunnerSessionUsage } from '../contracts/runs.js';

export function recordedSessionCost(usage: RunnerSessionUsage | undefined): number | null {
  return usage &&
    usage.source !== 'unavailable' &&
    !usage.error &&
    usage.costStatus !== 'unpriced' &&
    typeof usage.costUsd === 'number' &&
    Number.isFinite(usage.costUsd) &&
    usage.costUsd >= 0
    ? usage.costUsd
    : null;
}

/** Reconcile observations of one conversation without substituting another usage window. */
export function preferRunUsageReceipt(
  previous: RunnerSessionUsage,
  next: RunnerSessionUsage,
  preferredScope: 'run-delta' | 'session-total' = 'run-delta',
): RunnerSessionUsage {
  const measured = (usage: RunnerSessionUsage) => usage.source !== 'unavailable' && !usage.error;
  if (measured(previous) !== measured(next)) return measured(previous) ? previous : next;
  const previousScope = previous.scope ?? 'session-total';
  if (previousScope !== (next.scope ?? 'session-total'))
    return previousScope === preferredScope ? previous : next;
  const before = previous.totalTokens ?? -1;
  const after = next.totalTokens ?? -1;
  if (before >= 0 && after >= 0 && before !== after) return before > after ? previous : next;
  const repriced = (usage: RunnerSessionUsage) =>
    usage.pricingScope === 'remote-tmux-pi' && usage.source === 'runner-transcript' && !usage.error;
  const equivalentCapture =
    (before >= 0 && before === after) ||
    previous.measuredAt === next.measuredAt ||
    Boolean(
      previous.startedAt &&
      previous.completedAt &&
      previous.startedAt === next.startedAt &&
      previous.completedAt === next.completedAt,
    );
  if (equivalentCapture && repriced(previous) !== repriced(next))
    return repriced(previous) ? previous : next;
  if (before < 0 || after < 0 || before === after) {
    const pricedBefore = recordedSessionCost(previous) !== null;
    const pricedAfter = recordedSessionCost(next) !== null;
    if (pricedBefore !== pricedAfter) return pricedBefore ? previous : next;
  }
  if (before !== after) return before > after ? previous : next;
  return previous.measuredAt >= next.measuredAt ? previous : next;
}

/** Failed captures can recover only through their recorded window or sole review context. */
export function matchesFailedReviewUsageWindow(
  recorded: RunnerSessionUsage,
  recovered: RunnerSessionUsage,
  contextKey: string,
): boolean {
  if (
    (recorded.runId && recovered.runId && recorded.runId !== recovered.runId) ||
    (recorded.scope === 'run-delta' && recovered.scope !== 'run-delta') ||
    (recorded.startedAt && recorded.startedAt !== recovered.startedAt) ||
    (recorded.completedAt && recorded.completedAt !== recovered.completedAt)
  )
    return false;
  const leases = new Set(recorded.usageLeaseIds);
  const recoveredLeases = new Set(recovered.usageLeaseIds);
  if (leases.size)
    return (
      leases.size === recoveredLeases.size && [...leases].every((id) => recoveredLeases.has(id))
    );
  if (recorded.startedAt && recorded.completedAt) return true;
  return (
    recoveredLeases.size <= 1 &&
    recovered.contextIds?.length === 1 &&
    recovered.contextIds[0] === contextKey
  );
}
