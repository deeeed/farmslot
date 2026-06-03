import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type EvalEvidenceRequirement,
  type EvalExperimentManifest,
  type EvalMedia,
  type EvalPackageAxes,
  type EvalPackageSource,
  type EvalTaskProfile,
  type FamilyDiffProvenance,
  type FamilyObservabilityArtifact,
  isEvalExperimentManifest,
  isFamilyDiffProvenance,
  isResultPackageManifest,
  type ResultPackageManifest,
  type ResultPackageMetrics,
  type Run,
  type TemplateProvenance,
} from '@farmslot/protocol';

import { inferArtifactPurpose } from '../core/index.js';
import { TEMPLATE_PROVENANCE_INPUT } from '../tasks/writer.js';

export const EXPERIMENT_MANIFEST_FILENAME = 'experiment-manifest.json';
export const RESULT_PACKAGE_DIR = 'packages';
export const REFERENCE_PACKAGE_FILENAME = 'reference.result-package.json';
export const CANDIDATE_PACKAGE_FILENAME = 'candidate.result-package.json';
export const MAX_RESULT_PACKAGE_ARTIFACT_SCAN_FILES = 2000;
export const MAX_RESULT_PACKAGE_ARTIFACT_SCAN_DEPTH = 8;

const GATEWAY_OWNED_ARTIFACTS = new Set([
  `artifacts/${EXPERIMENT_MANIFEST_FILENAME}`,
  `artifacts/${RESULT_PACKAGE_DIR}/${REFERENCE_PACKAGE_FILENAME}`,
  `artifacts/${RESULT_PACKAGE_DIR}/${CANDIDATE_PACKAGE_FILENAME}`,
]);

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

function canonicalSource(source: EvalPackageSource): Record<string, unknown> {
  if (source.kind === 'merged-pr') {
    return {
      kind: source.kind,
      repo: source.repo.toLowerCase(),
      prNumber: source.prNumber,
      mergeCommitSha: source.mergeCommitSha ?? null,
      headSha: source.headSha ?? null,
      baseRef: source.baseRef ?? null,
      headRef: source.headRef ?? null,
    };
  }
  if (source.kind === 'prior-run') {
    return {
      kind: source.kind,
      runId: source.runId,
      familyId: source.familyId ?? null,
    };
  }
  if (source.kind === 'package') {
    return {
      kind: source.kind,
      packageId: source.packageId,
      packageHash: source.packageHash ?? null,
    };
  }
  return {
    kind: source.kind,
    ref: source.ref,
    repository: source.repository?.toLowerCase() ?? null,
    baseRef: source.baseRef ?? null,
    baseSha: source.baseSha ?? null,
    headRef: source.headRef ?? null,
    headSha: source.headSha ?? null,
  };
}

export function computeExperimentKey(input: {
  project: string;
  source: EvalPackageSource;
  taskProfile: EvalTaskProfile;
  objectiveHash: string;
  rubricId: string;
  rubricVersion: string;
  /**
   * Grouping metadata only. Dataset membership must not fork the single-case
   * experiment identity; local experiments from pre-PR #78 branches that
   * included datasetId in this key should be recreated instead of reconciled.
   */
  datasetId?: string;
  datasetItemId?: string;
}): string {
  return sha256Text(
    stableJson({
      kind: 'eval-experiment-key-v1',
      project: input.project,
      source: canonicalSource(input.source),
      taskProfile: input.taskProfile,
      objectiveHash: input.objectiveHash,
      rubricId: input.rubricId,
      rubricVersion: input.rubricVersion,
      datasetItemId: input.datasetItemId ?? null,
    }),
  );
}

export function computeObjectiveHash(input: {
  project: string;
  source: EvalPackageSource;
  taskProfile: EvalTaskProfile;
  objective?: string;
}): string {
  return sha256Text(
    stableJson({
      kind: 'eval-objective-v1',
      project: input.project,
      source: canonicalSource(input.source),
      taskProfile: input.taskProfile,
      objective: input.objective?.trim() || null,
    }),
  );
}

export function computeCandidateStrategyFingerprint(input: {
  axes: EvalPackageAxes;
  source?: EvalPackageSource;
  startRef?: string;
  taskProfile: EvalTaskProfile;
}): string {
  return sha256Text(
    stableJson({
      kind: 'candidate-strategy-v1',
      axes: input.axes,
      source: input.source ? canonicalSource(input.source) : null,
      startRef: input.startRef?.trim() || null,
      taskProfile: input.taskProfile,
    }),
  );
}

