import { type LearningCurationContext, setLearningEvaluatorForTest } from './learning-curation.js';
import { setLearningContextLoaderForTest } from './learning-curation-context.js';

export function curationFixture(runId = 'source-run'): LearningCurationContext {
  return {
    runId,
    library: [
      { runId: '', path: 'review/antipatterns.md', text: '# Existing rules\nUnrelated rule.' },
    ],
    evidence: [
      {
        runId,
        path: 'artifacts/review-result.json',
        actor: 'reviewer',
        confirms: 'independent-review',
        text: 'Confirmed source failure.\nFix accepted by the reviewer.',
      },
      {
        runId: 'other-run',
        path: 'artifacts/review-result.json',
        actor: 'reviewer',
        confirms: 'independent-review',
        text: 'Same failure reproduced independently.',
      },
    ],
  };
}
export function keptCuration(context: LearningCurationContext) {
  const source = context.evidence[0]!;
  const other = context.evidence[1]!;
  return {
    outcome: 'keep',
    reason: 'Confirmed recurring failure with no existing coverage',
    instruction: 'Inspect the affected caller and verify the confirmed invariant.',
    observed: [
      { runId: source.runId, path: source.path, line: 1, quote: source.text.split('\n')[0] },
      { runId: other.runId, path: other.path, line: 1, quote: other.text },
    ],
    confirmation: [
      { runId: source.runId, path: source.path, line: 2, quote: source.text.split('\n')[1] },
    ],
    coverage: 'new',
    rule: null,
    gap: null,
    moneyOrderBlocker: null,
  };
}
export function installCurationFixture(): () => void {
  setLearningContextLoaderForTest(async (_project, _destination, runId) => curationFixture(runId));
  setLearningEvaluatorForTest(async (entries, context) => entries.map(() => keptCuration(context)));
  return () => {
    setLearningEvaluatorForTest();
    setLearningContextLoaderForTest();
  };
}
