// eval-experiments.ts — Family observability projection of eval experiment packages

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  evalComparisonEligibility,
  type EvalExperimentManifest,
  type EvalExperimentProjection,
  type EvalPackageSource,
  type EvalPackageSourceBacklink,
  isEvalExperimentManifest,
  type ResultPackageProjection,
  type Run,
} from '@farmslot/protocol';

import { EVAL_TASK_FLOW, projectTaskRoots } from '../core/config.js';
import {
  EXPERIMENT_MANIFEST_FILENAME,
  fileExists,
  readResultPackageManifest,
} from '../evals/package-store.js';
import {
  readOptionalRetainedRunText,
  retainedRunTaskDirectory,
} from '../run-completion/retained-artifacts.js';

const EXPERIMENT_MANIFEST_RELATIVE_PATH = `artifacts/${EXPERIMENT_MANIFEST_FILENAME}` as const;

function sourceBacklinksForSource(
  source: EvalPackageSource | undefined,
): EvalPackageSourceBacklink[] {
  if (!source) return [];
  switch (source.kind) {
    case 'prior-run':
      return [
        { kind: 'run', runId: source.runId },
        ...(source.familyId ? [{ kind: 'family' as const, familyId: source.familyId }] : []),
      ];
    case 'merged-pr':
      return [{ kind: 'github-pr', repo: source.repo, prNumber: source.prNumber, url: source.url }];
    case 'package':
      return [{ kind: 'package', packageId: source.packageId, packagePath: source.packagePath }];
    case 'git-ref':
      return [
        {
          kind: 'git-ref',
          ref: source.ref,
          repository: source.repository,
          headSha: source.headSha,
        },
      ];
  }
}

async function experimentManifestProjection(
  manifest: EvalExperimentManifest,
  manifestPath: string,
): Promise<EvalExperimentProjection> {
  const packages: ResultPackageProjection[] = [];
  const addPackageProjection = async (input: {
    role: ResultPackageProjection['role'];
    label?: string;
    packageId: string;
    packageHash: string;
    packagePath: string;
    runId?: string;
    caseId?: string;
    strategyId?: string;
    trialId?: string;
    candidateStrategyFingerprint?: string;
    axes?: ResultPackageProjection['axes'];
    source?: EvalPackageSource;
  }): Promise<void> => {
    const fallback = (
      missingReason: string,
      missingData: string[],
      source?: EvalPackageSource,
    ): ResultPackageProjection => ({
      caseId: input.caseId,
      strategyId: input.strategyId,
      trialId: input.trialId,
      role: input.role,
      label: input.label,
      packageId: input.packageId,
      packageHash: input.packageHash,
      packagePath: input.packagePath,
      runId: input.runId,
      source,
      sourceBacklinks: sourceBacklinksForSource(source),
      candidateStrategyFingerprint: input.candidateStrategyFingerprint,
      axes: input.axes,
      comparisonEligibility: { status: 'invalid', reason: missingReason },
      status: 'draft',
      diff: {
        source: 'unavailable',
        available: false,
        files: 0,
        additions: 0,
        deletions: 0,
        kind: 'contribution',
        missingReason,
      },
      validationEvidenceCount: 0,
      visualEvidenceCount: 0,
      reviewEvidenceCount: 0,
      missingData,
    });
    if (!input.packagePath) {
      packages.push(
        fallback('result-package-path-missing', ['result-package-path-missing'], input.source),
      );
      return;
    }
    if (!(await fileExists(input.packagePath))) {
      packages.push(fallback('result-package-missing', ['result-package-missing'], input.source));
      return;
    }

    let pkg: Awaited<ReturnType<typeof readResultPackageManifest>>;
    try {
      pkg = await readResultPackageManifest(input.packagePath);
    } catch (err) {
      // Result packages are operator-visible artifacts. A malformed package should
      // degrade the snapshot with explicit missingData instead of hiding the whole family.
      const message = (err as Error).message.slice(0, 200);
      console.warn(
        `[family-observability] invalid result package at ${input.packagePath}: ${message}`,
      );
      packages.push(
        fallback(
          'result-package-invalid',
          ['result-package-invalid', `result-package-invalid:${message}`],
          input.source,
        ),
      );
      return;
    }
    const consistencyMissingData = new Set<string>(pkg.missingData);
    if (input.role === 'reference' && pkg.role !== 'reference') {
      consistencyMissingData.add('reference-package-role-mismatch');
    }
    if (input.role === 'candidate') {
      if (pkg.role !== 'candidate') consistencyMissingData.add('candidate-package-trial-mismatch');
      if (input.packageId && pkg.packageId !== input.packageId)
        consistencyMissingData.add('candidate-package-trial-mismatch');
      if (
        input.packageHash &&
        input.packageHash !== 'pending' &&
        pkg.packageHash !== input.packageHash
      )
        consistencyMissingData.add('candidate-package-trial-mismatch');
    }
    packages.push({
      caseId: input.caseId,
      strategyId: input.strategyId,
      trialId: input.trialId,
      role: input.role,
      label: input.label,
      packageId: input.packageId,
      packageHash: input.packageHash,
      packagePath: input.packagePath,
      runId: input.runId,
      source: pkg.source,
      sourceBacklinks: sourceBacklinksForSource(pkg.source),
      candidateStrategyFingerprint: input.candidateStrategyFingerprint,
      axes: input.axes ?? pkg.axes,
      comparisonEligibility: evalComparisonEligibility({ ...pkg, role: input.role }),
      status: pkg.status,
      diff: pkg.diff,
      metrics: pkg.metrics,
      visualEvidenceCount: pkg.visualEvidence.length,
      validationEvidenceCount: pkg.validationEvidence.length,
      reviewEvidenceCount: pkg.reviewEvidence.length,
      missingData: [...consistencyMissingData],
    });
  };

  await addPackageProjection({
    caseId: manifest.case.caseId,
    role: 'reference',
    label: manifest.case.label ?? 'reference',
    packageId: manifest.case.referencePackageId,
    packageHash: manifest.case.referencePackageHash,
    packagePath: manifest.case.referencePackagePath,
    source: manifest.case.source,
  });

  const strategiesById = new Map(
    manifest.candidateStrategies.map((strategy) => [strategy.strategyId, strategy]),
  );
  for (const trial of manifest.trials) {
    const strategy = strategiesById.get(trial.strategyId);
    await addPackageProjection({
      caseId: trial.caseId,
      strategyId: trial.strategyId,
      trialId: trial.trialId,
      role: 'candidate',
      label: strategy?.label,
      packageId: trial.packageId ?? trial.trialId,
      packageHash: trial.packageHash ?? 'pending',
      packagePath: trial.packagePath ?? '',
      runId: trial.runId,
      candidateStrategyFingerprint: strategy?.candidateStrategyFingerprint,
      axes: strategy?.axes,
    });
  }

  const missingData = [
    ...new Set([...manifest.missingData, ...packages.flatMap((pkg) => pkg.missingData)]),
  ];
  return {
    experimentId: manifest.experimentId,
    experimentKey: manifest.experimentKey,
    familyId: manifest.familyId,
    taskProfile: manifest.case.taskProfile,
    rubricId: manifest.rubric.rubricId,
    rubricVersion: manifest.rubric.rubricVersion,
    case: manifest.case,
    candidateStrategies: manifest.candidateStrategies,
    trials: manifest.trials,
    packages,
    missingData,
    manifestPath,
  };
}

