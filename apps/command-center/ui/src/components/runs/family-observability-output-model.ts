import type {
  EvalExperimentProjection,
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  ResultPackageProjection,
  RunLane,
} from '@farmslot/protocol';

const OUTPUT_IMAGE_EXTS = /\.(png|jpg|jpeg|gif)$/i;
const OUTPUT_VIDEO_EXTS = /\.(mp4|mov|webm)$/i;

export interface FamilyOutputArtifact {
  runId: string;
  sourceRunId?: string;
  path: string;
  sizeBytes?: number;
}

export interface FamilyOutputRunSummary {
  runId: string;
  lane: RunLane;
  parentRunId?: string | null;
  createdAt: string;
  artifacts: readonly FamilyOutputArtifact[];
}

export interface FamilyOutputLedgerEntry {
  runId: string;
  artifactFootprint?: {
    count: number;
    bytes: number;
  } | null;
}

export interface FamilyOutputSnapshot<
  Run extends FamilyOutputRunSummary = FamilyObservabilityRunSummary,
> {
  runs: readonly Run[];
  evidence: readonly FamilyOutputArtifact[];
  familyChangeLedger?: {
    entries: readonly FamilyOutputLedgerEntry[];
  } | null;
}

export interface RunArtifactFootprint {
  count: number;
  bytes: number;
}

export interface OutputRunSummary<
  Run extends FamilyOutputRunSummary = FamilyObservabilityRunSummary,
> {
  run: Run;
  artifactCount: number;
  artifactBytes: number;
  evidenceCount: number;
}

export interface OutputComparisonPair<
  Run extends FamilyOutputRunSummary = FamilyObservabilityRunSummary,
> {
  baseline: Run;
  replay: Run;
}

export interface ResultPackageArtifactSnapshot {
  familyId: string;
  runs: ReadonlyArray<Pick<FamilyObservabilityRunSummary, 'artifacts' | 'runId'>>;
}

export function evidenceForOutputRun(
  snapshot: Pick<FamilyOutputSnapshot, 'evidence'>,
  run: Pick<FamilyOutputRunSummary, 'runId'>,
): FamilyOutputArtifact[] {
  return snapshot.evidence.filter((artifact) => {
    const sourceRunId = artifact.sourceRunId ?? artifact.runId;
    return sourceRunId === run.runId;
  });
}

