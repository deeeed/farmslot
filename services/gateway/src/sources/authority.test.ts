import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { SourceConfiguration, SourceDeclaration } from '@farmslot/protocol';
import { type FetchedSource, sourceDigest, SourceGitStore } from '@farmslot/slot-config/sources';

import { SourceAuthority } from './authority.js';

class FixtureSources extends SourceGitStore {
  commits = new Map<string, string>();
  manifests = new Map<string, unknown>();
  denied = new Set<string>();
  async resolve(source: SourceDeclaration): Promise<FetchedSource> {
    if (this.denied.has(source.id)) throw new Error('fixture source unavailable');
    return {
      commit: this.commits.get(source.id) ?? 'a'.repeat(40),
      objectFormat: 'sha1',
      refKind: 'branch',
      refObject: this.commits.get(source.id) ?? 'a'.repeat(40),
      files: [{ path: 'project.json', mode: '100644', object: 'b'.repeat(40) }],
      treeDigest: sourceDigest(source.id),
    };
  }
  async readJson(repo: string, _tree: FetchedSource, entry: string): Promise<unknown> {
    return entry === 'farm-sources.json' ? this.manifests.get(repo) : { name: 'demo' };
  }
  async git(): Promise<Buffer> {
    return Buffer.from('a'.repeat(40));
  }
}

const config: SourceConfiguration = {
  schemaVersion: 1,
  revision: 1,
  pollIntervalMs: 1_000,
  sources: [
    { id: 'demo', kind: 'pack', repo: 'https://example.test/owner/demo' },
    { id: 'helper', kind: 'helper', repo: 'https://example.test/owner/helper' },
    { id: 'unrelated', kind: 'helper', repo: 'https://example.test/owner/unrelated' },
  ],
  packs: { demo: { sourceId: 'demo', entry: '.' } },
};

test('new source generations preserve run locks and isolate failed unrelated repositories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-authority-test-'));
  try {
    let now = Date.now();
    const git = new FixtureSources(root);
    const authority = await SourceAuthority.open(config, root, git, () => now);
    await authority.reconcile();
    const first = await authority.lock({ project: 'demo', runId: 'first' });
    git.denied.add('unrelated');
    git.commits.set('demo', 'c'.repeat(40));
    await authority.reconcile();
    const next = await authority.lock({ project: 'demo', runId: 'next' });
    assert.notEqual(first.entries[0].commit, next.entries[0].commit);
    assert.equal(first.entries[0].commit, 'a'.repeat(40));
    assert.equal(
      authority.resolutions().find((row) => row.sourceId === 'unrelated')?.status,
      'failed',
    );
    assert.deepEqual(await authority.lock({ project: 'demo', runId: 'next' }), next);
    now += 2_001;
    await assert.rejects(authority.lock({ project: 'demo' }), /stale/);
    assert.equal(authority.resolutions().find((row) => row.sourceId === 'demo')?.status, 'stale');
    await authority.reconcile(['demo']);
    assert.equal((await authority.lock({ project: 'demo' })).entries[0].commit, 'c'.repeat(40));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selected dependencies, missing entries, undeclared sources and cycles refuse complete lock publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-closure-test-'));
  try {
    const git = new FixtureSources(root);
    git.manifests.set(config.sources[0].repo, {
      schemaVersion: 1,
      dependencies: [{ sourceId: 'helper', entry: '.' }],
    });
    const authority = await SourceAuthority.open(config, root, git);
    await authority.reconcile();
    const complete = await authority.lock({ project: 'demo' });
    assert.deepEqual(
      complete.entries.map((entry) => entry.sourceId),
      ['demo', 'helper'],
    );
    assert.deepEqual(authority.affectedProjects('helper'), ['demo']);
    assert.deepEqual(authority.affectedProjects('unrelated'), []);
    assert.throws(() => authority.affectedProjects('unknown'), /Undeclared/);
    git.denied.add('helper');
    await authority.reconcile(['helper']);
    await assert.rejects(authority.lock({ project: 'demo' }), /unavailable/);
    assert.deepEqual(authority.locks(), [complete]);
    git.denied.clear();
    git.manifests.set(config.sources[1].repo, {
      schemaVersion: 1,
      dependencies: [{ sourceId: 'demo', entry: '.' }],
    });
    await authority.reconcile();
    await assert.rejects(authority.lock({ project: 'demo' }), /Cyclic/);
    git.manifests.set(config.sources[0].repo, {
      schemaVersion: 1,
      dependencies: [{ sourceId: 'undeclared', entry: '.' }],
    });
    await authority.reconcile(['demo']);
    await assert.rejects(authority.lock({ project: 'demo' }), /unavailable/);
    assert.match(
      authority.resolutions().find((row) => row.sourceId === 'demo')!.reason!,
      /undeclared/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
