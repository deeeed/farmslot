/** Dispatch score penalty when a free slot needs idle-baseline reset before prepare. */
export const SLOT_STALE_BRANCH_SCORE_PENALTY = 50;

export function isDispatchScoreStale(score: number): boolean {
  return score >= SLOT_STALE_BRANCH_SCORE_PENALTY;
}