interface ManifestEntry {
  manifest: EvalExperimentManifest;
  manifestPath: string;
}

/** One manifest per experiment key: the newest, or the first seen on a tie. */
function keepNewest(entries: Map<string, ManifestEntry>, entry: ManifestEntry): void {
  const existing = entries.get(entry.manifest.experimentKey);
  if (!existing || existing.manifest.updatedAt < entry.manifest.updatedAt)
    entries.set(entry.manifest.experimentKey, entry);
}

async function projectManifests(
  entries: Map<string, ManifestEntry>,
): Promise<EvalExperimentProjection[]> {
  const projections = await Promise.all(
    [...entries.values()].map(({ manifest, manifestPath }) =>
      experimentManifestProjection(manifest, manifestPath),
    ),
  );
  return projections.sort((a, b) => a.experimentId.localeCompare(b.experimentId));
}

export async function buildEvalExperimentProjections(
  familyRuns: Run[],
): Promise<EvalExperimentProjection[]> {
  const byEvalKey = new Map<string, ManifestEntry>();
  for (const run of familyRuns) {
    const canonical = run.engineState?.evalExperiment?.experimentManifestPath;
    let raw: string | undefined;
    let manifestPath: string;
    if (canonical && (await fileExists(canonical))) {
      raw = await readFile(canonical, 'utf8');
      manifestPath = canonical;
    } else {
      if (!run.taskFile) continue;
      raw = await readOptionalRetainedRunText(run, EXPERIMENT_MANIFEST_RELATIVE_PATH);
      if (raw === undefined) continue;
      manifestPath = path.join(
        await retainedRunTaskDirectory(run),
        EXPERIMENT_MANIFEST_RELATIVE_PATH,
      );
    }
    const parsed = JSON.parse(raw);
    if (!isEvalExperimentManifest(parsed)) continue;
    keepNewest(byEvalKey, { manifest: parsed, manifestPath });
  }
  return projectManifests(byEvalKey);
}

/**
 * A family whose experiments have no runs yet is reachable only through the
 * projects' eval roots: `<task root>/evals/<case>/artifacts/experiment-manifest.json`.
 */
export async function findReferenceOnlyExperiments(
  familyId: string,
  project?: string,
  roots?: Awaited<ReturnType<typeof projectTaskRoots>>,
): Promise<{ project: string; experiments: EvalExperimentProjection[] } | null> {
  const byEvalKey = new Map<string, ManifestEntry>();
  for (const { project: rootProject, root } of roots ?? (await projectTaskRoots())) {
    if (project && rootProject !== project) continue;
    let cases: string[];
    try {
      cases = await readdir(path.join(root, EVAL_TASK_FLOW));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const name of cases) {
      const manifestPath = path.join(root, EVAL_TASK_FLOW, name, EXPERIMENT_MANIFEST_RELATIVE_PATH);
      if (!(await fileExists(manifestPath))) continue;
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (isEvalExperimentManifest(parsed) && parsed.familyId === familyId)
        keepNewest(byEvalKey, { manifest: parsed, manifestPath });
    }
  }
  const [newest] = [...byEvalKey.values()].sort((a, b) =>
    b.manifest.updatedAt.localeCompare(a.manifest.updatedAt),
  );
  return newest
    ? { project: newest.manifest.project, experiments: await projectManifests(byEvalKey) }
    : null;
}
