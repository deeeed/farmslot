import type { EvalBenchRollup, EvalBenchTrial } from '../contracts/eval-bench.js';

const SOLVED = new Set(['MATCHES-REF', 'ACCEPTABLE-ALT']);

export function evalBenchRollups(trials: readonly EvalBenchTrial[]): EvalBenchRollup[] {
  const groups = new Map<string, { row: EvalBenchRollup; cases: Set<string> }>();
  for (const trial of trials) {
    // Route and effort are part of an arm. Mixing them would hide a changed experiment.
    const key = JSON.stringify([trial.problemType, trial.modelId, trial.route, trial.effort]);
    let group = groups.get(key);
    if (!group) {
      group = {
        cases: new Set(),
        row: {
          problemType: trial.problemType,
          model: trial.model,
          modelId: trial.modelId,
          route: trial.route,
          effort: trial.effort,
          trials: 0,
          cases: 0,
          scored: 0,
          solved: 0,
          mergeable: 0,
          mergeabilityKnown: 0,
          unscored: 0,
          costUsd: 0,
          pricedTrials: 0,
          turns: 0,
          measuredTurnTrials: 0,
        },
      };
      groups.set(key, group);
    }
    const { row, cases } = group;
    row.trials++;
    cases.add(
      JSON.stringify([trial.dataset, trial.item, trial.reference.repo, trial.reference.head]),
    );
    const scored = !trial.unscored && !!trial.verdict && trial.verdict !== 'pending';
    if (scored) {
      row.scored++;
      if (SOLVED.has(trial.verdict!)) row.solved++;
      if (trial.mergeable && /^(yes|no)\b/i.test(trial.mergeable)) {
        row.mergeabilityKnown++;
        if (/^yes\b/i.test(trial.mergeable)) row.mergeable++;
      }
    } else row.unscored++;
    // Include spending on unsuccessful or cancelled trials; null is never free.
    if (trial.usage.costUsd !== null) {
      row.costUsd += trial.usage.costUsd;
      row.pricedTrials++;
    }
    if (trial.usage.turns !== null) {
      row.turns += trial.usage.turns;
      row.measuredTurnTrials++;
    }
  }
  return [...groups.values()]
    .map(({ row, cases }) => ({ ...row, cases: cases.size }))
    .sort(
      (a, b) =>
        a.problemType.localeCompare(b.problemType) ||
        a.model.localeCompare(b.model) ||
        a.route.localeCompare(b.route) ||
        a.effort.localeCompare(b.effort),
    );
}

export function evalBenchCostSaving(trial: EvalBenchTrial): number | null {
  const original = trial.original?.usage.costUsd;
  const candidate = trial.usage.costUsd;
  return original != null && original > 0 && candidate !== null
    ? (original - candidate) / original
    : null;
}
