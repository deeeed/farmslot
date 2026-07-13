import {
  type FamilyObservabilityTokenModelBreakdown,
  type FamilyObservabilityTokenRunPoint,
  type FamilyObservabilityTokenSummary,
  type FlowType,
  type Run,
} from '@farmslot/protocol';

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

interface TokenContribution extends TokenParts {
  model: string | null;
}

function emptyParts(): TokenParts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}

function partsFromMetrics(metrics: Run['metrics'] | undefined): TokenParts {
  if (!metrics) return emptyParts();
  const input = num(metrics.sessionInputTokens);
  const output = num(metrics.sessionOutputTokens);
  const cacheRead = num(metrics.sessionCacheRead);
  const cacheCreation = num(metrics.sessionCacheCreation);
  const derived = input + output + cacheRead + cacheCreation;
  const total =
    metrics.sessionTotalTokens != null && metrics.sessionTotalTokens > 0
      ? metrics.sessionTotalTokens
      : derived;
  return { input, output, cacheRead, cacheCreation, total };
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

function reviewTokenParts(run: Run): TokenParts {
  const reviews = run.engineState?.publishGate?.independentReviews ?? [];
  return reviews.reduce((acc, review) => {
    const usage = review.usage;
    if (!usage || num(usage.totalTokens) <= 0) return acc;
    return mergeParts(acc, {
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheRead),
      cacheCreation: num(usage.cacheCreation),
      total: num(usage.totalTokens),
    });
  }, emptyParts());
}

function reviewContributions(run: Run): TokenContribution[] {
  const reviews = run.engineState?.publishGate?.independentReviews ?? [];
  return reviews
    .filter((review) => review.usage && num(review.usage.totalTokens) > 0)
    .map((review) => ({
      model: review.usage?.actualModel ?? review.model ?? null,
      input: num(review.usage?.inputTokens),
      output: num(review.usage?.outputTokens),
      cacheRead: num(review.usage?.cacheRead),
      cacheCreation: num(review.usage?.cacheCreation),
      total: num(review.usage?.totalTokens),
    }));
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
  let cumulativeTokens = 0;
  let cumulativeCost = 0;
  let hasAnyCost = false;
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
    if (parts.total <= 0) return;
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
    const worker = partsFromMetrics(run.metrics);
    const review = reviewTokenParts(run);
    const stepParts = mergeParts(worker, review);
    const hasMetrics = hasRunMetrics(run, worker, review);
    if (hasMetrics) runsWithMetrics += 1;
    else missingRunIds.push(run.id);

    cumulativeTokens += stepParts.total;
    const cost = run.metrics.costEstimate ?? null;
    if (cost != null) {
      cumulativeCost += cost;
      hasAnyCost = true;
    }

    addContribution(run.id, workerModel(run), worker, cost);
    for (const reviewContribution of reviewContributions(run)) {
      addContribution(run.id, reviewContribution.model, reviewContribution, null);
    }

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
      inputTokens: stepParts.input,
      outputTokens: stepParts.output,
      cacheRead: stepParts.cacheRead,
      cacheCreation: stepParts.cacheCreation,
      stepTokens: stepParts.total,
      stepCostEstimate: cost,
      cumulativeTokens,
      cumulativeCostEstimate: hasAnyCost ? cumulativeCost : null,
      deltaTokens: stepParts.total,
      deltaCostEstimate: cost,
      hasMetrics,
    };
  });

  const byModel = [...byModelMap.values()]
    .map(({ runIds: _runIds, ...entry }) => entry)
    .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));

  return {
    familyTotalTokens: cumulativeTokens,
    familyTotalCostEstimate: hasAnyCost ? cumulativeCost : null,
    runsWithMetrics,
    runsMissingMetrics: missingRunIds.length,
    missingRunIds,
    runPoints,
    milestoneRunPoints: milestonePoints(runPoints, familyId),
    byModel,
  };
}
