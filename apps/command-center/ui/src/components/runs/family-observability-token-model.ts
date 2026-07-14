import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
  FamilyObservabilityTokenModelBreakdown,
  FamilyObservabilityTokenRunPoint,
  FamilyObservabilityTokenSummary,
  GateSummary,
} from '@farmslot/protocol';

import { familyRunLabel } from './family-observability-compare-model.js';
import { runGateSummary } from './family-observability-gate-model.js';

export type FamilyTokenScope = 'family' | 'run';
export type FamilyTokenTrajectory = 'all-runs' | 'pr-complete-milestones';

export type {
  FamilyObservabilityTokenModelBreakdown,
  FamilyObservabilityTokenRunPoint,
  FamilyObservabilityTokenSummary,
};

export interface RunTokenRoleBreakdown {
  role: 'worker' | 'review' | 'fix-loop';
  label: string;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export interface RunTokenSummary {
  runId: string;
  label: string;
  flowType: string;
  totalTokens: number;
  costEstimate: number | null;
  byModel: FamilyObservabilityTokenModelBreakdown[];
  roles: RunTokenRoleBreakdown[];
  usesGateSummary: boolean;
  hasData: boolean;
}

function runTokenParts(run: FamilyObservabilityRunSummary): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  hasMetrics: boolean;
} {
  const metrics = run.metrics;
  if (!metrics) {
    return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, hasMetrics: false };
  }
  const input = metrics.sessionInputTokens ?? 0;
  const output = metrics.sessionOutputTokens ?? 0;
  const cacheRead = metrics.sessionCacheRead ?? 0;
  const cacheCreation = metrics.sessionCacheCreation ?? 0;
  const derivedTotal = input + output + cacheRead + cacheCreation;
  const total =
    metrics.sessionTotalTokens != null && metrics.sessionTotalTokens > 0
      ? metrics.sessionTotalTokens
      : derivedTotal;
  const hasMetrics =
    total > 0 ||
    metrics.costEstimate != null ||
    metrics.sessionTurns != null ||
    metrics.sessionInputTokens != null ||
    metrics.sessionOutputTokens != null;
  return { input, output, cacheRead, cacheCreation, total, hasMetrics };
}

/** Client-side fallback when snapshot predates gateway tokenSummary. */
export function buildClientFamilyTokenSummary(
  snapshot: Pick<FamilyObservabilitySnapshot, 'familyId' | 'runs'>,
): FamilyObservabilityTokenSummary {
  const ordered = [...snapshot.runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId),
  );
  let cumulativeTokens = 0;
  let cumulativeCost = 0;
  let hasAnyCost = false;
  let runsWithMetrics = 0;
  const missingRunIds: string[] = [];
  const byModelMap = new Map<
    string,
    FamilyObservabilityTokenModelBreakdown & { runIds: Set<string> }
  >();

  const addModel = (
    runId: string,
    model: string,
    parts: ReturnType<typeof runTokenParts>,
    cost: number | null,
  ) => {
    if (parts.total <= 0) return;
    const current = byModelMap.get(model) ?? {
      model,
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
    if (cost != null) current.costEstimate = (current.costEstimate ?? 0) + cost;
    byModelMap.set(model, current);
  };

  const runPoints: FamilyObservabilityTokenRunPoint[] = ordered.map((run) => {
    const parts = runTokenParts(run);
    if (parts.hasMetrics) runsWithMetrics += 1;
    else missingRunIds.push(run.runId);
    cumulativeTokens += parts.total;
    const cost = run.metrics?.costEstimate ?? null;
    if (cost != null) {
      cumulativeCost += cost;
      hasAnyCost = true;
    }
    addModel(run.runId, run.metrics?.actualModel ?? run.metrics?.model ?? 'unknown', parts, cost);
    return {
      runId: run.runId,
      label: familyRunLabel(run),
      flowType: run.flowType,
      lane: run.lane,
      status: run.status,
      createdAt: run.createdAt,
      model: run.metrics?.actualModel ?? run.metrics?.model ?? null,
      runner: run.metrics?.runner ?? null,
      workerTokens: parts.total,
      reviewTokens: 0,
      inputTokens: parts.input,
      outputTokens: parts.output,
      cacheRead: parts.cacheRead,
      cacheCreation: parts.cacheCreation,
      stepTokens: parts.total,
      stepCostEstimate: cost,
      cumulativeTokens,
      cumulativeCostEstimate: hasAnyCost ? cumulativeCost : null,
      deltaTokens: parts.total,
      deltaCostEstimate: cost,
      hasMetrics: parts.hasMetrics,
    };
  });

  const byModel = [...byModelMap.values()].map(({ runIds: _runIds, ...entry }) => entry);

  return {
    familyTotalTokens: cumulativeTokens,
    familyTotalCostEstimate: hasAnyCost ? cumulativeCost : null,
    runsWithMetrics,
    runsMissingMetrics: missingRunIds.length,
    missingRunIds,
    runPoints,
    milestoneRunPoints: filterPointsForTrajectory(
      runPoints,
      'pr-complete-milestones',
      snapshot.familyId,
    ),
    byModel,
  };
}

