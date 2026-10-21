import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { SourceLock } from '@farmslot/protocol';

import {
  configureProjectSources,
  currentProjectSources,
  freezePlannedRunSources,
  projectSourceContext,
  withLegacyProjectSources,
  withProjectSources,
} from '../source-binding.js';
import { sourceWorkerEnvironment } from '../source-environment.js';

import { assertSourceAttestation } from './attestation.js';
import { type FetchedSource, SourceGitStore } from './git.js';
import { sourceLockDigest } from './lock.js';
import {
  ReadOnlySourceVolume,
  SourceMaterializer,
  sourceTreeIdentity,
  type SourceVolume,
  SourceVolumeMissing,
} from './materialization.js';

class FixtureGit extends SourceGitStore {
  constructor(
    root: string,
    readonly sourceTree: string,
    readonly fetched: FetchedSource,
  ) {
    super(root);
  }
  async retain(): Promise<FetchedSource> {
    return this.fetched;
  }
  async export(_repo: string, _tree: FetchedSource, root: string): Promise<void> {
    await cp(this.sourceTree, root, { recursive: true });
  }
}

class FixtureVolume implements SourceVolume {
  publications = 0;
  verifications = 0;
  protected = true;
  failPublication = false;
  async publish(tree: string, image: string, mount: string): Promise<void> {
    this.publications++;
    if (this.failPublication) throw new Error('interrupted volume publication');
    await cp(tree, mount, { recursive: true });
    await mkdir(path.dirname(image), { recursive: true });
    await cp(tree, image, { recursive: true });
  }
  async restore(image: string, mount: string): Promise<void> {
    try {
      await this.verify(mount);
    } catch (error) {
      if (!(error instanceof SourceVolumeMissing)) throw error;
      await cp(image, mount, { recursive: true });
    }
  }
  async verify(mount: string): Promise<void> {
    this.verifications++;
    if (!(await readdir(mount)).includes('tree')) throw new SourceVolumeMissing('volume missing');
    if (!this.protected) throw new Error('source volume is writable');
  }
}

test('status verifies shared trees once per read while checking every receipt and later drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-status-shared-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { lock, materializer, volume } = await fixture(root);
  const first = await materializer.materialize(lock);
  const { digest: _digest, ...content } = lock;
  const secondContent = { ...content, generation: lock.generation + 1 };
  const secondLock = { ...secondContent, digest: sourceLockDigest(secondContent) };
  const second = await materializer.materialize(secondLock);
  volume.verifications = 0;
  const status = await materializer.status();
  assert.equal(status.materializations.length, 2);
  assert(status.materializations.every((entry) => !entry.drift.length && entry.verifiedAt));
  assert.equal(volume.verifications, 1, 'Two receipts share the same protected source tree');
  await materializer.status();
  assert.equal(volume.verifications, 2, 'A new read must verify the tree again');
  const corrupt = structuredClone(second);
  corrupt.receipt.nodeId = 'another-node';
  await writeFile(second.receiptPath, JSON.stringify(corrupt));
  const refused = await materializer.status();
  assert.match(
    refused.materializations.find((entry) => entry.lockDigest === secondLock.digest)!.drift[0],
    /receipt does not match/,
  );
  assert.equal(
    refused.materializations.find((entry) => entry.lockDigest === lock.digest)!.drift.length,
    0,
  );
  await writeFile(second.receiptPath, JSON.stringify(second));
  await writeFile(path.join(first.roots.demo, 'extra.txt'), 'unexpected source bytes');
  volume.verifications = 0;
  const drifted = await materializer.status();
  assert(
    drifted.materializations.every((entry) => entry.drift.some((reason) => /drift/.test(reason))),
  );
  assert.equal(volume.verifications, 1);
  await assert.rejects(materializer.verify(lock), /drift/);
  assert.equal(volume.verifications, 2, 'Execution verification must not reuse a status check');
});

async function fixture(
  root: string,
): Promise<{ lock: SourceLock; materializer: SourceMaterializer; volume: FixtureVolume }> {
  const treeRoot = path.join(root, 'fixture');
  await mkdir(treeRoot);
  await writeFile(path.join(treeRoot, 'project.json'), '{"name":"demo"}');
  const treeDigest = await sourceTreeIdentity(treeRoot, 'sha1');
  const fetched: FetchedSource = {
    commit: 'a'.repeat(40),
    refObject: 'a'.repeat(40),
    objectFormat: 'sha1',
    refKind: 'commit',
    files: [],
    treeDigest,
  };
  const content: Omit<SourceLock, 'digest'> = {
    schemaVersion: 1,
    context: { project: 'demo' },
    generation: 1,
    declarationRevision: 1,
    pinRevision: 0,
    packBindings: { demo: { sourceId: 'demo', entry: '.' } },
    resolvedAt: new Date().toISOString(),
    entries: [
      {
        sourceId: 'demo',
        kind: 'pack',
        repo: 'https://example.test/owner/demo',
        declaredRef: 'main',
        effectiveRef: 'main',
        commit: fetched.commit,
        objectFormat: 'sha1',
        treeDigest,
        resolutionGeneration: 1,
        scope: 'farm',
        dependencies: [],
      },
    ],
  };
  const lock = { ...content, digest: sourceLockDigest(content) };
  const cache = path.join(root, 'cache');
  const volume = new FixtureVolume();
  return {
    lock,
    materializer: new SourceMaterializer(
      'node',
      cache,
      new FixtureGit(cache, treeRoot, fetched),
      volume,
    ),
    volume,
  };
}

