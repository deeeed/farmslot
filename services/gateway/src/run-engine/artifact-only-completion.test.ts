import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtifactOnlyTrial } from './artifact-only-completion.test-support.js';

await import('../runtime/mock-pty.test-support.js');
const { failRunOutputCapture } = await import('../run-completion/output.js');
const { retainedRunTaskDirectory } = await import('../run-completion/retained-artifacts.js');
const { getRun, updateRun } = await import('../runs/store.js');
const { collectRunGateReadiness } = await import('./gate-prerequisites.js');
const { deleteTestRunIfPresent } = await import('./test-fixtures.js');

async function trial(t: test.TestContext) {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'artifact-only-completion-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const result = await createArtifactOnlyTrial(taskDir);
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
