import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { evidenceSummary } from './family-observability-output-model.js';

export interface FamilyCopilotCompareRequest {
  prompt: string;
  intent: 'diagnostic-readonly';
  runId: string;
  sourceSurface: 'family-observability';
  contextOverride: {
    selectedFamilyId: string;
    selectedRunId: string;
    compareRunIds: string[];
    surfaceId: 'family-observability';
    affordances: string[];
  };
}

export function comparisonRuns(
  snapshot: Pick<FamilyObservabilitySnapshot, 'runs'>,
): FamilyObservabilityRunSummary[] {
  const comparison = snapshot.runs.filter((run) => run.lane === 'comparison');
  return comparison.length >= 2 ? comparison : [];
}

export function familyRunLabel(run: FamilyObservabilityRunSummary): string {
  return run.variant || `${run.metrics?.runner ?? 'runner'}-${run.metrics?.model ?? 'model'}`;
}

export function crossComparePrompt(
  snapshot: Pick<
    FamilyObservabilitySnapshot,
    'evidence' | 'familyId' | 'familyRootTicketOrPr' | 'runs'
  >,
): string {
  const rows = comparisonRuns(snapshot)
    .map((run) => {
      const evidence = evidenceSummary(snapshot, run);
      const diff = run.diffStat.available
        ? `${run.diffStat.files} files +${run.diffStat.additions}/-${run.diffStat.deletions}`
        : 'diff unavailable';
      return `- ${familyRunLabel(run)} (${run.runId}): status=${run.status}, runner=${run.metrics?.runner ?? '-'}, model=${run.metrics?.model ?? '-'}, slot=${run.slotId ?? '-'}, PR=${run.prNumber ?? '-'}, diff=${diff}, recipe=${run.recipeQuality.semantic}, evidence=${evidence}, selfReview=${run.selfReview.verdict ?? '-'}`;
    })
    .join('\n');
  return [
    `Cross-compare comparison family ${snapshot.familyId} for ${snapshot.familyRootTicketOrPr}.`,
    'Compare the candidate solutions by code delta, PR output, recipe/evidence quality, self-review findings, runtime risks, and missing data.',
    'Elect a winner if one is clearly safer; otherwise identify what evidence or cross-review is needed next.',
    '',
    rows,
  ].join('\n');
}

export function familyCopilotCompareRequest(
  snapshot: Pick<
    FamilyObservabilitySnapshot,
    'evidence' | 'familyId' | 'familyRootTicketOrPr' | 'latestRunId' | 'runs'
  >,
  selectedRunId: string,
): FamilyCopilotCompareRequest {
  const targetRunId = selectedRunId || snapshot.latestRunId;
  return {
    prompt: crossComparePrompt(snapshot),
    intent: 'diagnostic-readonly',
    runId: targetRunId,
    sourceSurface: 'family-observability',
    contextOverride: {
      selectedFamilyId: snapshot.familyId,
      selectedRunId: targetRunId,
      compareRunIds: comparisonRuns(snapshot).map((run) => run.runId),
      surfaceId: 'family-observability',
      affordances: ['comparison-lane-analysis', 'winner-selection', 'evidence-provenance'],
    },
  };
}
