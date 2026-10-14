import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type {
  ReadyGatePrPackage,
  RecipeRunArtifactGroup,
  Run,
  RunDecision,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
let remote = false;
let root = '';
let corrupt = false;
let hashes: Array<{ path: string; sha256: string }> = [];
const reads: string[] = [];
mock.module('../../core/config.js', {
  namedExports: { loadSlotVars: async () => ({ machine: 'test-node' }) },
});
mock.module('../../qa/completion.js', {
  namedExports: {
    parseQaResult: () => assert.fail('Display must not qualify visual-review registration'),
  },
});
mock.module('../../fleet/machine-registry.js', { namedExports: { getNode: () => ({}) } });
mock.module('../../fleet/node-rpc.js', {
  namedExports: {
    getSlotLocality: async () => ({ isLocal: !remote }),
    sendNodeRequest: async (
      _node: unknown,
      method: string,
      params: { root: string; relPath: string },
    ) => {
      assert.equal(method, 'fs.read');
      assert.equal(params.root, root);
      reads.push(params.relPath);
      return {
        content:
          corrupt && params.relPath === 'trace.json'
            ? '{'
            : await readFile(path.join(root, params.relPath), 'utf8'),
      };
    },
  },
});
mock.module('../filesystem.js', {
  namedExports: {
    resolveRemoteRecipeArtifactRoot: async () => root,
    shouldServeRecipeArtifactFromLocalCache: () => !remote,
  },
});
mock.module('../../live-recipe/context.js', {
  namedExports: {
    scanSlotArtifactRootDetailed: async () => ({ refs: hashes, unavailable: false }),
  },
});
const { readRunRecordedEvidence } = await import('./evidence-review.js');
const { computeReadyGatePackageHash } = await import('../../run-completion/ready-gate-package.js');

async function fixture(): Promise<RecipeRunArtifactGroup> {
  root = await mkdtemp(path.join(os.tmpdir(), 'gateway-evidence-review-'));
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
  return { artifactRoot: root } as RecipeRunArtifactGroup;
}

const run = { slotId: 'test-slot' } as Run;
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
  assert(reads.every((file) => file.endsWith('.json')));
});

test('transport failures remain visible and never supply invented timed proof', async (t) => {
  const group = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  remote = true;
  corrupt = true;
  const source = await readRunRecordedEvidence(run, group);
  assert(source.errors.length);
  corrupt = false;
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
  const corruptSource = await readRunRecordedEvidence(sourceRun, group, binding);
  assert.equal(corruptSource.input, undefined);
  assert.match(corruptSource.errors.join(' '), /missing or changed/);
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
  const nested = path.join(root, 'artifacts', 'recipe-run');
  await mkdir(nested, { recursive: true });
  for (const file of await readdir(original)) {
    if (file !== 'artifacts')
      await cp(path.join(original, file), path.join(nested, file), { recursive: true });
  }
  root = nested;
  remote = false;
  const source = await readRunRecordedEvidence(
    { ...run, taskFile: '/operator/tasks/TASK.md' } as Run,
    { ...group, artifactRoot: nested },
  );
  root = original;
  assert.equal(source.packagePath, 'recipe-run');
  assert.deepEqual(source.errors, []);
});
