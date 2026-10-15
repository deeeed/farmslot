import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type {
  ReadyGatePrPackage,
  RecipeRunArtifactGroup,
  RecordedEvidencePackageInput,
  Run,
  RunDecision,
} from '@farmslot/protocol';

import { retainFixtureTask } from '../../../../../packages/run-bundle/src/retained.test-support.js';

await import('../../runtime/mock-pty.test-support.js');
const nodeRpc = await import('../../fleet/node-rpc.js');
let remote = false;
let root = '';
let hashes: Array<{ path: string; sha256: string }> = [];
const reads: string[] = [];
mock.module('../../fleet/node-rpc.js', {
  namedExports: {
    ...nodeRpc,
    assertNodeReconnectCurrent: () => assert.fail('Display must not reconnect a node'),
    isNodeTransportUnavailableError: () => false,
    waitForNode: async () => assert.fail('Display must not wait for a node'),
    getSlotLocality: async () => ({ isLocal: !remote }),
    nodeExec: async () => assert.fail('Display must not execute a remote command'),
    nodeExecArgv: async () => assert.fail('Display must not execute a remote command'),
    sendNodeRequest: async () => assert.fail('Retained display must not read a node'),
  },
});
const { readRunRecordedEvidence, retainedComparisonSnapshot } =
  await import('./evidence-review.js');
const { runBundleStore, retainedRunTaskDirectory } =
  await import('../../run-completion/retained-artifacts.js');
const { computeReadyGatePackageHash } = await import('../../run-completion/ready-gate-package.js');

