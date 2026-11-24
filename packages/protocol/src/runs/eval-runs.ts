import type { Run } from '../contracts/runs.js';

type EvalRunInput = Partial<Pick<Run, 'lane'>>;

/**
 * Eval and comparison runs: the comparison lane, which every eval experiment also runs in.
 * Command Center and Companion mark, order and hide eval runs through this one predicate.
 */
export function isEvalRun(run: EvalRunInput): boolean {
  return run.lane === 'comparison';
}

/**
 * The eval marker for a run row or run header, with the compared variant. When the flow label
 * already reads EVAL (eval candidates), the marker names only the variant.
 */
export function evalRunBadge(
  run: EvalRunInput & { variant?: string | null },
  flowSaysEval = false,
): { label: string; title: string } | null {
  if (!isEvalRun(run)) return null;
  const variant = run.variant?.trim();
  if (!variant)
    return flowSaysEval ? null : { label: 'EVAL', title: 'Evaluation run (comparison lane)' };
  return {
    label: flowSaysEval ? variant : `EVAL · ${variant}`,
    title: `Evaluation run (comparison lane), variant ${variant}`,
  };
}

/** Product runs keep their order ahead of eval runs, which keep theirs. */
export function productRunsFirst<R extends EvalRunInput>(runs: readonly R[]): R[] {
  return [...runs.filter((run) => !isEvalRun(run)), ...runs.filter(isEvalRun)];
}

/** Grouped lists keep the same rule: a family of only eval runs lists after product families. */
export function productFamiliesFirst<G extends { runs: readonly EvalRunInput[] }>(
  groups: readonly G[],
): G[] {
  const evalFamily = (group: G) => group.runs.every(isEvalRun);
  return [...groups.filter((group) => !evalFamily(group)), ...groups.filter(evalFamily)];
}