export function packageIdFor(input: {
  experimentKey: string;
  role: 'reference' | 'candidate';
  candidateStrategyFingerprint?: string;
  trialId?: string;
}): string {
  return `pkg-${sha256Text(
    stableJson({
      kind: 'result-package-id-v1',
      experimentKey: input.experimentKey,
      role: input.role,
      candidateStrategyFingerprint: input.candidateStrategyFingerprint ?? null,
      trialId: input.trialId ?? null,
    }),
  ).slice(0, 20)}`;
}

function canonicalDiffForPackageHash(diff: FamilyDiffProvenance): FamilyDiffProvenance {
  const { capturedAt: _capturedAt, ...stableDiff } = diff;
  return stableDiff;
}

function canonicalCommitForPackageHash(
  commit: ResultPackageManifest['baseline'],
): ResultPackageManifest['baseline'] {
  if (!commit) return commit;
  const { capturedAt: _capturedAt, ...stableCommit } = commit;
  return stableCommit as ResultPackageManifest['baseline'];
}

function packageHashPayload(manifest: ResultPackageManifest): Record<string, unknown> {
  const {
    packageHash: _packageHash,
    createdAt: _createdAt,
    finalizedAt: _finalizedAt,
    ...stable
  } = manifest;
  return {
    ...stable,
    source: canonicalSource(stable.source),
    baseline: canonicalCommitForPackageHash(stable.baseline),
    head: canonicalCommitForPackageHash(stable.head),
    diff: canonicalDiffForPackageHash(stable.diff),
  };
}

export function computePackageHash(manifest: ResultPackageManifest): string {
  return sha256Text(
    stableJson({ kind: 'result-package-hash-v1', manifest: packageHashPayload(manifest) }),
  );
}

export function withPackageHash(
  manifest: Omit<ResultPackageManifest, 'packageHash'> & { packageHash?: string },
): ResultPackageManifest {
  const withPlaceholder: ResultPackageManifest = {
    ...manifest,
    packageHash: manifest.packageHash ?? '',
  };
  return { ...withPlaceholder, packageHash: computePackageHash(withPlaceholder) };
}

export function unavailableDiff(
  missingReason: string,
  extra: Partial<FamilyDiffProvenance> = {},
): FamilyDiffProvenance {
  return {
    source: 'unavailable',
    available: false,
    files: 0,
    additions: 0,
    deletions: 0,
    kind: 'contribution',
    missingReason,
    capturedAt: new Date().toISOString(),
    ...extra,
  };
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function readEvalExperimentManifest(
  filePath: string,
): Promise<EvalExperimentManifest> {
  const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as unknown;
  if (!isEvalExperimentManifest(parsed)) throw new Error(`Invalid eval manifest: ${filePath}`);
  return parsed;
}

export async function writeEvalExperimentManifest(
  filePath: string,
  manifest: EvalExperimentManifest,
): Promise<void> {
  if (!isEvalExperimentManifest(manifest))
    throw new Error(`Refusing to write invalid eval manifest: ${filePath}`);
  await writeJsonFile(filePath, manifest);
}

export async function readResultPackageManifest(filePath: string): Promise<ResultPackageManifest> {
  const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as unknown;
  if (!isResultPackageManifest(parsed))
    throw new Error(`Invalid result package manifest: ${filePath}`);
  return parsed;
}

export async function writeResultPackageManifest(
  filePath: string,
  manifest: ResultPackageManifest,
): Promise<ResultPackageManifest> {
  const withHash = withPackageHash(manifest);
  if (!isResultPackageManifest(withHash))
    throw new Error(`Refusing to write invalid result package manifest: ${filePath}`);
  await writeJsonFile(filePath, withHash);
  return withHash;
}

export async function readTaskDiffProvenance(
  taskDir: string,
  fallbackReason: string,
): Promise<FamilyDiffProvenance> {
  const filePath = path.join(taskDir, 'artifacts', 'diff-stat.json');
  if (!existsSync(filePath)) return unavailableDiff(fallbackReason);
  const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as unknown;
  if (!isFamilyDiffProvenance(parsed)) return unavailableDiff('invalid-diff-stat-artifact');
  return parsed;
}

export async function scanResultPackageArtifacts(
  taskDir: string,
  run: Pick<Run, 'id' | 'familyId'>,
): Promise<FamilyObservabilityArtifact[]> {
  const artifactsDir = path.join(taskDir, 'artifacts');
  if (!existsSync(artifactsDir)) return [];

  const refs: FamilyObservabilityArtifact[] = [];
  async function walk(dir: string, prefix: string, depth = 0): Promise<void> {
    if (
      refs.length >= MAX_RESULT_PACKAGE_ARTIFACT_SCAN_FILES ||
      depth > MAX_RESULT_PACKAGE_ARTIFACT_SCAN_DEPTH
    )
      return;
    const entries = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      if (refs.length >= MAX_RESULT_PACKAGE_ARTIFACT_SCAN_FILES) return;
      const full = path.join(dir, name);
      const s = await stat(full);
      if (s.isDirectory()) {
        await walk(full, `${prefix}${name}/`, depth + 1);
        continue;
      }
      if (!s.isFile()) continue;
      const relativePath = `artifacts/${prefix}${name}`;
      if (GATEWAY_OWNED_ARTIFACTS.has(relativePath)) continue;
      refs.push({
        runId: run.id,
        familyId: run.familyId,
        path: relativePath,
        purpose: inferArtifactPurpose(`${prefix}${name}`),
        source: 'task-artifact',
        sizeBytes: s.size,
        sha256: await sha256File(full),
      });
    }
  }

  await walk(artifactsDir, '');
  return refs.sort((a, b) => a.path.localeCompare(b.path));
}

