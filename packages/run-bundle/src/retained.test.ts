import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { ArtifactRef, Run, RunArtifactBundleRef } from '@farmslot/protocol';

import { exportRunsToBundle } from './export.js';
import { importBundle } from './import.js';
import {
  collectRunBundleGarbage,
  materializeRunBundle,
  type MaterializeRunBundleRequest,
  openRunBundleStore,
  readRetainedRunBundle,
  readRunBundleAvailability,
  reserveRunBundleMetadata,
  resolveRunBundleEntry,
} from './retained.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'retained-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskDir = path.join(root, 'projects/demo/tasks/qa/case');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const run: Run = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    familyId: 'family',
    lane: 'production',
    flowType: 'qa',
    mode: 'validation',
    completionPolicy: 'artifact-only',
    status: 'done',
    project: 'demo',
    ticketOrPr: 'QA',
    slotId: null,
    branch: null,
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'scripted', runner: 'scripted' },
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
  const artifacts: ArtifactRef[] = [];
  for (const [name, body] of Object.entries({
    'report.html': '<h1>Retained report</h1>',
    'capture.mp4': 'video bytes',
  })) {
    await writeFile(path.join(taskDir, 'artifacts', name), body);
    artifacts.push({
      path: `artifacts/${name}`,
      purpose: name === 'report.html' ? 'report' : 'video',
      sha256: createHash('sha256').update(body).digest('hex'),
      sizeBytes: Buffer.byteLength(body),
    });
  }
  const store = await openRunBundleStore({
    runsDir: path.join(root, '.runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  const refs: RunArtifactBundleRef[] = [];
  const request: MaterializeRunBundleRequest = {
    store,
    farmslotRoot: root,
    run,
    taskDir,
    artifacts,
    manifestDigest: 'original-inventory',
    captureKey: 'generation-1:original-inventory',
    commit: async (ref) => {
      refs.push(ref);
    },
  };
  return { root, taskDir, run, artifacts, store, refs, request };
}

test('retained report survives source mutation/removal and cold store reopen with no slot dependency', async (t) => {
  const f = await fixture(t);
  const result = await materializeRunBundle(f.request);
  assert.equal(result.manifest.version, 1);
  assert.equal(result.manifest.profile, 'reference');
  assert.deepEqual(result.missingData, []);
  assert.equal(result.ref.manifestDigest, 'original-inventory');
  await writeFile(path.join(f.taskDir, 'artifacts/report.html'), 'mutable slot successor');
  await rm(f.taskDir, { recursive: true });
  const store = await openRunBundleStore({
    runsDir: f.store.runsDir,
    home: path.join(f.root, 'sandbox-auth'),
  });
  assert.deepEqual(store, f.store);
  const report = await resolveRunBundleEntry({
    store,
    ref: result.ref,
    runId: f.run.id,
    path: 'artifacts/report.html',
  });
  assert.equal(await readFile(report.path, 'utf8'), '<h1>Retained report</h1>');
  const retried = await materializeRunBundle(f.request);
  assert.deepEqual(retried.ref, result.ref);
  assert.equal(retried.manifest.exportedAt, result.manifest.exportedAt);
  assert.equal(retried.manifest.bundleId, result.manifest.bundleId);
});

test('published capture retries its failed Run commit with identical manifest and no source read', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    materializeRunBundle({
      ...f.request,
      commit: async () => {
        throw new Error('interrupted reference write');
      },
    }),
    /interrupted reference write/,
  );
  await rm(f.taskDir, { recursive: true });
  const result = await materializeRunBundle(f.request);
  assert.equal(f.refs[0]?.bundleDigest, result.ref.bundleDigest);
  assert.equal(
    (await readRetainedRunBundle(f.store, result.ref, f.run.id)).manifest.bundleId,
    result.manifest.bundleId,
  );
});

test('shared Run store resolves its owner root; isolated auth home cannot establish or rebind it', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    openRunBundleStore({
      runsDir: path.join(f.root, 'unpaired-runs'),
      home: path.join(f.root, 'sandbox'),
    }),
    /pairing is missing/,
  );
  const foreign = await openRunBundleStore({
    runsDir: path.join(f.root, 'foreign-runs'),
    home: path.join(f.root, 'foreign-home'),
    create: true,
  });
  const result = await materializeRunBundle(f.request);
  await assert.rejects(
    resolveRunBundleEntry({
      store: foreign,
      ref: result.ref,
      runId: f.run.id,
      path: 'artifacts/report.html',
    }),
    /another Run store/,
  );
  await assert.rejects(
    resolveRunBundleEntry({
      store: f.store,
      ref: result.ref,
      runId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      path: 'artifacts/report.html',
    }),
    /does not belong/,
  );
  await assert.rejects(
    resolveRunBundleEntry({
      store: f.store,
      ref: result.ref,
      runId: f.run.id,
      path: '../report.html',
    }),
    /Unsafe/,
  );
  await assert.rejects(
    openRunBundleStore({
      runsDir: path.join(f.root, 'different-runs'),
      home: path.join(f.root, 'home'),
      create: true,
    }),
    /different Run store/,
  );
});

