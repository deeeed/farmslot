import { digestRecipeDocument, type ReviewAttempt } from '@farmslot/protocol';

/** Recovery can ingest the same saved result using admission or native-start clocks. */
export function sameReviewAttemptReceipt(left: ReviewAttempt, right: ReviewAttempt): boolean {
  const a = left.reviewSnapshot;
  const b = right.reviewSnapshot;
  if (
    !a?.diffPath ||
    !a.capturedAt ||
    !a.diffHash ||
    a.diffPath !== b?.diffPath ||
    a.capturedAt !== b.capturedAt ||
    a.diffHash !== b.diffHash ||
    a.headSha !== b.headSha ||
    !left.session?.sessionId ||
    left.session.sessionId !== right.session?.sessionId ||
    left.verdict !== right.verdict ||
    digestRecipeDocument(left.issues ?? []) !== digestRecipeDocument(right.issues ?? [])
  )
    return false;
  const starts = [Date.parse(left.startedAt ?? ''), Date.parse(right.startedAt ?? '')];
  const ends = [Date.parse(left.completedAt ?? ''), Date.parse(right.completedAt ?? '')];
  return [...starts, ...ends].every(Number.isFinite) && Math.max(...starts) <= Math.min(...ends);
}