function artifactStem(artifactPath: string): string {
  return path
    .basename(artifactPath)
    .replace(/\.[^.]+$/, '')
    .toLowerCase();
}

function mediaRoleForArtifact(artifact: FamilyObservabilityArtifact): EvalMedia['role'] | null {
  const purpose = artifact.purpose.toLowerCase();
  if (/\.(mp4|mov|webm)$/i.test(artifact.path) || purpose.includes('video')) return 'eval-video';
  if (!/\.(png|jpe?g|gif)$/i.test(artifact.path) && !purpose.includes('screenshot')) return null;
  const stem = artifactStem(artifact.path);
  if (
    purpose === 'screenshot-before' ||
    stem === 'before' ||
    stem.startsWith('before-') ||
    stem.startsWith('before_') ||
    stem.startsWith('eval-before') ||
    stem.startsWith('baseline')
  )
    return 'eval-before';
  return 'eval-after';
}

export function visualEvidenceFromArtifacts(
  artifacts: FamilyObservabilityArtifact[],
  run: Pick<Run, 'id'>,
): EvalMedia[] {
  return artifacts.flatMap((artifact) => {
    const role = mediaRoleForArtifact(artifact);
    if (!role) return [];
    return [
      {
        role,
        artifact,
        source: 'eval-run',
        sourceRunId: run.id,
      } satisfies EvalMedia,
    ];
  });
}

function metricsForRun(run: Run): ResultPackageMetrics {
  const createdAt = Date.parse(run.createdAt);
  const completedAt = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  return {
    durationMs:
      Number.isFinite(createdAt) && Number.isFinite(completedAt) && completedAt >= createdAt
        ? completedAt - createdAt
        : undefined,
    costEstimate: run.metrics.costEstimate,
    sessionTurns: run.metrics.sessionTurns,
    sessionInputTokens: run.metrics.sessionInputTokens,
    sessionOutputTokens: run.metrics.sessionOutputTokens,
    sessionTotalTokens: run.metrics.sessionTotalTokens,
  };
}

function removeMissingData(items: string[], resolved: string[]): string[] {
  const resolvedSet = new Set(resolved);
  return items.filter((item) => !resolvedSet.has(item));
}

function finalizeEvidenceRequirements(
  requirements: EvalEvidenceRequirement[] | undefined,
  input: {
    diff: FamilyDiffProvenance;
    validationEvidence: FamilyObservabilityArtifact[];
    visualEvidence: EvalMedia[];
  },
): EvalEvidenceRequirement[] | undefined {
  if (!requirements) return undefined;
  const artifactPaths = new Set(input.validationEvidence.map((artifact) => artifact.path));
  return requirements.map((requirement) => {
    if (requirement.id === 'diff' && input.diff.available) {
      return {
        ...requirement,
        state: 'present',
        artifactPaths: input.diff.artifactPath
          ? [input.diff.artifactPath]
          : requirement.artifactPaths,
      };
    }
    if (requirement.id === 'report' && artifactPaths.has('artifacts/report.md')) {
      return { ...requirement, state: 'present', artifactPaths: ['artifacts/report.md'] };
    }
    if (requirement.id === 'visuals' && input.visualEvidence.length > 0) {
      return {
        ...requirement,
        state: 'present',
        artifactPaths: input.visualEvidence.map((entry) => entry.artifact.path),
      };
    }
    return requirement;
  });
}

function isTemplateProvenanceRecord(value: unknown): value is TemplateProvenance {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === 'task-template' &&
    typeof record.templatePath === 'string' &&
    typeof record.templateName === 'string' &&
    typeof record.contentHash === 'string' &&
    typeof record.project === 'string' &&
    typeof record.renderedAt === 'string'
  );
}

