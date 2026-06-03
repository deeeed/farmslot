import type { Run } from '@farmslot/protocol';

import {
  type SlotWorkspaceGateSummary,
  type SlotWorkspaceRetroSummary,
  summarizeSlotWorkspaceGates,
  summarizeSlotWorkspaceRetro,
  workspaceGateDiffMetricValue,
} from './slot-workspace';

export interface RunWorkspaceNavMetaSummary {
  readyMeta: string | null;
  reviewMeta: string | null;
  retroMeta: string | null;
}

export interface DecisionWorkspaceNavMetaInput {
  statusLabel?: string | null;
  artifactCount: number;
  diffValue?: string | null;
  visualPairCount?: number | null;
}

export function summarizeRunWorkspaceNavMeta(
  run: Run | null | undefined,
): RunWorkspaceNavMetaSummary {
  if (!run) {
    return { readyMeta: null, reviewMeta: null, retroMeta: null };
  }

  const gates = summarizeSlotWorkspaceGates(run);
  const readyGate = gates.find((gate) => gate.label === 'Ready workspace') ?? null;
  const reviewGate =
    gates.find((gate) => gate.label === 'Review workspace' || gate.label === 'No-change review') ??
    null;
  const retro = summarizeSlotWorkspaceRetro(run);

  return {
    readyMeta: workspaceGateNavMeta(readyGate),
    reviewMeta: workspaceGateNavMeta(reviewGate),
    retroMeta: workspaceRetroNavMeta(retro),
  };
}

export function workspaceGateNavMeta(
  gate: SlotWorkspaceGateSummary | null | undefined,
): string | null {
  if (!gate) return null;
  const diffValue = workspaceGateDiffMetricValue(gate);
  const artifactLabel = `${gate.artifactPaths.length} file${
    gate.artifactPaths.length === 1 ? '' : 's'
  }`;
  const state = !gate.resolved
    ? 'pending'
    : gate.tone === 'ready'
      ? 'ready'
      : gate.tone === 'warning'
        ? 'warning'
        : 'resolved';
  return diffValue ? `${state} · ${artifactLabel} · ${diffValue}` : `${state} · ${artifactLabel}`;
}

export function workspaceRetroNavMeta(
  retro: SlotWorkspaceRetroSummary | null | undefined,
): string | null {
  if (!retro) return null;
  const fileLabel = `${retro.artifactPaths.length} file${
    retro.artifactPaths.length === 1 ? '' : 's'
  }`;
  const pairLabel = retro.visualPairCount > 0 ? ` · ${retro.visualPairCount} before→after` : '';
  return `${retro.statusLabel} · ${fileLabel}${pairLabel}`;
}

export function decisionWorkspaceNavMeta({
  statusLabel = 'pending',
  artifactCount,
  diffValue,
  visualPairCount = 0,
}: DecisionWorkspaceNavMetaInput): string {
  const pairCount = visualPairCount ?? 0;
  const parts = [
    statusLabel?.trim() || 'pending',
    `${artifactCount} file${artifactCount === 1 ? '' : 's'}`,
  ];
  const normalizedDiffValue = diffValue?.trim();
  if (
    normalizedDiffValue &&
    !['-', 'none', 'no diff'].includes(normalizedDiffValue.toLowerCase())
  ) {
    parts.push(normalizedDiffValue);
  }
  if (pairCount > 0) {
    parts.push(`${pairCount} before→after`);
  }
  return parts.join(' · ');
}