export function evidenceSummary(
  snapshot: Pick<FamilyOutputSnapshot, 'evidence'>,
  run: Pick<FamilyOutputRunSummary, 'runId'>,
): string {
  const artifacts = evidenceForOutputRun(snapshot, run);
  if (artifacts.length === 0) return 'no evidence';
  const images = artifacts.filter((artifact) => OUTPUT_IMAGE_EXTS.test(artifact.path)).length;
  const videos = artifacts.filter((artifact) => OUTPUT_VIDEO_EXTS.test(artifact.path)).length;
  const reports = artifacts.filter((artifact) =>
    /report|summary|manifest|coverage|quality/i.test(artifact.path),
  ).length;
  return [
    `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`,
    images ? `${images} img` : '',
    videos ? `${videos} video` : '',
    reports ? `${reports} docs` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function ledgerEntryForRun(
  snapshot: Pick<FamilyOutputSnapshot, 'familyChangeLedger'>,
  runId: string,
): FamilyOutputLedgerEntry | undefined {
  return snapshot.familyChangeLedger?.entries.find((entry) => entry.runId === runId);
}

export function runArtifactFootprint(
  snapshot: Pick<FamilyOutputSnapshot, 'evidence' | 'familyChangeLedger'>,
  run: Pick<FamilyOutputRunSummary, 'runId' | 'artifacts'>,
): RunArtifactFootprint {
  const ledgerFootprint = ledgerEntryForRun(snapshot, run.runId)?.artifactFootprint;
  if (ledgerFootprint) {
    return { count: ledgerFootprint.count, bytes: ledgerFootprint.bytes };
  }
  if (run.artifacts.length > 0) {
    return {
      count: run.artifacts.length,
      bytes: run.artifacts.reduce((sum, artifact) => sum + (artifact.sizeBytes ?? 0), 0),
    };
  }
  const evidence = evidenceForOutputRun(snapshot, run);
  return {
    count: evidence.length,
    bytes: evidence.reduce((sum, artifact) => sum + (artifact.sizeBytes ?? 0), 0),
  };
}

export function outputSummaryForRun<Run extends FamilyOutputRunSummary>(
  snapshot: Pick<FamilyOutputSnapshot<Run>, 'evidence' | 'familyChangeLedger'>,
  run: Run,
): OutputRunSummary<Run> {
  const footprint = runArtifactFootprint(snapshot, run);
  return {
    run,
    artifactCount: footprint.count,
    artifactBytes: footprint.bytes,
    evidenceCount: evidenceForOutputRun(snapshot, run).length,
  };
}

export function findOutputComparisonPair<Run extends FamilyOutputRunSummary>(
  snapshot: Pick<FamilyOutputSnapshot<Run>, 'runs'>,
  selectedRun: Run | null,
): OutputComparisonPair<Run> | null {
  if (!selectedRun) return null;
  const runs = snapshot.runs;
  if (selectedRun.lane === 'comparison' && selectedRun.parentRunId) {
    const baseline = runs.find((run) => run.runId === selectedRun.parentRunId);
    if (baseline) return { baseline, replay: selectedRun };
  }
  const directChildren = runs
    .filter((run) => run.lane === 'comparison' && run.parentRunId === selectedRun.runId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (directChildren[0]) return { baseline: selectedRun, replay: directChildren[0] };
  return null;
}

export function resultPackageAxisLabel(pkg: Pick<ResultPackageProjection, 'axes'>): string {
  const axes = pkg.axes;
  const template =
    axes?.template?.hash ??
    axes?.template?.version ??
    axes?.template?.path ??
    axes?.template?.name ??
    'template —';
  const runner = axes?.runner?.name ?? axes?.runner?.version ?? axes?.runner?.ref ?? 'runner —';
  const model = axes?.actualModel?.name ?? axes?.model?.name ?? axes?.model?.version ?? 'model —';
  return `${template} · ${runner}/${model}`;
}

export function resultPackageDiffLabel(pkg: Pick<ResultPackageProjection, 'diff'>): string {
  return pkg.diff.available
    ? `${pkg.diff.files} files · +${pkg.diff.additions} -${pkg.diff.deletions}`
    : (pkg.diff.missingReason ?? 'diff pending');
}

export function resultPackageDiffArtifact(
  snapshot: ResultPackageArtifactSnapshot,
  pkg: Pick<ResultPackageProjection, 'runId' | 'diff'>,
): FamilyObservabilityArtifact | null {
  if (!pkg.runId || !pkg.diff.available || !pkg.diff.artifactPath) return null;
  const existing = snapshot.runs
    .find((run) => run.runId === pkg.runId)
    ?.artifacts.find((artifact) => artifact.path === pkg.diff.artifactPath);
  return (
    existing ?? {
      runId: pkg.runId,
      familyId: snapshot.familyId,
      path: pkg.diff.artifactPath,
      purpose: 'eval-diff',
      source: 'task-artifact',
    }
  );
}

export function resultPackageEvidenceLabel(
  pkg: Pick<
    ResultPackageProjection,
    'reviewEvidenceCount' | 'validationEvidenceCount' | 'visualEvidenceCount'
  >,
): string {
  return `${pkg.validationEvidenceCount} validation · ${pkg.visualEvidenceCount} visual · ${pkg.reviewEvidenceCount} review`;
}

export function resultPackageSourceLabel(
  pkg: Pick<ResultPackageProjection, 'role' | 'source'>,
): string {
  const source = pkg.source;
  if (!source) return pkg.role === 'reference' ? 'Reference source' : 'Candidate output';
  if (source.kind === 'prior-run') return `Prior run ${source.runId.slice(0, 8)}`;
  if (source.kind === 'merged-pr') return `${source.repo}#${source.prNumber}`;
  if (source.kind === 'package') return `Package ${source.packageId.slice(0, 12)}`;
  return source.repository ? `${source.repository}@${source.ref}` : source.ref;
}

export function selectedFamilyEvalExperiment(
  snapshot: { experiments?: readonly EvalExperimentProjection[] },
  selectedExperimentKey: string,
): EvalExperimentProjection | null {
  const experiments = snapshot.experiments ?? [];
  if (experiments.length === 0) return null;
  return (
    experiments.find((entry) => entry.experimentKey === selectedExperimentKey) ??
    experiments[0] ??
    null
  );
}