test('media cannot consume the report reserve; metadata remains readable and missing media is explicit', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.taskDir, 'artifacts/capture.mp4'), Buffer.alloc(60_000));
  f.artifacts[1]!.sha256 = createHash('sha256').update(Buffer.alloc(60_000)).digest('hex');
  const result = await materializeRunBundle({
    ...f.request,
    policy: {
      maxBundleBytes: 200_000,
      maxStoreBytes: 200_000,
      metadataReserveBytes: 150_000,
      mediaRetentionDays: 30,
    },
  });
  assert.deepEqual(result.missingData, ['media-capacity:artifacts/capture.mp4']);
  const report = await resolveRunBundleEntry({
    store: f.store,
    ref: result.ref,
    runId: f.run.id,
    path: 'artifacts/report.html',
  });
  assert.equal(await readFile(report.path, 'utf8'), '<h1>Retained report</h1>');
  await assert.rejects(
    resolveRunBundleEntry({
      store: f.store,
      ref: result.ref,
      runId: f.run.id,
      path: 'artifacts/capture.mp4',
    }),
    { code: 'ENOENT' },
  );
  const repaired = await materializeRunBundle(f.request);
  assert.deepEqual(repaired.ref, result.ref);
  assert.deepEqual(repaired.missingData, []);
  assert.equal(
    (
      await resolveRunBundleEntry({
        store: f.store,
        ref: result.ref,
        runId: f.run.id,
        path: 'artifacts/capture.mp4',
      })
    ).bytes,
    60_000,
  );
});

test('changed historical bytes stay readable but keep the original expected inventory identity', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.taskDir, 'artifacts/report.html'), '<p>Changed before retention</p>');
  await assert.rejects(materializeRunBundle(f.request), /changed while retaining/);
  assert.equal(f.refs.length, 0);
  const result = await materializeRunBundle({ ...f.request, allowChanged: true });
  assert.deepEqual(result.missingData, ['changed:artifacts/report.html']);
  assert.equal(result.ref.manifestDigest, f.request.manifestDigest);
  const report = await resolveRunBundleEntry({
    store: f.store,
    ref: result.ref,
    runId: f.run.id,
    path: 'artifacts/report.html',
  });
  assert.equal(await readFile(report.path, 'utf8'), '<p>Changed before retention</p>');
  assert.notEqual(report.sha256, f.artifacts[0]!.sha256);
});

test('concurrent identical captures serialize the reference commit and reuse one capture', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([
    materializeRunBundle(f.request),
    materializeRunBundle(f.request),
  ]);
  assert.deepEqual(results[0]!.ref, results[1]!.ref);
  assert.equal(f.refs.length, 2);
});

test('GC preserves pending media, prunes expired completed media, and leaves report/manifest bytes unchanged', async (t) => {
  const f = await fixture(t);
  const result = await materializeRunBundle(f.request);
  const bundle = await readRetainedRunBundle(f.store, result.ref, f.run.id);
  const originalManifest = await readFile(path.join(bundle.directory, 'manifest.json'));
  const pending: Run = {
    ...f.run,
    artifactBundle: result.ref,
    decisions: [
      {
        id: 'review',
        type: 'engine_output_review',
        title: 'Review',
        description: '',
        actions: [],
        createdAt: f.run.createdAt,
        payload: {
          kind: 'output-review',
          manifestDigest: 'original-inventory',
          reportPath: 'artifacts/report.html',
          artifactBundle: result.ref,
        },
      },
    ],
  };
  await writeFile(path.join(f.store.runsDir, `${pending.id}.json`), JSON.stringify(pending));
  const future = Date.now() + 31 * 86_400_000;
  assert.equal((await collectRunBundleGarbage(f.store, undefined, future)).reclaimedBytes, 0);
  pending.decisions[0]!.resolvedAt = f.run.createdAt;
  await writeFile(path.join(f.store.runsDir, `${pending.id}.json`), JSON.stringify(pending));
  const swept = await collectRunBundleGarbage(f.store, undefined, future);
  assert.ok(swept.reclaimedBytes > 0);
  assert.deepEqual(swept.prunedPaths, [`tasks/${f.run.id}/artifacts/capture.mp4`]);
  const report = await resolveRunBundleEntry({
    store: f.store,
    ref: result.ref,
    runId: f.run.id,
    path: 'artifacts/report.html',
  });
  assert.equal(await readFile(report.path, 'utf8'), '<h1>Retained report</h1>');
  assert.deepEqual(await readFile(path.join(bundle.directory, 'manifest.json')), originalManifest);
  await assert.rejects(
    resolveRunBundleEntry({
      store: f.store,
      ref: result.ref,
      runId: f.run.id,
      path: 'artifacts/capture.mp4',
    }),
    { code: 'ENOENT' },
  );
  const pruned = await readRunBundleAvailability(f.store, result.ref, f.run.id);
  assert.equal(pruned.revision, 1);
  const restored = await materializeRunBundle({
    ...f.request,
    captureKey: 'explicit-media-recovery',
    existingRef: result.ref,
  });
  assert.deepEqual(restored.ref, result.ref);
  assert.deepEqual(restored.missingData, []);
  assert.deepEqual(await readRunBundleAvailability(f.store, result.ref, f.run.id), {
    revision: 2,
    prunedPaths: [],
  });
  assert.deepEqual(await readFile(path.join(bundle.directory, 'manifest.json')), originalManifest);
});

