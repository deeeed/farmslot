import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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

test('a reader names media the capture declared it could not retain', async (t) => {
  // Run 8cff6e80: every proof still was refused for capacity, and review then
  // failed on a bare ENOENT realpath of the first one.
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
  await assert.rejects(
    resolveRunBundleEntry({
      store: f.store,
      ref: result.ref,
      runId: f.run.id,
      path: 'artifacts/capture.mp4',
    }),
    { code: 'ENOENT', message: 'Artifact not retained (media-capacity): artifacts/capture.mp4' },
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
  assert.ok(f.refs.length >= 2);
  assert.ok(f.refs.every((ref) => ref.bundleDigest === results[0]!.ref.bundleDigest));
});

test('GC preserves pending media, prunes expired completed media, and leaves report/manifest bytes unchanged', async (t) => {
  const f = await fixture(t);
  const result = await materializeRunBundle(f.request);
  const initialAvailability = await readRunBundleAvailability(f.store, result.ref, f.run.id);
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
  assert.equal(pruned.revision, initialAvailability.revision + 1);
  const restored = await materializeRunBundle({
    ...f.request,
    captureKey: 'explicit-media-recovery',
    existingRef: result.ref,
  });
  assert.deepEqual(restored.ref, result.ref);
  assert.deepEqual(restored.missingData, []);
  assert.deepEqual(await readRunBundleAvailability(f.store, result.ref, f.run.id), {
    revision: initialAvailability.revision + 2,
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

test('GC retains an active prepared capture after a newer output advances the Run pointer', async (t) => {
  const f = await fixture(t);
  f.run.status = 'human-gating';
  const commit: MaterializeRunBundleRequest['commit'] = async (ref) => {
    f.run.artifactBundle = ref;
    await writeFile(path.join(f.store.runsDir, `${f.run.id}.json`), JSON.stringify(f.run));
  };
  const prepared = await materializeRunBundle({ ...f.request, commit });
  const output = await materializeRunBundle({
    ...f.request,
    captureKey: 'generation-1:new-output',
    manifestDigest: 'new-output',
    commit,
  });
  assert.notEqual(prepared.ref.bundleDigest, output.ref.bundleDigest);
  await collectRunBundleGarbage(f.store);
  const retained = await readRetainedRunBundle(f.store, prepared.ref, f.run.id);
  assert.equal(await retained.readText('artifacts/report.html'), '<h1>Retained report</h1>');

  // Once the run settles, unreferenced captures are eligible for collection again.
  f.run.status = 'done';
  await commit(output.ref, []);
  await collectRunBundleGarbage(f.store);
  await assert.rejects(readRetainedRunBundle(f.store, prepared.ref, f.run.id), { code: 'ENOENT' });
});

test('a cached manifest cannot hide loss of the retained bundle directory', async (t) => {
  const f = await fixture(t);
  const result = await materializeRunBundle(f.request);
  const bundle = await readRetainedRunBundle(f.store, result.ref, f.run.id);
  await rm(bundle.directory, { recursive: true });
  await assert.rejects(readRetainedRunBundle(f.store, result.ref, f.run.id), { code: 'ENOENT' });
  await assert.rejects(readRunBundleAvailability(f.store, result.ref, f.run.id), {
    code: 'ENOENT',
  });
});

test('a full disk during media transfer never records availability or loses the retained report', async (t) => {
  const f = await fixture(t);
  const fullDisk = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  await assert.rejects(
    materializeRunBundle({
      ...f.request,
      acquireMedia: async () => {
        throw fullDisk;
      },
    }),
    fullDisk,
  );
  const ref = f.refs[0]!;
  await assert.rejects(
    readFile(path.join(f.store.root, 'availability', `${ref.bundleDigest}.json`)),
    {
      code: 'ENOENT',
    },
  );
  await collectRunBundleGarbage(f.store);
  const bundle = await readRetainedRunBundle(f.store, ref, f.run.id);
  assert.equal(await bundle.readText('artifacts/report.html'), '<h1>Retained report</h1>');
});

test('media completion verifies the published manifest before recording availability', async (t) => {
  const f = await fixture(t);
  const video = await readFile(path.join(f.taskDir, 'artifacts/capture.mp4'));
  await assert.rejects(
    materializeRunBundle({
      ...f.request,
      acquireMedia: async (_artifact, destination) => {
        await writeFile(destination, video);
        const ref = f.refs[0]!;
        await rm(path.join(f.store.root, 'sha256', ref.bundleDigest, 'manifest.json'));
        return { sha256: createHash('sha256').update(video).digest('hex'), bytes: video.length };
      },
    }),
    { code: 'ENOENT' },
  );
  assert.equal(f.refs.length, 1);
  await assert.rejects(
    readFile(path.join(f.store.root, 'availability', `${f.refs[0]!.bundleDigest}.json`)),
    { code: 'ENOENT' },
  );
});

test('archived run references retain reports beyond media expiry without source files', async (t) => {
  const f = await fixture(t);
  const result = await materializeRunBundle(f.request);
  const archive = path.join(f.store.runsDir, 'archive');
  await mkdir(archive, { recursive: true });
  await writeFile(
    path.join(archive, `${f.run.id}.json`),
    JSON.stringify({ ...f.run, artifactBundle: result.ref }),
  );
  await rm(f.taskDir, { recursive: true });
  await collectRunBundleGarbage(f.store, undefined, Date.now() + 31 * 86_400_000);
  const retained = await readRetainedRunBundle(f.store, result.ref, f.run.id);
  assert.equal(await retained.readText('artifacts/report.html'), '<h1>Retained report</h1>');
  assert.equal(retained.manifest.bundleId, result.manifest.bundleId);
});

test('a missing inventoried payload keeps its expected identity and can be restored on retry', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.taskDir, 'artifacts/capture.mp4'));
  const first = await materializeRunBundle(f.request);
  assert.ok(first.missingData.includes('missing:artifacts/capture.mp4'));
  assert.ok(first.manifest.entries[`tasks/${f.run.id}/artifacts/capture.mp4`]);
  await writeFile(path.join(f.taskDir, 'artifacts/capture.mp4'), 'video bytes');
  const restored = await materializeRunBundle(f.request);
  assert.deepEqual(restored.ref, first.ref);
  assert.deepEqual(restored.missingData, []);
  const bundle = await readRetainedRunBundle(f.store, restored.ref, f.run.id);
  assert.equal(await bundle.readText('artifacts/capture.mp4'), 'video bytes');
});

test('GC releases terminal and deleted run reservations while retaining active admission', async (t) => {
  const f = await fixture(t);
  const active = { ...f.run, status: 'created' as const };
  await writeFile(path.join(f.store.runsDir, `${active.id}.json`), JSON.stringify(active));
  await reserveRunBundleMetadata(f.store, active.id);
  await reserveRunBundleMetadata(f.store, 'terminal-run');
  await reserveRunBundleMetadata(f.store, 'deleted-run');
  await writeFile(
    path.join(f.store.runsDir, 'terminal-run.json'),
    JSON.stringify({ ...f.run, id: 'terminal-run', status: 'cancelled' }),
  );
  await collectRunBundleGarbage(f.store);
  assert.deepEqual(await readdir(path.join(f.store.root, 'reservations')), [`${active.id}.json`]);
});

test('GC keeps unarchived failed run reservations with or without resources', async (t) => {
  const f = await fixture(t);
  const held: Run = {
    ...f.run,
    id: 'held-run',
    status: 'failed',
    steps: [{ name: 'complete', status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }],
  };
  await writeFile(path.join(f.store.runsDir, 'held-run.json'), JSON.stringify(held));
  await writeFile(
    path.join(f.store.runsDir, 'settled-run.json'),
    JSON.stringify({ ...f.run, id: 'settled-run', status: 'failed' }),
  );
  await reserveRunBundleMetadata(f.store, 'held-run');
  await reserveRunBundleMetadata(f.store, 'settled-run');
  await collectRunBundleGarbage(f.store);
  assert.deepEqual((await readdir(path.join(f.store.root, 'reservations'))).sort(), [
    'held-run.json',
    'settled-run.json',
  ]);
});

test('GC releases the reservation of a refused completion once it is archived', async (t) => {
  const f = await fixture(t);
  const archived: Run = {
    ...f.run,
    id: 'archived-held-run',
    status: 'failed',
    archivedAt: new Date().toISOString(),
    steps: [{ name: 'complete', status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }],
  };
  await mkdir(path.join(f.store.runsDir, 'archive'), { recursive: true });
  await writeFile(
    path.join(f.store.runsDir, 'archive', 'archived-held-run.json'),
    JSON.stringify(archived),
  );
  await reserveRunBundleMetadata(f.store, 'archived-held-run');
  await collectRunBundleGarbage(f.store);
  assert.deepEqual(await readdir(path.join(f.store.root, 'reservations')), []);
});

test('an unresolved imported decision pins its target-owned payload through its original digest alias', async (t) => {
  const f = await fixture(t);
  const result = await materializeRunBundle(f.request);
  const sourceRef = { ...result.ref, storeId: 'source-store', bundleDigest: 'f'.repeat(64) };
  const imported: Run = {
    ...f.run,
    importProvenance: {
      importedFromRunId: f.run.id,
      importedAt: f.run.createdAt,
      mode: 'mirror',
      artifactBundleRefs: { [sourceRef.bundleDigest]: result.ref },
    },
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
          artifactBundle: sourceRef,
        },
      },
    ],
  };
  await writeFile(path.join(f.store.runsDir, `${imported.id}.json`), JSON.stringify(imported));
  assert.equal(
    (await collectRunBundleGarbage(f.store, undefined, Date.now() + 31 * 86_400_000))
      .reclaimedBytes,
    0,
  );
  const bundle = await readRetainedRunBundle(f.store, result.ref, f.run.id);
  assert.equal(await bundle.readText('artifacts/capture.mp4'), 'video bytes');
});