test('drift and lost protection refuse work without silently rematerializing an admitted generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-materialize-test-'));
  try {
    const { lock, materializer, volume } = await fixture(root);
    const admitted = await materializer.materialize(lock);
    assertSourceAttestation(lock, 'node', admitted);
    const wrongCommit = structuredClone(admitted);
    wrongCommit.receipt.sources[0].commit = 'b'.repeat(40);
    assert.throws(() => assertSourceAttestation(lock, 'node', wrongCommit), /different/);
    assert.throws(() => assertSourceAttestation(lock, 'another-node', admitted), /different/);
    assert.deepEqual((await materializer.verify(lock)).receipt, admitted.receipt);
    volume.protected = false;
    await assert.rejects(materializer.materialize(lock), /writable/);
    volume.protected = true;
    await writeFile(path.join(admitted.roots.demo, 'extra.txt'), 'undeclared input');
    await assert.rejects(materializer.materialize(lock), /drift/);
    assert.equal(volume.publications, 1);
    const status = await materializer.status();
    assert.match(status.materializations[0].drift[0], /drift/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a lost mount restores the retained image and receipt without fetching or accepting changed bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-remount-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { lock, materializer, volume } = await fixture(root);
  const admitted = await materializer.materialize(lock);
  await rm(admitted.roots.demo, { recursive: true });
  await assert.rejects(materializer.verify(lock), /missing/);
  const restored = await materializer.materialize(lock);
  assert.deepEqual(restored, admitted);
  assert.equal(volume.publications, 1);
  const images = path.join(materializer.root, 'images');
  const image = path.join(images, (await readdir(images))[0]);
  await rm(admitted.roots.demo, { recursive: true });
  await writeFile(path.join(image, 'tree/project.json'), 'changed image');
  await assert.rejects(materializer.materialize(lock), /drift/);
  assert.equal(volume.publications, 1);
});

test('interrupted publication has no usable receipt; retry publishes once and then verifies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-partial-test-'));
  try {
    const { lock, materializer, volume } = await fixture(root);
    volume.failPublication = true;
    await assert.rejects(materializer.materialize(lock), /interrupted/);
    assert.equal((await materializer.status()).materializations.length, 0);
    volume.failPublication = false;
    const published = await materializer.materialize(lock);
    const again = await materializer.materialize(lock);
    assert.equal(published.receipt.id, again.receipt.id);
    const record = JSON.parse(await readFile(published.receiptPath, 'utf8'));
    record.roots.demo = path.join(root, 'fixture');
    await writeFile(published.receiptPath, JSON.stringify(record));
    await assert.rejects(materializer.verify(lock), /substituted/);
    assert.equal(volume.publications, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy work retains original input routing while new runs freeze their own lock context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-legacy-test-'));
  try {
    const { lock, materializer } = await fixture(root);
    const materialization = await materializer.materialize(lock);
    const sources = {
      project: 'demo',
      pack: lock.packBindings.demo,
      materialization,
      packs: lock.packBindings,
    };
    configureProjectSources(
      async () => sources,
      () => ['demo'],
    );
    assert.equal((await projectSourceContext('demo'))!.materialization.lock.digest, lock.digest);
    await withLegacyProjectSources('demo', async () => {
      assert.equal(await projectSourceContext('demo'), undefined);
      assert.equal(freezePlannedRunSources('historical-run'), undefined);
      await withProjectSources(sources, async () => {
        const frozen = freezePlannedRunSources('new-run')!;
        assert.equal(frozen.lock.context.runId, 'new-run');
        assert.deepEqual(frozen.workerLock, lock);
        const next = freezePlannedRunSources('next-run')!;
        assert.notEqual(frozen.lock.digest, next.lock.digest);
        assert.equal(frozen.workerLock.digest, next.workerLock.digest);
        const perRun = { ...materialization, lock: frozen.lock, receiptPath: '/run-receipt.json' };
        const perNextRun = {
          ...materialization,
          lock: next.lock,
          receiptPath: '/next-receipt.json',
        };
        assert.deepEqual(
          sourceWorkerEnvironment({
            ...sources,
            execution: perRun,
            workerExecution: materialization,
          }),
          sourceWorkerEnvironment({
            ...sources,
            execution: perNextRun,
            workerExecution: materialization,
          }),
        );
        assert.equal(
          sourceWorkerEnvironment({
            ...sources,
            execution: perRun,
            workerExecution: materialization,
          }).FARMSLOT_SOURCE_LOCK_DIGEST,
          lock.digest,
        );
        assert.notEqual(frozen.lock.digest, lock.digest);
        assert.deepEqual(frozen.lock.entries, lock.entries);
        assert.deepEqual(frozen.lock.packBindings, lock.packBindings);
        assert.equal(currentProjectSources(), sources);
      });
      assert.equal(currentProjectSources(), undefined);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'an unmounted macOS directory is identified before diskutil can reject its path',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'source-unmounted-path-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const mount = path.join(root, 'mount');
    await mkdir(mount);
    const { realpath } = await import('node:fs/promises');
    const volume = new ReadOnlySourceVolume(async () => {
      throw new Error('diskutil must not identify an unmounted path');
    });
    await assert.rejects(volume.verify(await realpath(mount)), SourceVolumeMissing);
  },
);