test('portable export/import creates target-owned retained refs before temporary input cleanup', async (t) => {
  const f = await fixture(t);
  f.run.output = {
    capturedAt: f.run.createdAt,
    workerFinished: true,
    artifactManifest: f.artifacts,
    manifestDigest: f.request.manifestDigest,
    reportPath: 'artifacts/report.html',
  };
  const captured = await materializeRunBundle({
    ...f.request,
    commit: async (ref) => {
      f.run.artifactBundle = ref;
      f.run.output!.artifactBundle = ref;
      await writeFile(path.join(f.store.runsDir, `${f.run.id}.json`), JSON.stringify(f.run));
    },
  });
  await rm(f.taskDir, { recursive: true });
  const archive = path.join(f.root, 'retained.farmrun');
  const exported = await exportRunsToBundle({
    farmslotRoot: f.root,
    profile: 'reference',
    runIds: [f.run.id],
    outputPath: archive,
  });
  assert.deepEqual(exported.manifest.missingData, undefined);
  const target = path.join(f.root, 'imported');
  const store = await openRunBundleStore({
    runsDir: path.join(target, '.runs'),
    home: path.join(target, 'home'),
    create: true,
  });
  const result = await importBundle({
    farmslotRoot: target,
    bundlePath: archive,
    mode: 'seed',
    retentionStore: store,
  });
  const imported: Run = JSON.parse(
    await readFile(path.join(store.runsDir, `${result.importedRunIds[0]}.json`), 'utf8'),
  );
  assert.notEqual(imported.id, f.run.id);
  assert.equal(imported.artifactBundle?.storeId, store.id);
  assert.notEqual(imported.artifactBundle?.storeId, captured.ref.storeId);
  assert.deepEqual(
    imported.importProvenance?.artifactBundleRefs?.[captured.ref.bundleDigest],
    imported.artifactBundle,
  );
  assert.ok(imported.artifactBundle);
  if (imported.taskFile) await rm(path.dirname(imported.taskFile), { recursive: true });
  const report = await resolveRunBundleEntry({
    store,
    ref: imported.artifactBundle,
    runId: imported.id,
    path: 'artifacts/report.html',
  });
  assert.equal(await readFile(report.path, 'utf8'), '<h1>Retained report</h1>');
});

test('export explicitly reports unretained data and never copies a live task as a fallback', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.store.runsDir, `${f.run.id}.json`), JSON.stringify(f.run));
  const result = await exportRunsToBundle({
    farmslotRoot: f.root,
    profile: 'reference',
    runIds: [f.run.id],
    outputPath: path.join(f.root, 'missing.farmrun'),
  });
  assert.deepEqual(result.manifest.missingData, [`retention-missing:${f.run.id}`]);
  assert.deepEqual(Object.keys(result.manifest.entries), [`runs/${f.run.id}.json`]);
});

test('metadata admission refuses exhausted capacity before work and releases the reservation on capture', async (t) => {
  const f = await fixture(t);
  const policy = {
    maxBundleBytes: 64_000,
    maxStoreBytes: 64_000,
    metadataReserveBytes: 4_000,
    mediaRetentionDays: 30,
  };
  const second = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
  await reserveRunBundleMetadata(f.store, f.run.id, policy);
  await reserveRunBundleMetadata(f.store, f.run.id, policy);
  await assert.rejects(reserveRunBundleMetadata(f.store, second, policy), /capacity is exhausted/);
  await materializeRunBundle(f.request);
  await reserveRunBundleMetadata(f.store, second, policy);
});

test('a dead store lease is recovered and concurrent retries publish the same immutable capture', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.store.runsDir, 'bundle-store.lock');
  await mkdir(lock);
  const stale = new Date(Date.now() - 60_000);
  await utimes(lock, stale, stale);
  const captures = await Promise.all([
    materializeRunBundle(f.request),
    materializeRunBundle(f.request),
  ]);
  assert.deepEqual(captures[0]!.ref, captures[1]!.ref);
  assert.deepEqual(captures[0]!.manifest, captures[1]!.manifest);
});

test('GC removes committed retry intents with unreferenced bundles so explicit acquisition can repeat', async (t) => {
  const f = await fixture(t);
  const first = await materializeRunBundle(f.request);
  assert.ok((await collectRunBundleGarbage(f.store)).reclaimedBytes > 0);
  const repeated = await materializeRunBundle(f.request);
  assert.notEqual(repeated.ref.bundleDigest, first.ref.bundleDigest);
  const bundle = await readRetainedRunBundle(f.store, repeated.ref, f.run.id);
  assert.equal(await bundle.readText('artifacts/report.html'), '<h1>Retained report</h1>');
});