test('near-full storage commits the report before media admission and fills the same capture after capacity recovery', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(90_000, 7);
  await rm(path.join(f.taskDir, 'artifacts/capture.mp4'));
  const filler = path.join(f.store.root, 'retained-fixture-filler');
  await writeFile(filler, Buffer.alloc(100_000));
  let transfers = 0;
  let commits = 0;
  const request: MaterializeRunBundleRequest = {
    ...f.request,
    policy: {
      maxBundleBytes: 200_000,
      maxStoreBytes: 180_000,
      metadataReserveBytes: 32_000,
      mediaRetentionDays: 30,
    },
    artifacts: [
      f.artifacts[0]!,
      {
        path: 'artifacts/capture.mp4',
        purpose: 'video',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
      },
    ],
    acquireMedia: async (_artifact, destination, maximum) => {
      assert.ok(commits > 0, 'the report reference commits before media transport');
      assert.ok(maximum >= bytes.length);
      transfers++;
      await writeFile(destination, bytes);
      return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    },
    commit: async (ref) => {
      commits++;
      const bundle = await readRetainedRunBundle(f.store, ref, f.run.id);
      assert.equal(await bundle.readText('artifacts/report.html'), '<h1>Retained report</h1>');
    },
  };
  const partial = await materializeRunBundle(request);
  assert.equal(transfers, 0, 'an unaffordable video never enters gateway staging');
  assert.ok(partial.missingData.includes('media-capacity:artifacts/capture.mp4'));
  const interrupted = path.join(f.store.root, 'staging', partial.ref.bundleDigest);
  await mkdir(interrupted, { recursive: true });
  await writeFile(path.join(interrupted, 'abandoned.part'), Buffer.alloc(100_000));
  await rm(filler);
  const repaired = await materializeRunBundle(request);
  assert.deepEqual(repaired.ref, partial.ref);
  assert.deepEqual(repaired.missingData, []);
  assert.equal(transfers, 1);
});

