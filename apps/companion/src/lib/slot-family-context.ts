import type { FamilyObservabilitySnapshot } from '@farmslot/protocol';

import { groupVisualArtifactPairs } from './artifact-url';
import { collectFamilyRetrospectives } from './family-retrospectives';

export interface SlotFamilyContextSummary {
  familyId: string;
  title: string;
  workflowState: string;
  runs: number;
  activeRuns: number;
  evidence: number;
  visualPairs: number;
  visualPairLabel: string;
  diffLabel: string;
  recipeQualityLabel: string;
  retrospectives: number;
  pendingRetrospectives: number;
  retrospectiveSignals: SlotFamilyRetrospectiveSignal[];
  ledgerLabel: string | null;
}

export interface SlotFamilyRetrospectiveSignal {
  runId: string;
  decisionId: string;
  title: string;
  runTitle: string;
  pending: boolean;
  createdAt: string;
  artifactCount: number;
  visualPairs: number;
  primaryVisualPair: SlotFamilyVisualPairSignal | null;
  diffLabel: string;
  diffAvailable: boolean;
}

export interface SlotFamilyVisualPairSignal {
  beforePath: string;
  afterPath: string;
  stem: string;
}

export function summarizeSlotFamilyContext(
  snapshot: FamilyObservabilitySnapshot | null,
): SlotFamilyContextSummary | null {
  if (!snapshot) return null;
  const retrospectives = collectFamilyRetrospectives(snapshot.runs);
  const visualPairs = groupVisualArtifactPairs(snapshot.evidence, () => '').pairs.length;
  const recipeQualityParts = [
    snapshot.recipeQuality.semantic,
    snapshot.recipeQuality.score != null ? String(snapshot.recipeQuality.score) : null,
  ].filter((part): part is string => Boolean(part));
  return {
    familyId: snapshot.familyId,
    title: snapshot.familyRootTicketOrPr,
    workflowState: snapshot.workflowState,
    runs: snapshot.familyRunCount,
    activeRuns: snapshot.activeRunCount,
    evidence: snapshot.evidence.length,
    visualPairs,
    visualPairLabel: `${visualPairs} pair${visualPairs === 1 ? '' : 's'}`,
    diffLabel: snapshot.diffStat.available
      ? `${snapshot.diffStat.files} files · +${snapshot.diffStat.additions} -${snapshot.diffStat.deletions}`
      : 'no diff',
    recipeQualityLabel: recipeQualityParts.length > 0 ? recipeQualityParts.join(' · ') : 'unknown',
    retrospectives: retrospectives.length,
    pendingRetrospectives: retrospectives.filter((entry) => !entry.decision.resolvedAt).length,
    retrospectiveSignals: retrospectives.slice(0, 3).map(({ run, decision }) => {
      const runVisualPairSummary = groupVisualArtifactPairs(run.artifacts, () => '');
      const primaryVisualPair = runVisualPairSummary.pairs[0] ?? null;
      return {
        runId: run.runId,
        decisionId: decision.id,
        title: decision.title,
        runTitle: run.ticketOrPr,
        pending: !decision.resolvedAt,
        createdAt: decision.createdAt,
        artifactCount: run.artifacts.length,
        visualPairs: runVisualPairSummary.pairs.length,
        primaryVisualPair: primaryVisualPair
          ? {
              beforePath: primaryVisualPair.before.path,
              afterPath: primaryVisualPair.after.path,
              stem: primaryVisualPair.stem,
            }
          : null,
        diffLabel: run.diffStat.available
          ? `${run.diffStat.files} files · +${run.diffStat.additions} -${run.diffStat.deletions}`
          : 'no diff',
        diffAvailable: run.diffStat.available,
      };
    }),
    ledgerLabel: snapshot.familyChangeLedger
      ? `${snapshot.familyChangeLedger.summary.runsWithContributionDiff}/${snapshot.familyChangeLedger.entries.length} diffs · ${snapshot.familyChangeLedger.summary.artifactFootprint.count} artifacts`
      : null,
  };
}
