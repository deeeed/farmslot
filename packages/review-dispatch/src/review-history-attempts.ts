import type { ReviewHistoryRound } from './review-history.js';

/** A worker-fix acceptance receipt records no additional reviewer turn. */
export function isFixOnlyReviewReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('timeline' in value)) return false;
  if ('startedAt' in value && value.startedAt) return false;
  const timeline: unknown = value.timeline;
  return (
    Array.isArray(timeline) &&
    timeline.length > 0 &&
    timeline.every((entry: unknown) =>
      Boolean(entry && typeof entry === 'object' && 'kind' in entry && entry.kind === 'worker-fix'),
    )
  );
}

/** Failed launches precede the reviewer in the same round; completed verdicts never collapse. */
export function groupReviewHistoryAttempts(rows: ReviewHistoryRound[]): {
  rounds: ReviewHistoryRound[];
  fixReceipts: ReviewHistoryRound[];
} {
  const rounds: ReviewHistoryRound[] = [];
  const fixReceipts: ReviewHistoryRound[] = [];
  for (const row of rows) {
    const previous = rounds.at(-1);
    if (previous?.verdict === 'failed' && previous.loopNumber === row.loopNumber) {
      row.earlierAttempts = [
        ...previous.earlierAttempts,
        {
          key: previous.key,
          status: previous.verdict,
          runner: previous.runner,
          model: previous.model,
          failureReason: previous.failureReason ?? null,
          startedAt: previous.startedAt,
          durationMs: previous.durationMs,
        },
      ];
      if (previous.hasFix) fixReceipts.push(previous);
      rounds.pop();
    }
    rounds.push(row);
  }
  return { rounds, fixReceipts };
}
