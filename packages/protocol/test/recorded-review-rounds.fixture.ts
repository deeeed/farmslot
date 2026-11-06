import type { Run } from '../src/contracts/runs.js';

/** Prior completed reviews in budget fixtures carry explicit verdict receipts. */
export function recordedReviewRounds(
  ids: string[],
): Pick<Run, 'reviewRoundAdmissions' | 'reviewRoundSettlements'> {
  const settlements: NonNullable<Run['reviewRoundSettlements']> = {};
  for (const id of ids)
    settlements[id] = {
      kind: 'verdict',
      reason: 'Recorded fixture reviewer verdict',
      at: '2026-10-12T00:00:00.000Z',
    };
  return { reviewRoundAdmissions: ids, reviewRoundSettlements: settlements };
}
