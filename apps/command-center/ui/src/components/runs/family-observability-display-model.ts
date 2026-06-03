import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';
import { modelsMatch } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import { familyRunBadgeLabel } from './family-observability-evidence.js';
import { flowColor } from './run-utils.js';

export function familyOriginLabel(
  snapshot: Pick<FamilyObservabilitySnapshot, 'familyId' | 'runs'>,
): string {
  const runs = snapshot.runs ?? [];
  const root =
    runs.find((run) => run.runId === snapshot.familyId) ??
    runs.find((run) => run.parentRunId == null) ??
    runs[0];
  return root ? familyRunBadgeLabel(root) : '—';
}

export function runBadgeColor(
  run: Pick<FamilyObservabilityRunSummary, 'flowType' | 'lane' | 'ticketOrPr'>,
): string {
  return run.lane === 'comparison' ? colors.accent : flowColor(run.flowType);
}

export function terminalRunEmphasisClass(status: string): string {
  return status === 'failed' || status === 'cancelled' ? 'terminal-alert' : '';
}

export function semanticColor(value: string): string {
  switch (value) {
    case 'good':
      return colors.statusOk;
    case 'ok':
      return colors.statusWarn;
    case 'bad':
      return colors.statusFail;
    default:
      return colors.textMuted;
  }
}

export function hasUsageMetrics(run: Pick<FamilyObservabilityRunSummary, 'metrics'>): boolean {
  const metrics = run.metrics;
  if (!metrics) return false;
  return (
    metrics.costEstimate != null ||
    metrics.sessionTurns != null ||
    metrics.sessionTotalTokens != null ||
    metrics.sessionInputTokens != null ||
    metrics.sessionOutputTokens != null ||
    metrics.sessionCacheCreation != null ||
    metrics.sessionCacheRead != null ||
    metrics.actualModel != null
  );
}

export function hasModelDrift(run: Pick<FamilyObservabilityRunSummary, 'metrics'>): boolean {
  const metrics = run.metrics;
  return Boolean(metrics?.actualModel && !modelsMatch(metrics.model, metrics.actualModel));
}

export function prStateColor(state: 'OPEN' | 'CLOSED' | 'MERGED'): string {
  if (state === 'MERGED') return colors.statusOk;
  if (state === 'CLOSED') return colors.statusFail;
  return colors.accent;
}
