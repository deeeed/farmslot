import {
  type Run,
  type RunEvidenceSummary,
  summarizeRunEvidence,
} from '@farmslot/protocol';

export type RunEvidenceSignalKind = 'video' | 'compare';

export interface RunEvidenceSignal {
  kind: RunEvidenceSignalKind;
  label: string;
  count: number;
  title: string;
}

export function summarizeRunEvidenceSignals(
  run: Pick<Run, 'decisions' | 'steps' | 'liveRecipeContext'>,
): RunEvidenceSignal[] {
  return runEvidenceSignals(summarizeRunEvidence(run));
}

export function runEvidenceSignals(summary: RunEvidenceSummary): RunEvidenceSignal[] {
  const signals: RunEvidenceSignal[] = [];
  if (summary.videoCount > 0) {
    signals.push({
      kind: 'video',
      label: `Video ${summary.videoCount}`,
      count: summary.videoCount,
      title: `${summary.videoCount} video artifact${summary.videoCount === 1 ? '' : 's'} available`,
    });
  }
  if (summary.visualPairCount > 0) {
    signals.push({
      kind: 'compare',
      label: `Compare ${summary.visualPairCount}`,
      count: summary.visualPairCount,
      title: `${summary.visualPairCount} before/after pair${summary.visualPairCount === 1 ? '' : 's'} available`,
    });
  }
  return signals;
}