test('acquisition media under FARMSLOT_PROJECTS_DIR is charged like the default projects dir', async (t) => {
  const f = await fixture(t);
  const projects = await mkdtemp(path.join(tmpdir(), 'retained-projects-'));
  const previous = process.env.FARMSLOT_PROJECTS_DIR;
  process.env.FARMSLOT_PROJECTS_DIR = projects;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_PROJECTS_DIR;
    else process.env.FARMSLOT_PROJECTS_DIR = previous;
    await rm(projects, { recursive: true, force: true });
  });
  const historical = path.join(projects, 'demo/tasks/qa/deleted-run/artifacts/unique.mp4');
  await mkdir(path.dirname(historical), { recursive: true });
  await writeFile(historical, Buffer.alloc(800_000, 1));
  await rm(path.join(f.taskDir, 'artifacts/capture.mp4'));
  const video = Buffer.alloc(250_000, 2);
  let transfers = 0;
  const result = await materializeRunBundle({
    ...f.request,
    policy: {
      maxStoreBytes: 1_000_000,
      maxBundleBytes: 500_000,
      metadataReserveBytes: 50_000,
      mediaRetentionDays: 30,
    },
    artifacts: [
      f.artifacts[0]!,
      {
        path: 'artifacts/capture.mp4',
        purpose: 'video',
        sha256: createHash('sha256').update(video).digest('hex'),
        sizeBytes: video.length,
      },
    ],
    acquireMedia: async (_artifact, destination) => {
      transfers++;
      await writeFile(destination, video);
      return { sha256: createHash('sha256').update(video).digest('hex'), bytes: video.length };
    },
  });
  assert.equal(transfers, 0);
  assert.ok(result.missingData.includes('media-capacity:artifacts/capture.mp4'));
});

