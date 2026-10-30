import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EvalExperimentManifest, Run } from '@farmslot/protocol';

import { makeEvalResultPackage } from '../run-engine/test-fixtures.js';

import {
  sha256Text,
  writeEvalExperimentManifest,
  writeResultPackageManifest,
} from './package-store.js';

/** Worker artifacts and gateway-only comparison metadata live in separate directories. */
export async function firstOutputFixture(root: string, run: Run): Promise<Run> {
  const taskDir = path.join(root, 'task');
  const gatewayDir = path.join(root, 'gateway');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await mkdir(gatewayDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# Task\n');
  await writeFile(path.join(taskDir, 'artifacts/report.md'), 'First worker report\n');
  const diffPath = path.join(gatewayDir, 'first-output.diff');
  const diffText = 'first contribution\n';
  await writeFile(diffPath, diffText);
  const baseSha = 'b'.repeat(40);
  const headSha = 'a'.repeat(40);
  const diff = {
    source: 'artifact' as const,
    available: true,
    baseSha,
    headSha,
    files: 1,
    additions: 1,
    deletions: 0,
    kind: 'contribution' as const,
  };
  const packagePath = path.join(gatewayDir, 'candidate.result-package.json');
  const draft = await writeResultPackageManifest(
    packagePath,
    makeEvalResultPackage({
      status: 'draft',
      finalizedAt: undefined,
      runId: run.id,
      familyId: run.familyId,
      axes: { review: { name: 'none' } },
    }),
  );
  const experimentManifestPath = path.join(gatewayDir, 'experiment-manifest.json');
  const manifest: EvalExperimentManifest = {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'experiment-first',
    experimentKey: 'experiment-first-key',
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    project: run.project,
    familyId: run.familyId,
    case: {
      caseId: 'case',
      source: draft.source,
      taskProfile: 'fix-bug',
      objectiveHash: draft.objectiveHash,
      referencePackageId: 'reference',
      referencePackageHash: 'reference-hash',
      referencePackagePath: 'reference.json',
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'rubric',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: [
      {
        strategyId: 'strategy',
        label: 'First output',
        candidateStrategyFingerprint: 'fingerprint',
        axes: draft.axes,
      },
    ],
    trials: [
      {
        trialId: 'trial',
        strategyId: 'strategy',
        caseId: 'case',
        status: 'running',
        packageId: draft.packageId,
        packageHash: draft.packageHash,
        packagePath,
        runId: run.id,
        missingData: [],
      },
    ],
    missingData: [],
  };
  await writeEvalExperimentManifest(experimentManifestPath, manifest);
  return {
    ...run,
    taskFile: path.join(taskDir, 'TASK.md'),
    completionPolicy: 'artifact-only',
    engineState: {
      ...run.engineState,
      evalExperiment: {
        experimentId: manifest.experimentId,
        experimentKey: manifest.experimentKey,
        experimentManifestPath,
        packagePath,
        candidateStrategyFingerprint: 'fingerprint',
        trialId: 'trial',
        blind: {
          version: 1,
          baseSha,
          problemDigest: 'problem',
          referenceCommits: ['c'.repeat(40)],
          referencePatchId: 'reference-patch',
          forbiddenInputs: [],
          isolation: {
            slotId: run.slotId ?? 'eval-slot',
            slotEpoch: 1,
            capsulePath: path.join(gatewayDir, 'capsule'),
            verifiedAt: '2026-10-30T00:00:00Z',
          },
          firstOutput: {
            headSha,
            capturedAt: '2026-10-30T00:01:00Z',
            diffPath,
            diffSha256: sha256Text(diffText),
            patchId: 'worker-patch',
            diff,
          },
        },
      },
    },
  };
}
