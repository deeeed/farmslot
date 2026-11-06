export { recordedReviewRounds } from '../../../../packages/protocol/test/recorded-review-rounds.fixture.js';

export async function recordedReviewRound(runId: string, id: string): Promise<void> {
  const { admitReviewRound, recordReviewRoundVerdict } = await import('./review-round-budget.js');
  await admitReviewRound(runId, id);
  await recordReviewRoundVerdict(runId, id);
}
