import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { pipelineStepsForRun } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';
import { buildQaTaskSection } from '../tasks/qa-input.js';

import { blindTrialEligibility } from './blind-inputs.js';
import { firstOutputFixture, proofInputFixture } from './first-output.test-support.js';
import { readEvalReviewContribution } from './judge.js';
import { freezeProofOutput, readProofOutput } from './proof-output.js';

const proof = proofInputFixture();

test('an empty product diff still has a frozen proof output, and replay refuses changed evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-proof-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await firstOutputFixture(root, makeRun({ flowType: 'qa' }));
  const blind = run.engineState!.evalExperiment!.blind!;
  blind.proof = proof;
  run.qa = proof.qa;
  const first = blind.firstOutput!;
  await writeFile(first.diffPath, '');
  first.diffSha256 = (await import('./package-store.js')).sha256Text('');
  first.diff = { ...first.diff, files: 0, additions: 0, deletions: 0 };
  first.patchId = blind.referencePatchId;
  assert.equal(blindTrialEligibility(blind).status, 'invalid');
  first.proofPackage = await freezeProofOutput(run);
  assert.ok(first.proofPackage);
  const frozen = JSON.parse(await readFile(first.proofPackage.path, 'utf8'));
  assert.deepEqual(frozen.missing, ['artifacts/qa-result.json']);
  assert.equal(blindTrialEligibility(blind).status, 'eligible');
  assert.equal((await readEvalReviewContribution(run)).diffText, '');
  await writeFile(path.join(root, 'task/artifacts/report.md'), 'later repair');
  await assert.rejects(readProofOutput(run), /Frozen proof artifact changed/);
  await assert.rejects(readEvalReviewContribution(run), /Frozen proof artifact changed/);
});

test('proof inventories reject symbolic links rather than freezing bytes outside the task', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-proof-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await firstOutputFixture(root, makeRun({ flowType: 'qa' }));
  run.engineState!.evalExperiment!.blind!.proof = proof;
  await symlink(
    path.join(root, 'gateway/first-output.diff'),
    path.join(root, 'task/artifacts/link'),
  );
  await assert.rejects(freezeProofOutput(run), /escapes its task/);
});

test('proof QA gets a one-shot review and measurement instructions while normal QA stays unchanged', () => {
  const run = { ...makeRun({ flowType: 'qa' }), qa: proof.qa };
  const normal = buildQaTaskSection('task', run);
  assert.match(normal, /Every declared case must pass/);
  assert.ok(!pipelineStepsForRun(run).includes('review'));
  run.engineState = {
    evalExperiment: {
      experimentId: 'e',
      experimentKey: 'k',
      experimentManifestPath: 'm',
      packagePath: 'p',
      candidateStrategyFingerprint: 'f',
      trialId: 't',
      blind: {
        version: 1,
        baseSha: proof.source.headSha,
        problemDigest: 'p',
        referenceCommits: [],
        referencePatchId: 'r',
        forbiddenInputs: [],
        proof,
      },
    },
  };
  assert.match(buildQaTaskSection('task', run), /No retries are required/);
  assert.doesNotMatch(buildQaTaskSection('task', run), /Every declared case must pass/);
  assert.ok(pipelineStepsForRun(run).includes('review'));
});

test('proof metadata cannot change completion policy for an ordinary production run', async () => {
  const { planRunCreation } = await import('../methods/run.js');
  const run = { ...makeRun({ flowType: 'dev' }), qa: proof.qa };
  const root = await mkdtemp(path.join(os.tmpdir(), 'proof-policy-'));
  try {
    const fixture = await firstOutputFixture(root, run);
    fixture.engineState!.evalExperiment!.blind!.proof = proof;
    await assert.rejects(
      planRunCreation({
        project: 'fixture',
        flowType: 'dev',
        ticketOrPr: 'ordinary',
        engineState: fixture.engineState,
      }),
      /artifact-only comparison QA/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
