import type { Run } from '@farmslot/protocol';
import { buildComparisonVariant } from '@farmslot/protocol';

import { detectVariantCollision, isVariantInputBlocked } from './dispatch-wizard-helpers.js';
import type { ComparisonRunParams } from './dispatch-wizard-payload.js';

export interface ComparisonModeState {
  comparisonLane: boolean;
  comparisonFamilyId: string;
  comparisonParentRunId: string;
  comparisonVariant: string;
  variantCollision: boolean;
  variantInput: string;
}

export function exitedComparisonModeState(): ComparisonModeState {
  return {
    comparisonLane: false,
    comparisonFamilyId: '',
    comparisonParentRunId: '',
    comparisonVariant: '',
    variantCollision: false,
    variantInput: '',
  };
}

export function forkComparisonStateFromRun(
  run: Run,
  current: { runner: string; model: string },
  comparisonLaneRunners: ReadonlySet<string>,
): Pick<
  ComparisonModeState,
  'comparisonLane' | 'comparisonFamilyId' | 'comparisonParentRunId' | 'comparisonVariant'
> & {
  runner: string;
  model: string;
} {
  const runner = run.metrics?.runner;
  const model = run.metrics?.model;
  const prefillRunner = runner && comparisonLaneRunners.has(runner) ? runner : null;
  return {
    comparisonLane: true,
    comparisonFamilyId: run.familyId || run.id,
    comparisonParentRunId: run.id,
    comparisonVariant: '',
    runner: prefillRunner ?? current.runner,
    model: prefillRunner && model ? model : current.model,
  };
}

export function deriveComparisonVariantState(input: {
  comparisonLane: boolean;
  comparisonFamilyId: string;
  runs: readonly Run[];
  runner: string;
  model: string;
  variantInput: string;
}): Pick<ComparisonModeState, 'variantCollision' | 'variantInput'> {
  if (!input.comparisonLane || !input.comparisonFamilyId) {
    return { variantCollision: false, variantInput: '' };
  }
  const familyRuns = input.runs.filter((run) => run.familyId === input.comparisonFamilyId);
  const { collides, suggested } = detectVariantCollision(familyRuns, input.runner, input.model);
  return {
    variantCollision: collides,
    // When collision goes away, leave operator-supplied tags untouched so a stray
    // runner/model flip doesn't erase the input.
    variantInput: collides ? suggested : input.variantInput,
  };
}

export function comparisonVariantInputBlocked(input: {
  comparisonLane: boolean;
  comparisonFamilyId: string;
  runs: readonly Run[];
  variantInput: string;
  variantCollision: boolean;
}): boolean {
  if (!input.comparisonLane) return false;
  const familyRuns = input.runs.filter((run) => run.familyId === input.comparisonFamilyId);
  return isVariantInputBlocked(familyRuns, input.variantInput, input.variantCollision);
}

export function resolveComparisonVariant(
  variantInput: string,
  runner: string,
  model: string,
): string {
  const supplied = variantInput.trim();
  return supplied || buildComparisonVariant(runner, model);
}

export function buildComparisonRunParams(input: {
  comparisonLane: boolean;
  comparisonFamilyId: string;
  comparisonParentRunId: string;
  variant: string;
}): Partial<ComparisonRunParams> {
  if (!input.comparisonLane) return {};
  return {
    lane: 'comparison' as const,
    ...(input.comparisonFamilyId ? { familyId: input.comparisonFamilyId } : {}),
    variant: input.variant,
    ...(input.comparisonParentRunId ? { parentRunId: input.comparisonParentRunId } : {}),
  };
}
