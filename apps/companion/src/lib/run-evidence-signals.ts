import { type Run, type RunEvidenceSummary, summarizeRunEvidence } from '@farmslot/protocol';

/** Union of run shapes that summarizeRunEvidenceSignals accepts — matches summarizeRunEvidence. */
type RunEvidenceInput =
  | Pick<Run, 'decisions' | 'steps' | 'liveRecipeContext'>
  | (Pick<Run, 'steps' | 'liveRecipeContext'> & {
      decisions?: ReadonlyArray<{ payload?: unknown }>;
      evidenceSummary: RunEvidenceSummary;
    });

export type RunEvidenceSignalKind = 'video' | 'compare';

export interface RunEvidenceSignal {
  kind: RunEvidenceSignalKind;
  label: string;
  count: number;
  title: string;
}

export interface RunEvidenceSignalRouteTarget {
  section: 'compare' | 'evidence';
  evidence?: 'videos';
}

export function runEvidenceSignalRouteTarget(
  signal: Pick<RunEvidenceSignal, 'kind'>,
): RunEvidenceSignalRouteTarget {
  return signal.kind === 'compare'
    ? { section: 'compare' }
    : { section: 'evidence', evidence: 'videos' };
}

export function summarizeRunEvidenceSignals(run: RunEvidenceInput): RunEvidenceSignal[] {
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
