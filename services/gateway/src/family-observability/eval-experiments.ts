// eval-experiments.ts — Family observability projection of eval experiment packages

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type EvalExperimentManifest,
  type EvalExperimentProjection,
  type EvalPackageSource,
  type EvalPackageSourceBacklink,
  isEvalExperimentManifest,
  type ResultPackageProjection,
  type Run,
} from '@farmslot/protocol';

import {
  EXPERIMENT_MANIFEST_FILENAME,
  fileExists,
  readResultPackageManifest,
} from '../evals/package-store.js';

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

export async function buildEvalExperimentProjections(
  familyRuns: Run[],
): Promise<EvalExperimentProjection[]> {
  const byEvalKey = new Map<string, { projection: EvalExperimentProjection; updatedAt: string }>();
  for (const run of familyRuns) {
    if (!run.taskFile) continue;
    const manifestPath = path.join(path.dirname(run.taskFile), EXPERIMENT_MANIFEST_RELATIVE_PATH);
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const parsed = JSON.parse(raw);
    if (!isEvalExperimentManifest(parsed)) continue;
    const existing = byEvalKey.get(parsed.experimentKey);
    if (existing && existing.updatedAt >= parsed.updatedAt) continue;
    byEvalKey.set(parsed.experimentKey, {
      projection: await experimentManifestProjection(parsed, manifestPath),
      updatedAt: parsed.updatedAt,
    });
  }
  return [...byEvalKey.values()]
    .map((entry) => entry.projection)
    .sort((a, b) => a.experimentId.localeCompare(b.experimentId));
}