export function resolveFamilyTokenSummary(
  snapshot: Pick<FamilyObservabilitySnapshot, 'familyId' | 'runs' | 'tokenSummary'>,
): FamilyObservabilityTokenSummary {
  return snapshot.tokenSummary ?? buildClientFamilyTokenSummary(snapshot);
}

export function filterPointsForTrajectory(
  points: readonly FamilyObservabilityTokenRunPoint[],
  trajectory: FamilyTokenTrajectory,
  familyId: string,
  milestoneRunPoints?: readonly FamilyObservabilityTokenRunPoint[],
): FamilyObservabilityTokenRunPoint[] {
  if (trajectory === 'all-runs') return [...points];
  if (milestoneRunPoints?.length) return [...milestoneRunPoints];
  let milestoneIndex = 0;
  return points
    .filter(
      (point) =>
        point.flowType === 'pr-complete' ||
        point.flowType === 'update-branch' ||
        point.runId === familyId,
    )
    .map((point) => {
      if (point.flowType === 'pr-complete' || point.flowType === 'update-branch') {
        milestoneIndex += 1;
        return { ...point, label: `${point.flowType} #${milestoneIndex}` };
      }
      return { ...point, label: 'family root' };
    });
}

function byModelFromGate(tokens: GateSummary['tokens']): FamilyObservabilityTokenModelBreakdown[] {
  return tokens.byModel.map((entry) => ({
    model: entry.model ?? 'unknown',
    runCount: 1,
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead,
    cacheCreation: entry.cacheCreation,
    total: entry.total,
    costEstimate: null,
  }));
}

function rolesFromGate(tokens: GateSummary['tokens']): RunTokenRoleBreakdown[] {
  const roles: RunTokenRoleBreakdown[] = [
    {
      role: 'worker',
      label: 'Worker',
      model: tokens.mainWorker.model,
      input: tokens.mainWorker.input,
      output: tokens.mainWorker.output,
      cacheRead: tokens.mainWorker.cacheRead,
      cacheCreation: tokens.mainWorker.cacheCreation,
      total: tokens.mainWorker.total,
    },
  ];
  for (const review of tokens.reviews) {
    roles.push({
      role: 'review',
      label: review.id,
      model: review.model,
      input: review.input ?? 0,
      output: review.output ?? 0,
      cacheRead: review.cacheRead ?? 0,
      cacheCreation: review.cacheCreation ?? 0,
      total: review.total,
    });
  }
  for (const loop of tokens.familyChainedLoops ?? []) {
    roles.push({
      role: 'fix-loop',
      label: `${loop.flowType} · ${loop.runId.slice(0, 8)}`,
      model: loop.model,
      input: loop.tokens.input,
      output: loop.tokens.output,
      cacheRead: loop.tokens.cacheRead,
      cacheCreation: loop.tokens.cacheCreation,
      total: loop.tokens.total,
    });
  }
  return roles.filter((role) => role.total > 0);
}

export function buildRunTokenSummary(run: FamilyObservabilityRunSummary): RunTokenSummary {
  const gateSummary = runGateSummary(run);
  const parts = runTokenParts(run);
  const label = familyRunLabel(run);

  if (gateSummary) {
    const roles = rolesFromGate(gateSummary.tokens);
    return {
      runId: run.runId,
      label,
      flowType: run.flowType,
      totalTokens: gateSummary.tokens.familyTotalTokens,
      costEstimate: run.metrics?.costEstimate ?? null,
      byModel: byModelFromGate(gateSummary.tokens),
      roles,
      usesGateSummary: true,
      hasData: gateSummary.tokens.familyTotalTokens > 0 || roles.length > 0,
    };
  }

  const model = run.metrics?.actualModel ?? run.metrics?.model ?? 'unknown';
  return {
    runId: run.runId,
    label,
    flowType: run.flowType,
    totalTokens: parts.total,
    costEstimate: run.metrics?.costEstimate ?? null,
    byModel: parts.hasMetrics
      ? [
          {
            model,
            runCount: 1,
            input: parts.input,
            output: parts.output,
            cacheRead: parts.cacheRead,
            cacheCreation: parts.cacheCreation,
            total: parts.total,
            costEstimate: run.metrics?.costEstimate ?? null,
          },
        ]
      : [],
    roles: parts.hasMetrics
      ? [
          {
            role: 'worker',
            label: 'Worker session',
            model: run.metrics?.actualModel ?? run.metrics?.model ?? null,
            input: parts.input,
            output: parts.output,
            cacheRead: parts.cacheRead,
            cacheCreation: parts.cacheCreation,
            total: parts.total,
          },
        ]
      : [],
    usesGateSummary: false,
    hasData: parts.hasMetrics,
  };
}

export function familyTokenMetricLabel(summary: FamilyObservabilityTokenSummary): string {
  const total = summary.familyTotalTokens;
  if (total < 1000) return `${total}`;
  if (total < 1_000_000) {
    const k = total / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  const m = total / 1_000_000;
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

export function familyCostMetricLabel(summary: FamilyObservabilityTokenSummary): string {
  const value = summary.familyTotalCostEstimate;
  if (value == null) return '—';
  return `$${value.toFixed(2)}`;
}