test('a projects dir inside the root sandbox is charged once', async (t) => {
  const f = await fixture(t);
  const projects = path.join(f.root, '.sandbox/electron/projects');
  const previous = process.env.FARMSLOT_PROJECTS_DIR;
  process.env.FARMSLOT_PROJECTS_DIR = projects;
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_PROJECTS_DIR;
    else process.env.FARMSLOT_PROJECTS_DIR = previous;
  });
  const historical = path.join(projects, 'demo/tasks/qa/deleted-run/artifacts/unique.mp4');
  await mkdir(path.dirname(historical), { recursive: true });
  await writeFile(historical, Buffer.alloc(400_000, 1));
  await rm(path.join(f.taskDir, 'artifacts/capture.mp4'));
  const video = Buffer.alloc(250_000, 2);
  let transfers = 0;
  const result = await materializeRunBundle({
    ...f.request,
    policy: {
      maxStoreBytes: 1_000_000,
      maxBundleBytes: 500_000,
      metadataReserveBytes: 50_000,
      mediaRetentionDays: 30,
    },
    artifacts: [
      f.artifacts[0]!,
      {
        path: 'artifacts/capture.mp4',
        purpose: 'video',
        sha256: createHash('sha256').update(video).digest('hex'),
        sizeBytes: video.length,
      },
    ],
    acquireMedia: async (_artifact, destination) => {
      transfers++;
      await writeFile(destination, video);
      return { sha256: createHash('sha256').update(video).digest('hex'), bytes: video.length };
    },
  });
  // Charged twice, 800 KB of 1 MB would defer the video; charged once, it fits.
  assert.equal(transfers, 1);
  assert.deepEqual(result.missingData, []);
});