async function fixture(): Promise<RecipeRunArtifactGroup> {
  run.id = randomUUID();
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-evidence-review-'));
  root = path.join(taskDir, 'artifacts');
  await cp(
    new URL(
      '../../../../../docs/examples/recipes/farmslot/artifacts/provenance-smoke/',
      import.meta.url,
    ),
    root,
    { recursive: true },
  );
  await writeFile(path.join(root, 'original.mp4'), new Uint8Array([1, 2, 3]));
  const manifestPath = path.join(root, 'artifact-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.artifacts.push({ path: 'original.mp4', type: 'video', label: 'Untimed recording' });
  await writeFile(manifestPath, JSON.stringify(manifest));
  hashes = await Promise.all(
    (await readdir(root)).map(async (file) => ({
      path: `artifacts/${file}`,
      sha256: createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex'),
    })),
  );
  run.taskFile = path.join(taskDir, 'TASK.md');
  await retainFixtureTask(taskDir, run, await runBundleStore(true));
  return {
    id: 'current-artifacts',
    label: 'Retained fixture',
    groupKind: 'current-artifacts',
    promoted: false,
    status: 'pass',
    artifactRoot: root,
    artifactBundle: run.artifactBundle,
    artifactManifest: null,
    source: 'recipe-run-artifacts',
    selectionReason: 'latest-run',
    isStale: false,
    recipeRunId: null,
    recipeJson: null,
    recipeQualityArtifact: null,
    qualityReport: null,
    workerLearnings: null,
  };
}

const run: Run = {
  id: 'retained-run',
  familyId: 'retained-family',
  lane: 'production',
  flowType: 'dev',
  status: 'done',
  project: 'sample',
  ticketOrPr: 'sample',
  slotId: 'test-slot',
  branch: 'feature',
  taskFile: null,
  steps: [],
  decisions: [],
  metrics: { nudgeCount: 0, model: null, runner: null },
  createdAt: '2026-10-15T00:00:00Z',
  updatedAt: '2026-10-15T00:00:00Z',
};
test('a finished current run with no execution returns a typed missing selection, without backfilling history', async () => {
  const source = await readRunRecordedEvidence(
    { ...run, status: 'done', recordedEvidenceContractVersion: 1 },
    undefined,
  );
  assert.equal(source.failureCode, 'evidence-selection-missing');
  assert.match(source.errors.join(' '), /Re-run the recipe/);
  assert.equal(
    (await readRunRecordedEvidence({ ...run, status: 'done' }, undefined)).contractVersion,
    0,
  );
  assert.deepEqual(
    (
      await readRunRecordedEvidence(
        { ...run, status: 'monitoring', recordedEvidenceContractVersion: 1 },
        undefined,
      )
    ).errors,
    [],
  );
});
test('local and remote review transport share the canonical input without original-media transfer', async (t) => {
  const group = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  remote = false;
  const local = await readRunRecordedEvidence(run, group);
  remote = true;
  reads.length = 0;
  const transported = await readRunRecordedEvidence(run, group);
  assert.deepEqual(transported, local);
  assert.deepEqual(transported.errors, []);
  assert.equal(transported.artifactPrefix, 'artifacts/');
  assert.equal(reads.length, 0);
});

test('transport failures remain visible and never supply invented timed proof', async (t) => {
  const group = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  remote = true;
  const tracePath = path.join(await retainedRunTaskDirectory(run), 'artifacts/trace.json');
  await chmod(tracePath, 0o600);
  await writeFile(tracePath, '{');
  const source = await readRunRecordedEvidence(run, group);
  assert(source.errors.length);
  assert.deepEqual(await readRunRecordedEvidence(run, undefined), {
    artifactPrefix: 'artifacts/',
    contractVersion: 0,
    errors: [],
  });
});

test('gate display reuses the frozen inventory and refuses changed bytes or a refreshed package identity', async (t) => {
  const group = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = `${path.basename(root)}/`;
  const prepared = {
    id: 'retained-package',
    evidenceManifest: hashes.map((entry) => ({
      ...entry,
      path: prefix + entry.path.slice('artifacts/'.length),
      purpose: 'evidence',
    })),
  } as ReadyGatePrPackage;
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  const decision = { id: 'gate', payload: { kind: 'ready', prPackage: prepared } } as RunDecision;
  const sourceRun = {
    ...run,
    taskFile: path.join(path.dirname(root), 'TASK.md'),
    decisions: [decision],
  } as Run;
  const binding = { decisionId: decision.id, packageHash: prepared.packageHash };
  const source = await readRunRecordedEvidence(sourceRun, group, binding);
  assert.deepEqual(source.errors, []);
  assert.equal(source.artifactPrefix, prefix);
  assert(source.input);
  decision.payload = {
    ...decision.payload!,
    acceptanceStatus: { schemaVersion: 2, recipeRunId: 'another-execution', criteria: [] },
  } as RunDecision['payload'];
  const mismatch = await readRunRecordedEvidence(sourceRun, group, binding);
  assert.equal(mismatch.input, undefined);
  assert.match(mismatch.errors.join(' '), /Select a retained recipe execution/);
  decision.payload = { kind: 'ready', prPackage: prepared } as RunDecision['payload'];
  const changed = await readRunRecordedEvidence(sourceRun, group, {
    ...binding,
    packageHash: 'old-package',
  });
  assert.equal(changed.input, undefined);
  assert.match(changed.errors.join(' '), /package changed/);
  await writeFile(path.join(root, 'original.mp4'), new Uint8Array([9]));
  assert.deepEqual((await readRunRecordedEvidence(sourceRun, group, binding)).errors, []);
  const retainedMedia = path.join(
    await retainedRunTaskDirectory(sourceRun),
    'artifacts/original.mp4',
  );
  await chmod(retainedMedia, 0o600);
  await writeFile(retainedMedia, new Uint8Array([9]));
  const corruptSource = await readRunRecordedEvidence(sourceRun, group, binding);
  assert.equal(corruptSource.input, undefined);
  assert.match(corruptSource.errors.join(' '), /missing|changed/);
});

test('QA output display uses the same frozen closure and refuses a changed report snapshot', async (t) => {
  const group = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = `${path.basename(root)}/`;
  const output = {
    capturedAt: new Date().toISOString(),
    workerFinished: true,
    artifactManifest: hashes.map((entry) => ({
      ...entry,
      path: prefix + entry.path.slice('artifacts/'.length),
      purpose: 'evidence',
    })),
    manifestDigest: 'captured-output',
    reportPath: prefix + 'summary.json',
  };
  const decision = {
    id: 'qa-review',
    payload: {
      kind: 'output-review',
      manifestDigest: output.manifestDigest,
      reportPath: output.reportPath,
    },
  } as RunDecision;
  const sourceRun = {
    ...run,
    taskFile: path.join(path.dirname(root), 'TASK.md'),
    output,
    decisions: [decision],
  } as Run;
  const binding = { decisionId: decision.id, packageHash: output.manifestDigest };
  const source = await readRunRecordedEvidence(sourceRun, group, binding);
  assert.deepEqual(source.errors, []);
  assert.equal(source.artifactPrefix, prefix);
  const changed = await readRunRecordedEvidence(
    // Writer eligibility must not hide otherwise readable QA history.
    { ...sourceRun, flowType: 'qa' },
    group,
    binding,
  );
  assert.deepEqual(changed.errors, []);
  const pointerGroup = { ...group, recipeRunId: 'directory-id' };
  const selected = await readRunRecordedEvidence(sourceRun, pointerGroup, binding);
  assert.deepEqual(selected.errors, []);
  assert.equal(selected.artifactPrefix, prefix);
  const stale = await readRunRecordedEvidence(
    { ...sourceRun, output: { ...output, manifestDigest: 'refreshed-output' } },
    group,
    binding,
  );
  assert.equal(stale.input, undefined);
  assert.match(stale.errors.join(' '), /QA output snapshot changed/);
});

test('package display paths use the selected artifact root even when the run task is an operator mirror', async (t) => {
  const group = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = root;
  const nested = path.join(root, 'recipe-run');
  await mkdir(nested, { recursive: true });
  for (const file of await readdir(original)) {
    if (file !== 'recipe-run')
      await cp(path.join(original, file), path.join(nested, file), { recursive: true });
  }
  root = nested;
  await retainFixtureTask(path.dirname(original), run, await runBundleStore(true));
  remote = false;
  const source = await readRunRecordedEvidence(
    { ...run, taskFile: '/operator/tasks/TASK.md' } as Run,
    { ...group, artifactRoot: nested, artifactBundle: run.artifactBundle },
  );
  root = original;
  assert.equal(source.packagePath, 'recipe-run');
  assert.deepEqual(source.errors, []);
});

test('historical comparisons require the same execution, package prefix and summary bytes in a retained ready snapshot', async (t) => {
  const group = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  remote = false;
  const source = await readRunRecordedEvidence(run, group);
  assert.ok(source.input);
  const input: RecordedEvidencePackageInput = {
    ...source.input,
    claims: {
      schemaVersion: 2,
      recipeRunId: 'selected-execution',
      criteria: [],
      recording: { status: 'not-required', segments: [] },
    },
  };
  assert.ok(input.claims);
  const snapshot = {
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    source: 'local-git' as const,
    capturedAt: '2026-10-15T00:00:00Z',
  };
  const prepared: ReadyGatePrPackage = {
    id: 'comparison',
    packageHash: 'retained',
    artifactPath: 'package.md',
    branch: 'feature',
    diffStat: { files: 1, additions: 1, deletions: 0 },
    reviewSnapshot: snapshot,
    draftTitle: 'Change',
    draftBody: 'Proof',
    reviewArtifactIds: [],
    gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'Review comparison' },
    publicationTarget: 'draft',
    publicationStatus: 'not_published',
    createdAt: snapshot.capturedAt,
    evidenceManifest: Object.entries(input.artifactDigests).map(([file, sha256]) => ({
      path: `artifacts/recipe-runs/selected/${file}`,
      purpose: 'evidence',
      sha256: sha256.replace(/^sha256:/u, ''),
    })),
  };
  const decision: RunDecision = {
    id: 'gate',
    createdAt: snapshot.capturedAt,
    type: 'engine_human_gate',
    title: 'Review',
    description: 'Inspect proof',
    actions: [],
    payload: {
      kind: 'ready',
      branch: 'feature',
      prNumber: null,
      repo: null,
      diffStat: prepared.diffStat,
      workerReport: 'Proof',
      acceptanceStatus: input.claims,
      prPackage: prepared,
    },
  };
  const retained: Run = { ...run, decisions: [decision] };
  assert.equal(retainedComparisonSnapshot(retained, input, 'recipe-runs/selected'), snapshot);
  assert.equal(retainedComparisonSnapshot(retained, input, 'recipe-runs/other'), undefined);
  assert.equal(
    retainedComparisonSnapshot(
      retained,
      {
        ...input,
        artifactDigests: { ...input.artifactDigests, 'trace.json': 'sha256:' + '4'.repeat(64) },
      },
      'recipe-runs/selected',
    ),
    undefined,
  );
  assert.equal(
    retainedComparisonSnapshot(
      retained,
      {
        ...source.input,
        artifactDigests: {
          ...input.artifactDigests,
          'summary.json': 'sha256:' + '3'.repeat(64),
        },
      },
      'recipe-runs/selected',
    ),
    undefined,
  );
  assert.equal(
    retainedComparisonSnapshot(
      retained,
      { ...input, claims: { ...input.claims, recipeRunId: 'another-execution' } },
      'recipe-runs/selected',
    ),
    undefined,
  );
});
