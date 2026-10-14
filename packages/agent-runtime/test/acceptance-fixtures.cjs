// Synthetic engine projections for contract tests, never runtime verdict writers.
function engineClaims(criteria, verdicts = []) {
  return {
    schemaVersion: 2,
    recipeRunId: 'test-execution',
    recording: { status: 'not-required', segments: [] },
    criteria: criteria.map((text, index) => ({
      id: `AC-${index + 1}`,
      text,
      kind: 'acceptance',
      verdict: verdicts[index] ?? 'proven',
      proofMode: 'state',
      evidence: [],
      recipeNodes: ['assert-observation'],
      assertionIndices: [index],
      moments: [],
    })),
  };
}
module.exports = { engineClaims };
