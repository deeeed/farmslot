import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtifactOnlyTrial } from './artifact-only-completion.test-support.js';

await import('../runtime/mock-pty.test-support.js');
const { captureRunOutput, failRunOutputCapture } = await import('../run-completion/output.js');
const { retainedRunTaskDirectory } = await import('../run-completion/retained-artifacts.js');
const { getRun, updateRun } = await import('../runs/store.js');
const { assertRunGateReady, collectRunGateReadiness } = await import('./gate-prerequisites.js');
const { deleteTestRunIfPresent } = await import('./test-fixtures.js');

async function trial(t: test.TestContext, proofMode: 'state' | 'review' | 'visual' = 'state') {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'artifact-only-completion-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const result = await createArtifactOnlyTrial(taskDir, 'generic-project', proofMode);
  t.after(() => deleteTestRunIfPresent(result.run.id));
  return result;
}

test('artifact-only comparison evidence completes without an output-review decision', async (t) => {
  const { run } = await trial(t);
  assert.equal(run.decisions.length, 0);
  const readiness = await collectRunGateReadiness(run, null);
  assert.equal(readiness.state, 'ready', JSON.stringify(readiness.reasons));
  assert.equal(getRun(run.id)!.decisions.length, 0);

  // A report-producing production run still requires its captured review.
  updateRun(run.id, { lane: 'production', variant: null });
  const missingReview = await collectRunGateReadiness(getRun(run.id)!, null);
  assert.ok(missingReview.reasons.some(({ message }) => /captured output review/.test(message)));
});

test('comparison readiness uses captured bytes and refuses retained evidence corruption', async (t) => {
  const { run, directory } = await trial(t);
  await writeFile(path.join(directory, 'recipe-invocation.json'), '{}');
  assert.equal((await collectRunGateReadiness(run, null)).state, 'ready');

  const retained = path.join(
    await retainedRunTaskDirectory(run),
    'artifacts/recipe-runs/proof/recipe-invocation.json',
  );
  await chmod(retained, 0o600);
  await writeFile(retained, '{}');
  const corrupted = await collectRunGateReadiness(getRun(run.id)!, null);
  assert.ok(corrupted.reasons.some(({ code }) => code === 'evidence-validation-unavailable'));
});

test('comparison readiness refuses a failed artifact capture', async (t) => {
  const { run } = await trial(t);
  failRunOutputCapture(run.id, new Error('Missing referenced video'), true);
  const failedCapture = await collectRunGateReadiness(getRun(run.id)!, null);
  assert.equal(failedCapture.state, 'not-ready');
  assert.ok(failedCapture.reasons.some(({ code }) => code === 'evidence-validation-unavailable'));
});

// F219: 0b97288d/af00ac09 passed review, then COMPLETE refused their recorded claim verdicts.
test('eval completion retains unapproved claims without requiring publication approval', async (t) => {
  const { run } = await trial(t, 'review');
  updateRun(run.id, {
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-f219',
        experimentKey: 'f219',
        experimentManifestPath: '/unused/experiment-manifest.json',
        packagePath: '/unused/candidate.result-package.json',
        candidateStrategyFingerprint: 'candidate-f219',
        trialId: 'trial-f219',
      },
    },
  });
  const current = getRun(run.id)!;
  const evalState = current.engineState;
  const readiness = await collectRunGateReadiness(current, null);
  assert.deepEqual(
    readiness.reasons.map(({ code, evidencePolicy }) => ({ code, evidencePolicy })),
    [{ code: 'evidence-policy-unsatisfied', evidencePolicy: 'claim-verdict' }],
  );
  await assert.doesNotReject(assertRunGateReady(current, null, 'complete'));
  await assert.doesNotReject(assertRunGateReady(current, null, 'finalize'));
  await assert.rejects(assertRunGateReady(current, null, 'approve-publish'), /claim verdicts/);
  // An ordinary artifact-only output is outside the eval exception.
  updateRun(run.id, { engineState: undefined });
  await assert.rejects(assertRunGateReady(getRun(run.id)!, null, 'complete'), /claim verdicts/);

  updateRun(run.id, { engineState: evalState });
  const retained = path.join(
    await retainedRunTaskDirectory(getRun(run.id)!),
    'artifacts/recipe-runs/proof/recipe-invocation.json',
  );
  await chmod(retained, 0o600);
  await writeFile(retained, '{}');
  await assert.rejects(assertRunGateReady(getRun(run.id)!, null, 'complete'), /evidence package/);
});

// F243: f74906ee kept its output review through REVIEW, then COMPLETE refused its
// awaiting-review claims, which only that output review can judge.
test('an output review judges claims awaiting review; other verdicts still refuse', async (t) => {
  const reviewed = async (proofMode: 'review' | 'visual') => {
    const { run } = await trial(t, proofMode);
    updateRun(run.id, { lane: 'validation', variant: null });
    await captureRunOutput(run.id, false, true);
    const current = getRun(run.id)!;
    assert.equal(current.decisions.filter(({ resolvedAt }) => !resolvedAt).length, 1);
    return current;
  };
  const awaiting = await reviewed('review');
  assert.deepEqual((await collectRunGateReadiness(awaiting, null)).reasons, []);
  await assert.doesNotReject(assertRunGateReady(awaiting, null, 'complete'));
  await assert.doesNotReject(assertRunGateReady(awaiting, null, 'finalize'));

  // A visual claim outside any recording is weak, not awaiting review.
  const weak = await reviewed('visual');
  await assert.rejects(assertRunGateReady(weak, null, 'complete'), /claim verdicts/);
  // A comparison trial has no output review to judge them.
  updateRun(awaiting.id, { lane: 'comparison', variant: 'candidate' });
  await assert.rejects(
    assertRunGateReady(getRun(awaiting.id)!, null, 'complete'),
    /claim verdicts/,
  );
});
