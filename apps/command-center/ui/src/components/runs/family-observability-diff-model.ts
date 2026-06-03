import type {
  FamilyChangeLedgerEntry,
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

type FamilyDiffProvenance = FamilyChangeLedgerEntry['contributionDiff'];

export interface FamilyDiffSnapshot {
  diffStat: FamilyObservabilitySnapshot['diffStat'];
  evidence: readonly FamilyObservabilityArtifact[];
  runs: ReadonlyArray<Pick<FamilyObservabilityRunSummary, 'artifacts' | 'diffStat' | 'runId'>>;
  familyChangeLedger?: {
    entries: readonly FamilyChangeLedgerEntry[];
    summary?: Pick<
      NonNullable<FamilyObservabilitySnapshot['familyChangeLedger']>['summary'],
      'totalContributionAdditions' | 'totalContributionDeletions' | 'totalContributionFiles'
    >;
  } | null;
}

export function familyLedgerEntry(
  snapshot: Pick<FamilyDiffSnapshot, 'familyChangeLedger'>,
  runId: string,
): FamilyChangeLedgerEntry | undefined {
  return snapshot.familyChangeLedger?.entries.find((entry) => entry.runId === runId);
}

export function ledgerDiffLabel(entry: FamilyChangeLedgerEntry): string {
  if (entry.changeKind === 'review-input' && entry.inputDiff?.available) {
    return `reviewed PR diff +${entry.inputDiff.additions} -${entry.inputDiff.deletions}`;
  }
  if (entry.contributionDiff.available) {
    return `produced code +${entry.contributionDiff.additions} -${entry.contributionDiff.deletions}`;
  }
  if (entry.inputDiff?.available) {
    return `reviewed PR diff +${entry.inputDiff.additions} -${entry.inputDiff.deletions}`;
  }
  if (entry.legacyDiffFallback?.available) {
    return `legacy diff +${entry.legacyDiffFallback.additions} -${entry.legacyDiffFallback.deletions}`;
  }
  return 'no code diff';
}

export function familyDiffLabel(snapshot: Pick<FamilyDiffSnapshot, 'diffStat'>): string {
  return snapshot.diffStat.available
    ? `${snapshot.diffStat.files} files · +${snapshot.diffStat.additions} -${snapshot.diffStat.deletions}`
    : 'Unavailable';
}

export function familyContributionDeltaLabel(
  snapshot: Pick<FamilyDiffSnapshot, 'diffStat' | 'familyChangeLedger'>,
): string {
  if (snapshot.diffStat.available) return familyDiffLabel(snapshot);
  const summary = snapshot.familyChangeLedger?.summary;
  return summary
    ? `${summary.totalContributionFiles} files · +${summary.totalContributionAdditions} -${summary.totalContributionDeletions}`
    : familyDiffLabel(snapshot);
}

export function runDiffLabel(
  snapshot: Pick<FamilyDiffSnapshot, 'familyChangeLedger'>,
  run: Pick<FamilyObservabilityRunSummary, 'diffStat' | 'runId'>,
): string {
  const entry = familyLedgerEntry(snapshot, run.runId);
  if (entry?.contributionDiff.available) {
    return `produced code +${entry.contributionDiff.additions} -${entry.contributionDiff.deletions}`;
  }
  if (entry?.inputDiff?.available) {
    return `reviewed PR diff +${entry.inputDiff.additions} -${entry.inputDiff.deletions}`;
  }
  if (entry?.legacyDiffFallback?.available) {
    return `legacy diff +${entry.legacyDiffFallback.additions} -${entry.legacyDiffFallback.deletions}`;
  }
  return run.diffStat.available
    ? `produced code +${run.diffStat.additions} -${run.diffStat.deletions}`
    : 'no code diff';
}

export function artifactFromPath(
  snapshot: Pick<FamilyDiffSnapshot, 'evidence' | 'runs'>,
  runId: string,
  familyId: string,
  pathValue: string | undefined,
  purpose: string,
  source: FamilyObservabilityArtifact['source'],
): FamilyObservabilityArtifact | null {
  if (!pathValue) return null;
  const run = snapshot.runs.find((candidate) => candidate.runId === runId);
  const existing = [...(run?.artifacts ?? []), ...snapshot.evidence].find(
    (artifact) => artifact.runId === runId && artifact.path === pathValue,
  );
  return existing ?? { runId, familyId, path: pathValue, purpose, source };
}

export function diffArtifactFromProvenance(
  snapshot: Pick<FamilyDiffSnapshot, 'evidence' | 'runs'>,
  runId: string,
  familyId: string,
  diff: FamilyDiffProvenance,
  purpose: string,
  source: FamilyObservabilityArtifact['source'],
): FamilyObservabilityArtifact | null {
  if (!diff.available || !diff.artifactPath) return null;
  return artifactFromPath(snapshot, runId, familyId, diff.artifactPath, purpose, source);
}

export function ledgerDiffArtifact(
  snapshot: Pick<FamilyDiffSnapshot, 'evidence' | 'runs'>,
  entry: FamilyChangeLedgerEntry,
): FamilyObservabilityArtifact | null {
  if (entry.changeKind === 'review-input' && entry.inputDiff) {
    return diffArtifactFromProvenance(
      snapshot,
      entry.runId,
      entry.familyId,
      entry.inputDiff,
      'input-diff',
      'task-input',
    );
  }
  return (
    diffArtifactFromProvenance(
      snapshot,
      entry.runId,
      entry.familyId,
      entry.contributionDiff,
      'diff',
      'task-artifact',
    ) ??
    (entry.inputDiff
      ? diffArtifactFromProvenance(
          snapshot,
          entry.runId,
          entry.familyId,
          entry.inputDiff,
          'input-diff',
          'task-input',
        )
      : null) ??
    (entry.legacyDiffFallback
      ? diffArtifactFromProvenance(
          snapshot,
          entry.runId,
          entry.familyId,
          entry.legacyDiffFallback,
          'legacy-diff',
          'step-output',
        )
      : null)
  );
}

export function runDiffArtifact(
  snapshot: FamilyDiffSnapshot,
  run: Pick<FamilyObservabilityRunSummary, 'artifacts' | 'diffStat' | 'runId'>,
): FamilyObservabilityArtifact | null {
  const entry = familyLedgerEntry(snapshot, run.runId);
  if (entry) {
    const artifact = ledgerDiffArtifact(snapshot, entry);
    if (artifact) return artifact;
  }
  if (!run.diffStat.available) return null;
  return (
    run.artifacts.find(
      (artifact) =>
        artifact.path === 'artifacts/diff.txt' ||
        artifact.path.endsWith('/diff.txt') ||
        artifact.path.endsWith('.diff') ||
        artifact.purpose.includes('diff'),
    ) ?? null
  );
}

export function familyDiffArtifact(
  snapshot: FamilyDiffSnapshot,
): FamilyObservabilityArtifact | null {
  const diffRun =
    snapshot.runs.find((candidate) => candidate.runId === snapshot.diffStat.runId) ??
    snapshot.runs.find((candidate) => candidate.diffStat.available);
  if (diffRun) {
    const artifact = runDiffArtifact(snapshot, diffRun);
    if (artifact) return artifact;
  }
  const ledgerArtifact = snapshot.familyChangeLedger?.entries
    .map((entry) => ledgerDiffArtifact(snapshot, entry))
    .find((entry): entry is FamilyObservabilityArtifact => Boolean(entry));
  return ledgerArtifact ?? null;
}
