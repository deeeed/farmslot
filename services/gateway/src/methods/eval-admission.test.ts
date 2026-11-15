import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { EvalExperimentManifest, Run, RunCreateParams } from '@farmslot/protocol';

import { writeEvalExperimentManifest, writeResultPackageManifest } from '../evals/package-store.js';
import { makeEvalResultPackage, makeRun } from '../run-engine/test-fixtures.js';

import type { runCreate } from './run.js';

let created: Run | undefined;
const requests: RunCreateParams[] = [];
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => created,
    updateRun: (_id: string, patch: Partial<Run>) => {
      assert(created);
      return (created = { ...created, ...patch });
    },
  },
});
const create: typeof runCreate = async (params, _emit, options) => {
  requests.push(params);
  created = makeRun({
    id: 'admission-fixture',
    prNumber: undefined,
    flowType: params.flowType,
    project: params.project,
    familyId: params.familyId,
    ticketOrPr: params.ticketOrPr,
    branch: params.branch,
    mode: params.mode,
    lane: params.lane,
    completionPolicy: params.completionPolicy,
    engineState: params.engineState,
    ticketData: params.ticketData,
    startRef: params.startRef
      ? { requestedRef: params.startRef, source: params.startRefSource ?? { kind: 'manual' } }
      : undefined,
  });
  options?.afterCreateSync?.(created);
  return { run: created };
};
const methods = await import('./run.js');
mock.module('./run.js', { namedExports: { ...methods, runCreate: create } });
const admissionOwner: string = './eval.js?normal-slot-admission-test';
const { evalTrialStart }: typeof import('./eval.js') = await import(admissionOwner);

test('new before-fix admission keeps neutral identity, frozen base and candidate hash without a capsule', async (t) => {
  const previous = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previous;
  });
  const root = await mkdtemp(path.join(tmpdir(), 'eval-normal-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseSha = 'a'.repeat(40),
    headSha = 'b'.repeat(40);
  const diff =
    'diff --git a/value.ts b/value.ts\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-old\n+fixed\n';
  await writeFile(path.join(root, 'reference.diff'), diff);
  const referencePackagePath = path.join(root, 'reference.json');
  const reference = await writeResultPackageManifest(
    referencePackagePath,
    makeEvalResultPackage({
      project: 'farmslot-farm',
      role: 'reference',
      taskProfile: 'fix-bug',
      source: { kind: 'git-ref', repository: 'owner/repo', ref: headSha, baseSha },
      baseline: { source: 'local-git', baseSha, capturedAt: 'now' },
      head: { source: 'local-git', headSha, capturedAt: 'now' },
      diff: {
        source: 'artifact',
        available: true,
        kind: 'contribution',
        baseSha,
        headSha,
        files: 1,
        additions: 1,
        deletions: 1,
        artifactPath: 'reference.diff',
      },
    }),
  );
  const manifest: EvalExperimentManifest = {
    version: 1,
    kind: 'eval-experiment',
    experimentId: 'normal-admission',
    experimentKey: 'normal-admission',
    createdAt: 'now',
    updatedAt: 'now',
    project: 'farmslot-farm',
    familyId: 'admission-family',
    case: {
      caseId: 'case',
      source: reference.source,
      taskProfile: 'fix-bug',
      objectiveHash: 'objective',
      problemStatement: 'Fix the value.\n\n## Acceptance criteria\n- The value is correct.',
      referencePackageId: reference.packageId,
      referencePackageHash: reference.packageHash,
      referencePackagePath,
    },
    rubric: {
      taskProfile: 'fix-bug',
      rubricId: 'default',
      rubricVersion: '1',
      requiredEvidence: [],
    },
    candidateStrategies: [],
    trials: [],
    missingData: [],
  };
  const experimentManifestPath = path.join(root, 'artifacts', 'experiment.json');
  await writeEvalExperimentManifest(experimentManifestPath, manifest);
  const content = '# Trial candidate\n\n- [ ] Fix the value.\n';
  const candidateTemplatePath = path.join(root, 'candidate.md');
  await writeFile(candidateTemplatePath, content);
  const result = await evalTrialStart(
    {
      project: 'farmslot-farm',
      experimentManifestPath,
      axes: {},
      candidateTemplatePath,
      review: false,
    },
    () => {},
  );
  assert.equal(requests.length, 1, 'run creation is a recorded boundary, not a dispatched run');
  const request = requests[0];
  assert.equal(request.engineState?.evalExperiment?.blind?.executionPolicy, 'normal-slot');
  assert.equal(request.engineState?.evalExperiment?.blind?.isolation, undefined);
  assert.match(request.ticketOrPr, /^EVAL-/);
  assert.equal(request.mode, 'autonomous');
  assert.equal(request.startRef, baseSha);
  assert.equal(request.completionPolicy, 'artifact-only');
  assert.deepEqual(request.ticketData?.acceptanceCriteria, ['The value is correct.']);
  const hash = createHash('sha256').update(content).digest('hex');
  assert.equal(result.candidatePackage.axes.template?.hash, hash);
  const snapshot = request.engineState?.evalExperiment?.candidateTemplate?.path;
  assert(snapshot);
  assert.equal(await readFile(snapshot, 'utf8'), content);
});