async function readTemplateProvenance(taskDir: string): Promise<TemplateProvenance | null> {
  const provenancePath = path.join(taskDir, TEMPLATE_PROVENANCE_INPUT);
  if (!(await fileExists(provenancePath))) return null;
  const parsed = JSON.parse(await readFile(provenancePath, 'utf-8')) as unknown;
  if (!isTemplateProvenanceRecord(parsed))
    throw new Error(`Invalid template provenance artifact: ${provenancePath}`);
  return parsed;
}

export async function finalizeEvalResultPackageForRun(
  run: Run,
): Promise<ResultPackageManifest | null> {
  const link = run.engineState?.evalExperiment;
  if (!link) {
    const staleEvalPackage = Object.prototype.hasOwnProperty.call(
      run.engineState ?? {},
      'evalPackage',
    );
    if (staleEvalPackage) {
      throw new Error(
        `Run ${run.id} uses removed engineState.evalPackage eval schema; recreate the experiment trial with eval.trial.start`,
      );
    }
    return null;
  }
  if (!run.taskFile) return null;

  const taskDir = path.dirname(run.taskFile);
  const currentPackage = await readResultPackageManifest(link.packagePath);
  const diff = await readTaskDiffProvenance(taskDir, 'eval-diff-missing');
  const templateProvenance = await readTemplateProvenance(taskDir);
  const validationEvidence = await scanResultPackageArtifacts(taskDir, run);
  const visualEvidence = visualEvidenceFromArtifacts(validationEvidence, run);
  const missingData = removeMissingData(currentPackage.missingData, [
    'candidate-run-pending',
    ...(diff.available ? ['eval-diff-pending', 'eval-diff-missing'] : []),
    ...(validationEvidence.length > 0 ? ['validation-evidence-missing'] : []),
    ...(visualEvidence.length > 0 ? ['visual-evidence-missing'] : []),
  ]);
  if (!diff.available && !missingData.includes('eval-diff-missing'))
    missingData.push('eval-diff-missing');
  if (validationEvidence.length === 0 && !missingData.includes('validation-evidence-missing'))
    missingData.push('validation-evidence-missing');
  if (!templateProvenance && !missingData.includes('template-provenance-missing'))
    missingData.push('template-provenance-missing');

  const finalized = await writeResultPackageManifest(link.packagePath, {
    ...currentPackage,
    status: 'final',
    finalizedAt: new Date().toISOString(),
    runId: run.id,
    familyId: run.familyId,
    diff,
    axes: templateProvenance
      ? {
          ...currentPackage.axes,
          template: {
            ...currentPackage.axes.template,
            path: currentPackage.axes.template?.path ?? templateProvenance.templatePath,
            name:
              currentPackage.axes.template?.name ??
              templateProvenance.templateName.replace(/\.md$/, ''),
            hash: templateProvenance.contentHash,
            ref: templateProvenance.projectRepoHeadSha ?? currentPackage.axes.template?.ref,
          },
        }
      : currentPackage.axes,
    templateProvenance: templateProvenance ?? currentPackage.templateProvenance,
    visualEvidence,
    validationEvidence,
    evidenceRequirements: finalizeEvidenceRequirements(currentPackage.evidenceRequirements, {
      diff,
      validationEvidence,
      visualEvidence,
    }),
    metrics: metricsForRun(run),
    missingData: [...new Set(missingData)],
  });

  const experimentManifest = await readEvalExperimentManifest(link.experimentManifestPath);
  const updatedTrials = experimentManifest.trials.map((trial) => {
    if (trial.trialId !== link.trialId || trial.runId !== run.id) return trial;
    return {
      ...trial,
      status:
        run.status === 'failed' || run.status === 'cancelled'
          ? ('failed' as const)
          : ('final' as const),
      packageHash: finalized.packageHash,
      packagePath: link.packagePath,
      completedAt: new Date().toISOString(),
      missingData: finalized.missingData,
    };
  });
  await writeEvalExperimentManifest(link.experimentManifestPath, {
    ...experimentManifest,
    updatedAt: new Date().toISOString(),
    trials: updatedTrials,
  });

  const refreshedEvalExperimentManifest = await readEvalExperimentManifest(
    link.experimentManifestPath,
  );
  const taskEvalExperimentManifestPath = path.join(
    taskDir,
    'artifacts',
    EXPERIMENT_MANIFEST_FILENAME,
  );
  await writeEvalExperimentManifest(
    taskEvalExperimentManifestPath,
    refreshedEvalExperimentManifest,
  );

  return finalized;
}