test('preserved acquisition media from another deleted run remains charged before new transport', async (t) => {
  const f = await fixture(t);
  const historical = path.join(f.root, 'projects/demo/tasks/qa/deleted-run/artifacts/unique.mp4');
  await mkdir(path.dirname(historical), { recursive: true });
  await writeFile(historical, Buffer.alloc(800_000, 1));
  await rm(path.join(f.taskDir, 'artifacts/capture.mp4'));
  const video = Buffer.alloc(250_000, 2);
  let transfers = 0;
  const result = await materializeRunBundle({
    ...f.request,
    policy: {
      maxStoreBytes: 1_000_000,
      maxBundleBytes: 500_000,
      metadataReserveBytes: 50_000,
      mediaRetentionDays: 30,
    },
    artifacts: [
      f.artifacts[0]!,
      {
        path: 'artifacts/capture.mp4',
        purpose: 'video',
        sha256: createHash('sha256').update(video).digest('hex'),
        sizeBytes: video.length,
      },
    ],
    acquireMedia: async (_artifact, destination) => {
      transfers++;
      await writeFile(destination, video);
      return { sha256: createHash('sha256').update(video).digest('hex'), bytes: video.length };
    },
  });
  assert.equal(transfers, 0);
  assert.ok(result.missingData.includes('media-capacity:artifacts/capture.mp4'));
  assert.equal((await readFile(historical)).length, 800_000);
  const retained = await readRetainedRunBundle(f.store, result.ref, f.run.id);
  assert.equal(await retained.readText('artifacts/report.html'), '<h1>Retained report</h1>');
});

test('an in-flight media transfer reserves its ceiling without holding global admission or GC', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.taskDir, 'artifacts/capture.mp4'));
  const video = Buffer.alloc(25_000, 3);
  let transfers = 0;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const capture = materializeRunBundle({
    ...f.request,
    artifacts: [
      f.artifacts[0]!,
      ...['capture.mp4', 'second.mp4', 'third.mp4'].map(
        (name): ArtifactRef => ({
          path: `artifacts/${name}`,
          purpose: 'video',
          sha256: createHash('sha256').update(video).digest('hex'),
          sizeBytes: video.length,
        }),
      ),
    ],
    acquireMedia: async (_artifact, destination) => {
      transfers++;
      enter();
      await held;
      await writeFile(destination, video);
      return { sha256: createHash('sha256').update(video).digest('hex'), bytes: video.length };
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      capture.then(() => {
        throw new Error('capture never requested its media');
      }),
    ]);
    const admission = async () => {
      await reserveRunBundleMetadata(f.store, 'other-run', undefined, f.root);
      await collectRunBundleGarbage(f.store);
    };
    await Promise.race([
      admission(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('bulk transfer blocked global admission')),
          1500,
        );
      }),
    ]);
    const report = await readRetainedRunBundle(f.store, f.refs[0]!, f.run.id);
    assert.equal(await report.readText('artifacts/report.html'), '<h1>Retained report</h1>');
  } finally {
    clearTimeout(timeout);
    release();
    await capture;
  }
  assert.equal(transfers, 3);
});

test('GC preserves a historical capture while its missing media is being repaired', async (t) => {
  const f = await fixture(t);
  const old = new Date(Date.now() - 2 * 86_400_000);
  t.mock.timers.enable({ apis: ['Date'], now: old.getTime() });
  const original = await materializeRunBundle(f.request);
  t.mock.timers.reset();
  await writeFile(
    path.join(f.store.runsDir, `${f.run.id}.json`),
    JSON.stringify({ ...f.run, artifactBundle: original.ref }),
  );
  const payload = await resolveRunBundleEntry({
    store: f.store,
    ref: original.ref,
    runId: f.run.id,
    path: 'artifacts/capture.mp4',
  });
  await rm(payload.path);
  const [name] = await readdir(path.join(f.store.runsDir, 'bundle-intents'));
  assert.ok(name);
  const intent = path.join(f.store.runsDir, 'bundle-intents', name);
  const repaired = await materializeRunBundle({
    ...f.request,
    existingRef: original.ref,
    acquireMedia: async (_artifact, destination) => {
      // Exercise lease ownership too, independently of a fresh retry's intent timestamp.
      await utimes(intent, old, old);
      await collectRunBundleGarbage(f.store);
      await writeFile(destination, 'video bytes');
      return {
        sha256: createHash('sha256').update('video bytes').digest('hex'),
        bytes: Buffer.byteLength('video bytes'),
      };
    },
  });
  assert.deepEqual(repaired.ref, original.ref);
  assert.deepEqual(repaired.missingData, []);
  assert.equal(await readFile(payload.path, 'utf8'), 'video bytes');
});
