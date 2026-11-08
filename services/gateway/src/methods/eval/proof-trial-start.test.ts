import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { EvalExperimentManifest } from '@farmslot/protocol';

import { farmslotRoot } from '../../core/config.js';
import { proofInputFixture } from '../../evals/first-output.test-support.js';
import {
  computeExperimentKey,
  sha256Text,
  writeEvalExperimentManifest,
  writeResultPackageManifest,
} from '../../evals/package-store.js';
import { admitProofQa } from '../../evals/proof-profile.js';
import { makeEvalResultPackage } from '../../run-engine/test-fixtures.js';
import { deleteRun, getRun, updateRun } from '../../runs/store.js';
import { evalTrialStart } from '../eval.js';

test('proof trial creation admits QA and retains the supplied implementation for prepare', async (t) => {
  const project = `proof-start-${process.pid}-farm`;
  const projectRoot = path.join(farmslotRoot, 'projects', project);
  const root = await mkdtemp(path.join(os.tmpdir(), 'proof-trial-start-'));
  const previousDisableEngine = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  let runId: string | undefined;
  t.after(async () => {
    if (previousDisableEngine === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableEngine;
    if (runId && getRun(runId)) {
      updateRun(runId, { status: 'cancelled' });
      await deleteRun(runId);
    }
    await rm(projectRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(projectRoot, 'templates/worker'), { recursive: true });
  await writeFile(
    path.join(projectRoot, 'project.json'),
    JSON.stringify({
      name: project,
      qa: { profiles: [{ id: 'pr', title: 'PR QA', template_id: 'qa/default' }] },
      execution_templates: { sources: [] },
    }),
  );
  await writeFile(
    path.join(projectRoot, 'templates/worker/qa.md'),
    '---\nid: qa/default\nflow: qa\nplatforms: [cli]\n---\n\n# QA\n\n- [ ] Record observed proof.\n',
  );
  const diff =
    'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+fixed\n';
  const proof = {
    ...proofInputFixture(),
    ...(await admitProofQa({
      project,
      taskProfile: 'proof',
      source: { kind: 'git-ref', ref: 'main' },
      qaProfileId: 'pr',
    })),
  };
  proof.source.diffSha256 = sha256Text(diff);
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts);
  await writeFile(path.join(artifacts, 'reference.diff'), diff);
  const referencePackagePath = path.join(artifacts, 'reference.json');
  const reference = await writeResultPackageManifest(
    referencePackagePath,
    makeEvalResultPackage({
      project,
      taskProfile: 'proof',
      role: 'reference',
      proof,
      source: {
        kind: 'merged-pr',
        repo: 'owner/repo',
        prNumber: 1,
        mergeCommitSha: proof.source.headSha,
      },
      diff: {
        source: 'artifact',
        available: true,
        files: 1,
        additions: 1,
        deletions: 1,
        kind: 'contribution',
        baseSha: proof.source.baseSha,
        headSha: proof.source.headSha,
        artifactPath: 'artifacts/reference.diff',
      },
    }),
  );
  const objectiveHash = sha256Text('Observe the supplied behavior');
  const experimentKey = computeExperimentKey({
    project,
    source: reference.source,
    taskProfile: 'proof',
    proof,
    objectiveHash,
    rubricId: 'eval-default',
    rubricVersion: '1',
  });
  const manifest: EvalExperimentManifest = {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'proof-start',
    experimentKey,
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
    project,
    familyId: `proof-family-${process.pid}`,
    case: {
      caseId: 'supplied-change',
      taskProfile: 'proof',
      source: reference.source,
      proof,
      objectiveHash,
      problemStatement: 'Observe the supplied behavior',
      referencePackageId: reference.packageId,
      referencePackageHash: reference.packageHash,
      referencePackagePath,
    },
    rubric: {
      taskProfile: 'proof',
      rubricId: 'eval-default',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: [],
    trials: [],
    missingData: [],
  };
  const experimentManifestPath = path.join(artifacts, 'experiment-manifest.json');
  await writeEvalExperimentManifest(experimentManifestPath, manifest);
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const result = await evalTrialStart(
    { project, experimentManifestPath, axes: {}, runner: 'codex', model: 'gpt-6.1-sol' },
    () => {},
    {
      afterCreateSync: (run) => {
        runId = run.id;
      },
    },
  );
  assert.ok(result.run);
  assert.equal(result.run.flowType, 'qa');
  assert.equal(
    result.run.startRef,
    null,
    'QA source is frozen internally rather than a caller comparison startRef',
  );
  assert.deepEqual(result.run.qaSource, {
    baseSha: proof.source.baseSha,
    headSha: proof.source.headSha,
  });
  assert.equal(result.run.engineState?.evalExperiment?.blind?.baseSha, proof.source.headSha);
  assert.equal(result.candidatePackage.productRef?.requestedRef, proof.source.headSha);
  assert.deepEqual(result.run.qa, proof.qa);
  assert.equal(result.run.lane, 'comparison');
  assert.equal(result.run.completionPolicy, 'artifact-only');
});
