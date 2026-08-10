// flow-usage-budget.ts — Per-flow turn/token soft budgets for mechanical runs.
// Pure helpers used by the run monitor to surface runaway update-branch (etc.)
// scope without hard-killing the worker.

import type { FlowType } from '@farmslot/protocol';

/** Project/config-facing budget thresholds (null/undefined = unset). */
export type FlowUsageBudget = {
  maxTurns?: number | null;
  maxTotalTokens?: number | null;
};

/** Live sample from runner session usage extraction. */
export type UsageBudgetSample = {
  turns?: number | null;
  totalTokens?: number | null;
};

export type UsageBudgetEvaluation =
  | { exceeded: false }
  | {
      exceeded: true;
      reasons: string[];
      turns: number | null;
      totalTokens: number | null;
      maxTurns: number | null;
      maxTotalTokens: number | null;
    };

/**
 * Built-in soft budgets for near-mechanical flows.
 *
 * Retro 2026-08-07: update-branch run 02866fe6 burned 507 turns / 117M tokens;
 * the flow should stay checklist-sized. Defaults are generous enough for real
 * conflict resolution but catch 100M+ silent burns.
 */
export const FLOW_USAGE_BUDGET_DEFAULTS: Partial<
  Record<FlowType, { maxTurns: number; maxTotalTokens: number }>
> = {
  'update-branch': { maxTurns: 80, maxTotalTokens: 8_000_000 },
};

export function hasUsageBudget(budget: FlowUsageBudget): boolean {
  return (
    (typeof budget.maxTurns === 'number' && budget.maxTurns > 0) ||
    (typeof budget.maxTotalTokens === 'number' && budget.maxTotalTokens > 0)
  );
}

/**
 * Pure evaluation: when a sample metric is unavailable (`null`/`undefined`),
 * that dimension is skipped (fail-open). Only positive configured ceilings count.
 */
export function evaluateFlowUsageBudget(
  sample: UsageBudgetSample,
  budget: FlowUsageBudget,
): UsageBudgetEvaluation {
  if (!hasUsageBudget(budget)) return { exceeded: false };

  const turns = typeof sample.turns === 'number' && Number.isFinite(sample.turns) ? sample.turns : null;
  const totalTokens =
    typeof sample.totalTokens === 'number' && Number.isFinite(sample.totalTokens)
      ? sample.totalTokens
      : null;
  const maxTurns =
    typeof budget.maxTurns === 'number' && budget.maxTurns > 0 ? budget.maxTurns : null;
  const maxTotalTokens =
    typeof budget.maxTotalTokens === 'number' && budget.maxTotalTokens > 0
      ? budget.maxTotalTokens
      : null;

  const reasons: string[] = [];
  if (maxTurns != null && turns != null && turns > maxTurns) {
    reasons.push(`turns ${turns} > max_turns ${maxTurns}`);
  }
  if (maxTotalTokens != null && totalTokens != null && totalTokens > maxTotalTokens) {
    reasons.push(`total_tokens ${totalTokens} > max_total_tokens ${maxTotalTokens}`);
  }

  if (reasons.length === 0) return { exceeded: false };
  return {
    exceeded: true,
    reasons,
    turns,
    totalTokens,
    maxTurns,
    maxTotalTokens,
  };
}

export function formatUsageBudgetMessage(
  flowType: string | undefined,
  evaluation: Extract<UsageBudgetEvaluation, { exceeded: true }>,
): string {
  const flow = flowType ?? 'run';
  return (
    `${flow} usage budget exceeded (${evaluation.reasons.join('; ')}). ` +
    'This flow should stay near-mechanical — finish the checklist, stop expanding scope, ' +
    'and signal complete or blocked.'
  );
}

/** Budget-nudge body delivered into the worker pane (warn-once). */
export function buildUsageBudgetNudgeMessage(message: string): string {
  return (
    `[Orchestrator] USAGE BUDGET WARNING: ${message} ` +
    'Do not start new workstreams. Complete or block the current checklist item and run the appropriate mark terminal command.'
  );
}

/**
 * Soft ceilings apply to per-run growth, not retained parent-session totals.
 * First successful sample only captures a baseline (warm handoff or cold start);
 * later samples evaluate delta = current - baseline.
 */
export function applyBudgetUsageBaseline(input: {
  turns: number | null;
  totalTokens: number | null;
  baselineCaptured?: boolean;
  baselineTurns?: number;
  baselineTotalTokens?: number;
}): {
  /** Turns counted toward the soft ceiling (null if unavailable). */
  chargeTurns: number | null;
  chargeTotalTokens: number | null;
  /** True when this sample only established the baseline (no charge yet). */
  establishingBaseline: boolean;
  baselineCaptured: boolean;
  baselineTurns: number;
  baselineTotalTokens: number;
} {
  if (input.turns == null && input.totalTokens == null) {
    return {
      chargeTurns: null,
      chargeTotalTokens: null,
      establishingBaseline: false,
      baselineCaptured: input.baselineCaptured === true,
      baselineTurns: input.baselineTurns ?? 0,
      baselineTotalTokens: input.baselineTotalTokens ?? 0,
    };
  }

  if (!input.baselineCaptured) {
    return {
      chargeTurns: 0,
      chargeTotalTokens: 0,
      establishingBaseline: true,
      baselineCaptured: true,
      baselineTurns: input.turns ?? 0,
      baselineTotalTokens: input.totalTokens ?? 0,
    };
  }

  const baseTurns = input.baselineTurns ?? 0;
  const baseTokens = input.baselineTotalTokens ?? 0;
  return {
    chargeTurns: input.turns != null ? Math.max(0, input.turns - baseTurns) : null,
    chargeTotalTokens:
      input.totalTokens != null ? Math.max(0, input.totalTokens - baseTokens) : null,
    establishingBaseline: false,
    baselineCaptured: true,
    baselineTurns: baseTurns,
    baselineTotalTokens: baseTokens,
  };
}
