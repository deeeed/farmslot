import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

import { assertSourceAttestation } from './attestation.js';
import { type FetchedSource, SourceGitStore } from './git.js';
import { sourceLockDigest } from './lock.js';
import { SourceMaterializer, sourceTreeIdentity, type SourceVolume } from './materialization.js';

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
  protected = true;
  failPublication = false;
  async publish(tree: string, _image: string, mount: string): Promise<void> {
    this.publications++;
    if (this.failPublication) throw new Error('interrupted volume publication');
    await cp(tree, mount, { recursive: true });
  }
  async verify(): Promise<void> {
    if (!this.protected) throw new Error('source volume is writable');
  }
}

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
