import {
  type FamilyObservabilityTokenModelBreakdown,
  type FamilyObservabilityTokenRunPoint,
  type FamilyObservabilityTokenSummary,
  type FlowType,
  type Run,
} from '@farmslot/protocol';

import {
  isHelperSession,
  isReviewSession,
  runSessionUsageReceipts,
  sessionUsageContributions,
} from '../runtime/session-usage-selection.js';

const MILESTONE_FLOWS: ReadonlySet<FlowType> = new Set(['pr-complete', 'update-branch']);

function num(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface TokenParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

function emptyParts(): TokenParts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}

function mergeParts(base: TokenParts, extra: TokenParts): TokenParts {
  return {
    input: base.input + extra.input,
    output: base.output + extra.output,
    cacheRead: base.cacheRead + extra.cacheRead,
    cacheCreation: base.cacheCreation + extra.cacheCreation,
    total: base.total + extra.total,
  };
}

function workerModel(run: Run): string | null {
  return run.metrics.actualModel ?? run.metrics.model ?? null;
}

function runLabel(run: Run): string {
  if (run.variant?.trim()) return run.variant.trim();
  const runner = run.metrics.runner ?? 'runner';
  const model = run.metrics.model ?? 'model';
  return `${runner}-${model}`;
}

function hasRunMetrics(run: Run, worker: TokenParts, review: TokenParts): boolean {
  return (
    worker.total > 0 ||
    review.total > 0 ||
    run.metrics.costEstimate != null ||
    run.metrics.sessionTurns != null ||
    run.metrics.sessionInputTokens != null ||
    run.metrics.sessionOutputTokens != null
  );
}

function sortRunsChronologically(runs: readonly Run[]): Run[] {
  return [...runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function milestonePoints(
  points: FamilyObservabilityTokenRunPoint[],
  familyId: string,
): FamilyObservabilityTokenRunPoint[] {
  let milestoneIndex = 0;
  return points
    .filter((point) => MILESTONE_FLOWS.has(point.flowType as FlowType) || point.runId === familyId)
    .map((point) => {
      if (MILESTONE_FLOWS.has(point.flowType as FlowType)) {
        milestoneIndex += 1;
        return { ...point, label: `${point.flowType} #${milestoneIndex}` };
      }
      return { ...point, label: 'family root' };
    });
}

export function buildFamilyObservabilityTokenSummary(
  runs: readonly Run[],
  familyId: string,
): FamilyObservabilityTokenSummary {
  const ordered = sortRunsChronologically(runs);
  const sessionRows = sessionUsageContributions(ordered);
  let cumulativeTokens = 0;
  let cumulativeCost = 0;
  let hasAnyCost = false;
  let hasUnpriced = false;
  const unpricedModels = new Set<string>();
  let runsWithMetrics = 0;
  const missingRunIds: string[] = [];
  const byModelMap = new Map<
    string,
    FamilyObservabilityTokenModelBreakdown & { runIds: Set<string> }
  >();

  const addContribution = (
    runId: string,
    model: string | null,
    parts: TokenParts,
    costEstimate: number | null,
  ) => {
    if (parts.total <= 0 && costEstimate == null) return;
    const key = model ?? 'unknown';
    const current = byModelMap.get(key) ?? {
      model: key,
      runCount: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
      costEstimate: null as number | null,
      runIds: new Set<string>(),
    };
    if (!current.runIds.has(runId)) {
      current.runIds.add(runId);
      current.runCount += 1;
    }
    current.input += parts.input;
    current.output += parts.output;
    current.cacheRead += parts.cacheRead;
    current.cacheCreation += parts.cacheCreation;
    current.total += parts.total;
    if (costEstimate != null) {
      current.costEstimate = (current.costEstimate ?? 0) + costEstimate;
    }
    byModelMap.set(key, current);
  };

  const runPoints: FamilyObservabilityTokenRunPoint[] = ordered.map((run) => {
    const receipts = sessionRows.get(run.id) ?? [];
    const parts = (rows: typeof receipts) =>
      rows.reduce(
        (acc, row) =>
          mergeParts(acc, {
            input: num(row.inputTokens),
            output: num(row.outputTokens),
            cacheRead: num(row.cacheRead),
            cacheCreation: num(row.cacheCreation),
            total: num(row.totalTokens),
          }),
        emptyParts(),
      );
    const worker = parts(receipts.filter((row) => !isReviewSession(row) && !isHelperSession(row)));
    const review = parts(receipts.filter(isReviewSession));
    const helper = parts(receipts.filter(isHelperSession));
    const stepParts = parts(receipts);
    const hasCapturedReceipts = runSessionUsageReceipts(run).length > 0;
    const hasMetrics = hasCapturedReceipts || hasRunMetrics(run, worker, review);
    if (hasMetrics) runsWithMetrics += 1;
    else missingRunIds.push(run.id);

    cumulativeTokens += stepParts.total;
    const cost = receipts.length
      ? receipts.every((row) => row.costUsd != null)
        ? receipts.reduce((sum, row) => sum + num(row.costUsd), 0)
        : null
      : hasCapturedReceipts
        ? 0
        : (run.metrics.costEstimate ?? null);
    if (receipts.some((row) => row.costUsd == null)) hasUnpriced = true;
    for (const row of receipts)
      if (row.costUsd == null) unpricedModels.add(row.actualModel ?? row.model ?? 'unknown');
    if (cost != null) {
      cumulativeCost += cost;
      hasAnyCost = true;
    }

    for (const row of receipts)
      addContribution(
        run.id,
        row.actualModel ?? row.model ?? null,
        parts([row]),
        row.costUsd ?? null,
      );

    return {
      runId: run.id,
      label: runLabel(run),
      flowType: run.flowType,
      lane: run.lane,
      status: run.status,
      createdAt: run.createdAt,
      model: workerModel(run),
      runner: run.metrics.runner ?? null,
      workerTokens: worker.total,
      reviewTokens: review.total,
      helperTokens: helper.total,
      inputTokens: stepParts.input,
      outputTokens: stepParts.output,
      cacheRead: stepParts.cacheRead,
      cacheCreation: stepParts.cacheCreation,
      stepTokens: stepParts.total,
      stepCostEstimate: cost,
      cumulativeTokens,
      cumulativeCostEstimate: hasAnyCost && !hasUnpriced ? cumulativeCost : null,
      deltaTokens: stepParts.total,
      deltaCostEstimate: cost,
      hasMetrics,
    };
  });

  const byModel = [...byModelMap.values()]
    .map(({ runIds: _runIds, ...entry }) =>
      unpricedModels.has(entry.model) ? { ...entry, costEstimate: null } : entry,
    )
    .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));

  return {
    familyTotalTokens: cumulativeTokens,
    familyTotalCostEstimate: hasAnyCost && !hasUnpriced ? cumulativeCost : null,
    runsWithMetrics,
    runsMissingMetrics: missingRunIds.length,
    missingRunIds,
    runPoints,
    milestoneRunPoints: milestonePoints(runPoints, familyId),
    byModel,
  };
}
