import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { SourceConfiguration, SourceDeclaration } from '@farmslot/protocol';
import { type FetchedSource, sourceDigest, SourceGitStore } from '@farmslot/slot-config/sources';

import { SourceAuthority } from './authority.js';
import { assertSourcePinTarget, type SourcePinTargetState } from './pin-target.js';
import { sourceTestPlan } from './source.test-support.js';

class FixtureSources extends SourceGitStore {
  commits = new Map<string, string>();
  manifests = new Map<string, unknown>();
  projects = new Map<string, unknown>();
  denied = new Set<string>();
  held?: { id: string; completion: Promise<void> };
  async resolve(source: SourceDeclaration, ref = source.ref ?? 'main'): Promise<FetchedSource> {
    if (this.held?.id === source.id) await this.held.completion;
    if (this.denied.has(source.id)) throw new Error('fixture source unavailable');
    return {
      commit:
        this.commits.get(`${source.id}@${ref}`) ?? this.commits.get(source.id) ?? 'a'.repeat(40),
      objectFormat: 'sha1',
      refKind: 'branch',
      refObject:
        this.commits.get(`${source.id}@${ref}`) ?? this.commits.get(source.id) ?? 'a'.repeat(40),
      files: [{ path: 'project.json', mode: '100644', object: 'b'.repeat(40) }],
      treeDigest: sourceDigest(source.id),
    };
  }
  async readJson(repo: string, _tree: FetchedSource, entry: string): Promise<unknown> {
    return entry === 'farm-sources.json'
      ? this.manifests.get(repo)
      : (this.projects.get(repo) ?? {
          name: 'demo',
          qa: {
            default_profile: 'smoke',
            profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa-checklist' }],
          },
        });
  }
  async git(): Promise<Buffer> {
    return Buffer.from('a'.repeat(40));
  }
}

function unpinRequest<T extends { ref: string }>(request: T): Omit<T, 'ref'> {
  const { ref: _ref, ...params } = request;
  return params;
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

test('run selections remain provisional, roll back a rejected create and publish as one revision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-atomic-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new FixtureSources(root);
  git.commits.set('demo@experiment', 'c'.repeat(40));
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const prepared = await authority.prepareRunSelections(
    'new-run',
    [
      { sourceId: 'demo', selection: 'branch', ref: 'experiment' },
      { sourceId: 'helper', selection: 'main' },
    ],
    'owner',
  );
  const lock = await authority.lock(
    { project: 'demo', runId: 'new-run', nodeId: 'node-a' },
    prepared,
  );
  assert.equal(lock.entries[0].commit, 'c'.repeat(40));
  assert.equal(lock.entries[0].pin?.baseMainCommit, 'a'.repeat(40));
  assert.deepEqual(authority.pins(), []);
  assert.deepEqual(authority.locks(), []);
  await assert.rejects(
    authority.publishPins(
      prepared,
      [lock],
      () => undefined,
      () => {
        throw new Error('queue ownership changed');
      },
    ),
    /queue ownership changed/,
  );
  const restored = await SourceAuthority.open(config, root, git);
  assert.equal(restored.pinRevision(), 0);
  assert.deepEqual(restored.pins(), []);
  assert.deepEqual(restored.locks(), []);
  const result = await authority.publishPins(
    prepared,
    [lock],
    () => undefined,
    () => ({ id: 'new-run' }),
  );
  assert.equal(result.id, 'new-run');
  assert.equal(authority.pinRevision(), 1);
  assert.equal(authority.pins().length, 2);
  assert(authority.pins().every((pin) => pin.revision === 1 && pin.targetId === 'new-run'));
  assert.deepEqual(authority.locks(), [lock]);
});

test('failed or duplicate source selections never publish a partial run pin batch', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-refused-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new FixtureSources(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  git.denied.add('helper');
  await assert.rejects(
    authority.prepareRunSelections(
      'new-run',
      [
        { sourceId: 'demo', selection: 'branch', ref: 'experiment' },
        { sourceId: 'helper', selection: 'branch', ref: 'experiment' },
      ],
      'owner',
    ),
    /pushed branch/,
  );
  await assert.rejects(
    authority.prepareRunSelections(
      'new-run',
      [
        { sourceId: 'demo', selection: 'main' },
        { sourceId: 'demo', selection: 'branch', ref: 'experiment' },
      ],
      'owner',
    ),
    /each declared source once/,
  );
  assert.equal(authority.pinRevision(), 0);
  assert.deepEqual(authority.pins(), []);
  assert.deepEqual(authority.locks(), []);
});

test('a broader pin racing creation refuses the old plan before registration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-create-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new FixtureSources(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const prepared = await authority.prepareRunSelections(
    'new-run',
    [{ sourceId: 'demo', selection: 'branch', ref: 'experiment' }],
    'owner',
  );
  const lock = await authority.lock({ project: 'demo', runId: 'new-run' }, prepared);
  await authority.mutatePin(
    {
      sourceId: 'demo',
      ref: 'broader',
      scope: 'farm',
      targetId: 'farm',
      operationId: 'broader',
      expectedDeclarationRevision: 1,
      expectedPinRevision: 0,
    },
    'owner',
    'branch',
    () => undefined,
  );
  let registered = false;
  await assert.rejects(
    authority.publishPins(
      prepared,
      [lock],
      () => undefined,
      () => {
        registered = true;
      },
    ),
    /Stale source/,
  );
  assert.equal(registered, false);
  assert(authority.pins().every((pin) => pin.scope === 'farm'));
  assert.deepEqual(authority.locks(), []);
});

test('concurrent lost-ack retries publish their prepared mutation only once', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-pin-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new FixtureSources(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const params = {
    sourceId: 'demo',
    ref: 'experiment',
    scope: 'farm' as const,
    targetId: 'farm',
    operationId: 'retry',
    expectedDeclarationRevision: 1,
    expectedPinRevision: 0,
  };
  const first = await authority.preparePinMutation(params, 'owner', 'branch', () => undefined);
  const retry = await authority.preparePinMutation(params, 'owner', 'branch', () => undefined);
  assert('pins' in first && 'pins' in retry);
  let publications = 0;
  const results = await Promise.all(
    [first, retry].map((prepared) =>
      authority.publishPins(
        prepared,
        [],
        () => undefined,
        () => {
          publications++;
          return prepared.operation!.result;
        },
      ),
    ),
  );
  assert.deepEqual(results[0], results[1]);
  assert.equal(publications, 1);
  assert.equal(authority.pinRevision(), 1);
});

test('ownership revoked during durable staging refuses publication and restores the prior state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-pin-owner-change-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new FixtureSources(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const prepared = await authority.prepareRunSelections(
    'owned-run',
    [{ sourceId: 'demo', selection: 'main' }],
    'owner',
  );
  const lock = await authority.lock({ project: 'demo', runId: 'owned-run' }, prepared);
  let checks = 0;
  let published = false;
  await assert.rejects(
    authority.publishPins(
      prepared,
      [lock],
      () => {
        if (++checks === 2) throw new Error('target owner changed');
      },
      () => {
        published = true;
      },
    ),
    /target owner changed/,
  );
  assert.equal(published, false);
  const reopened = await SourceAuthority.open(config, root, git);
  assert.equal(reopened.pinRevision(), 0);
  assert.deepEqual(reopened.pins(), []);
  assert.deepEqual(reopened.locks(), []);
});

test('restart removes abandoned creation pins while retaining recorded run selections', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-create-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new FixtureSources(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  for (const runId of ['recorded', 'abandoned']) {
    const prepared = await authority.prepareRunSelections(
      runId,
      [{ sourceId: 'demo', selection: 'branch', ref: 'experiment' }],
      'owner',
    );
    const lock = await authority.lock({ project: 'demo', runId }, prepared);
    await authority.publishPins(
      prepared,
      [lock],
      () => undefined,
      () => runId,
    );
  }
  const reopened = await SourceAuthority.open(config, root, git);
  await reopened.recoverRunCreations((runId) => runId === 'recorded');
  assert.deepEqual(
    reopened.pins().map((pin) => pin.targetId),
    ['recorded'],
  );
  assert.deepEqual(
    reopened.locks().map((lock) => lock.context.runId),
    ['recorded'],
  );
  assert.equal(reopened.pinRevision(), 2);
  const persisted = await SourceAuthority.open(config, root, git);
  assert.deepEqual(persisted.pins(), reopened.pins());
  await persisted.recoverRunCreations(() => false);
  assert.deepEqual(
    persisted.pins(),
    reopened.pins(),
    'cleared creation journals cannot remove retained pins',
  );
});

test('locked packs enforce the shared QA/portability gate before publishing a new generation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-pack-quality-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new FixtureSources(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const original = await authority.lock({ project: 'demo', runId: 'admitted' });
  git.commits.set('demo', 'c'.repeat(40));
  for (const project of [
    { name: 'demo' },
    { name: 'demo', qa: { default_profile: 'missing', profiles: [] } },
  ]) {
    git.projects.set(config.sources[0].repo, project);
    await authority.reconcile(['demo']);
    const failure = authority.resolutions().find((row) => row.sourceId === 'demo');
    assert.equal(failure?.status, 'failed');
    assert.match(failure?.reason ?? '', /qa flow/);
    await assert.rejects(authority.lock({ project: 'demo', runId: 'new' }), /unavailable/);
    assert.deepEqual(authority.locks(), [original]);
    assert.equal(original.entries[0].commit, 'a'.repeat(40));
  }
  git.projects.delete(config.sources[0].repo);
  await authority.reconcile(['demo']);
  assert.equal(
    (await authority.lock({ project: 'demo', runId: 'new' })).entries[0].commit,
    'c'.repeat(40),
  );
});

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

test('healthy sources keep polling across intervals while an unrelated fetch remains pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-independent-test-'));
  let finishFetch!: () => void;
  const held = new Promise<void>((resolve) => {
    finishFetch = resolve;
  });
  let stop: (() => void) | undefined;
  let authority: SourceAuthority | undefined;
  try {
    let now = Date.now();
    const git = new FixtureSources(root);
    authority = await SourceAuthority.open(config, root, git, () => now);
    await authority.reconcile();
    git.held = { id: 'unrelated', completion: held };
    stop = authority.startReconciliation((_, error) => {
      throw error;
    });
    for (let pass = 1; pass <= 3; pass++) {
      now += 2_001;
      git.commits.set('demo', String(pass).repeat(40));
      t.mock.timers.tick(config.pollIntervalMs);
      const deadline = Date.now() + 500;
      while (
        authority.resolutions().find((record) => record.sourceId === 'demo')?.resolvedAt !==
        new Date(now).toISOString()
      ) {
        assert.ok(Date.now() < deadline, 'healthy polls must continue during the held fetch');
        await setImmediate();
      }
      assert.equal(
        (await authority.lock({ project: 'demo' })).entries[0].commit,
        String(pass).repeat(40),
      );
      await setImmediate();
    }
    assert.equal(
      authority.resolutions().find((record) => record.sourceId === 'unrelated')?.status,
      'stale',
    );
  } finally {
    stop?.();
    finishFetch();
    // Drain outstanding persistence before deleting its fixture.
    await authority?.reconcile();
    await rm(root, { recursive: true, force: true });
  }
});

test('inherited dispatch prompts include the configured shared pack in the same lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-shared-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const declarations: SourceConfiguration = {
    ...config,
    sources: [
      ...config.sources,
      { id: 'framework', kind: 'pack', repo: 'https://example.test/owner/framework' },
    ],
    packs: { ...config.packs, 'farmslot-farm': { sourceId: 'framework', entry: '.' } },
  };
  const git = new FixtureSources(root);
  const authority = await SourceAuthority.open(declarations, root, git);
  await authority.reconcile();
  const lock = await authority.lock({ project: 'demo' });
  assert.deepEqual(
    lock.entries.map((entry) => entry.sourceId),
    ['demo', 'framework'],
  );
  assert.deepEqual(lock.packBindings['farmslot-farm'], declarations.packs['farmslot-farm']);
  git.denied.add('framework');
  await authority.reconcile(['framework']);
  await assert.rejects(authority.lock({ project: 'demo' }), /unavailable/);
});

class BranchFixtures extends FixtureSources {
  refs = new Map([
    ['main', 'a'.repeat(40)],
    ['experiment/farm', 'b'.repeat(40)],
    ['experiment/run', 'c'.repeat(40)],
  ]);
  override async resolve(source: SourceDeclaration, ref = 'main'): Promise<FetchedSource> {
    const tree = await super.resolve(source);
    const commit = this.refs.get(ref);
    if (!commit) throw new Error('branch missing upstream');
    return {
      ...tree,
      commit,
      refObject: commit,
      treeDigest: sourceDigest({ id: source.id, commit }),
    };
  }
}

test('pin operations persist exact branch/base, precedence and main overrides without rewriting prior locks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-pins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new BranchFixtures(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const original = await authority.lock({ project: 'demo', runId: 'original' });
  const request = {
    sourceId: 'demo',
    scope: 'farm' as const,
    targetId: 'farm',
    ref: 'experiment/farm',
    expectedDeclarationRevision: 1,
    expectedPinRevision: 0,
    operationId: 'farm-pin',
  };
  const farm = await authority.mutatePin(request, 'operator', 'branch', () => {});
  assert.equal(farm.pin.baseMainCommit, 'a'.repeat(40));
  assert.equal(farm.pinRevision, 1);
  assert.equal(
    (await authority.lock({ project: 'demo', nodeId: 'node-1' })).entries[0].commit,
    'b'.repeat(40),
  );
  assert.equal(original.entries[0].commit, 'a'.repeat(40));
  const node = await authority.mutatePin(
    {
      ...unpinRequest(request),
      scope: 'node',
      targetId: 'node-1',
      operationId: 'node-main',
      expectedPinRevision: 1,
    },
    'operator',
    'main',
    () => {},
  );
  assert.equal(node.pin.selection, 'main');
  assert.equal(
    (await authority.lock({ project: 'demo', nodeId: 'node-1' })).entries[0].commit,
    'a'.repeat(40),
  );
  const run = await authority.mutatePin(
    {
      ...request,
      scope: 'run',
      targetId: 'run-1',
      ref: 'experiment/run',
      operationId: 'run-pin',
      expectedPinRevision: 2,
    },
    'operator',
    'branch',
    () => {},
  );
  assert.equal(
    (await authority.lock({ project: 'demo', nodeId: 'node-1', runId: 'run-1' })).entries[0].commit,
    'c'.repeat(40),
  );
  assert.equal(
    (await authority.lock({ project: 'demo', nodeId: 'node-1', runId: 'sibling' })).entries[0]
      .commit,
    'a'.repeat(40),
  );
  assert.equal(
    (await authority.lock({ project: 'demo', nodeId: 'node-2' })).entries[0].commit,
    'b'.repeat(40),
  );
  const reopened = await SourceAuthority.open(config, root, git);
  assert.deepEqual(reopened.pins(), authority.pins());
  assert.equal(reopened.pinRevision(), run.pinRevision);
  git.refs.delete('experiment/farm');
  assert.deepEqual(
    await reopened.mutatePin(request, 'operator', 'branch', () => {}),
    farm,
    'a retry returns its saved result without refetch',
  );
  await assert.rejects(
    reopened.mutatePin({ ...request, ref: 'experiment/run' }, 'operator', 'branch', () => {}),
    /different request/,
  );
  await assert.rejects(
    reopened.mutatePin({ ...request, operationId: 'stale' }, 'operator', 'branch', () => {}),
    /Stale/,
  );
  await assert.rejects(
    reopened.mutatePin(
      { ...request, ref: '/tmp/source', expectedPinRevision: 3, operationId: 'local' },
      'operator',
      'branch',
      () => {},
    ),
    /without local paths/,
  );
});

test('pin target refusal happens before fetch and target changes during fetch refuse publication', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-pin-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new BranchFixtures(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const request = {
    sourceId: 'demo',
    scope: 'run' as const,
    targetId: 'run-1',
    ref: 'experiment/run',
    expectedDeclarationRevision: 1,
    expectedPinRevision: 0,
    operationId: 'run-pin-race',
  };
  const state: SourcePinTargetState = { knownNodes: [], activatedAt: authority.activatedAt() };
  const guard = () => assertSourcePinTarget(request, state);
  const originalResolve = git.resolve.bind(git);
  let fetched = 0;
  let enterFetch!: () => void;
  let finishFetch!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterFetch = resolve;
  });
  const completion = new Promise<void>((resolve) => {
    finishFetch = resolve;
  });
  git.resolve = async (source, ref) => {
    fetched++;
    enterFetch();
    await completion;
    return originalResolve(source, ref);
  };
  await assert.rejects(authority.mutatePin(request, 'operator', 'branch', guard), /Unknown/);
  assert.equal(fetched, 0);
  const run: NonNullable<SourcePinTargetState['run']> = {
    id: request.targetId,
    sourcePlan: sourceTestPlan(),
    createdAt: authority.activatedAt(),
    status: 'created',
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: 'codex', runnerSessionId: null },
  };
  state.run = run;
  const mutation = authority.mutatePin(request, 'operator', 'branch', guard);
  try {
    await entered;
    run.status = 'monitoring';
  } finally {
    finishFetch();
  }
  await assert.rejects(mutation, /admitted or have effects/);
  assert.equal(authority.pinRevision(), 0);
  assert.deepEqual(authority.pins(), []);
  assert.equal(authority.locks().length, 0);
});

test('polling discovers new pins, advances branches without changing their base and isolates failed refs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-pin-poll-'));
  const git = new BranchFixtures(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const original = await authority.lock({ project: 'demo', runId: 'admitted' });
  const stop = authority.startReconciliation((_, error) => {
    throw error;
  });
  try {
    const request = {
      sourceId: 'demo',
      scope: 'farm' as const,
      targetId: 'farm',
      ref: 'experiment/farm',
      expectedDeclarationRevision: 1,
      expectedPinRevision: 0,
      operationId: 'polled-farm-pin',
    };
    const first = await authority.mutatePin(request, 'operator', 'branch', () => {});
    await authority.mutatePin(
      {
        ...unpinRequest(request),
        scope: 'node',
        targetId: 'node-main',
        expectedPinRevision: 1,
        operationId: 'polled-node-main',
      },
      'operator',
      'main',
      () => {},
    );
    await authority.reconcile();
    git.refs.set('main', 'd'.repeat(40));
    git.refs.set('experiment/farm', 'e'.repeat(40));
    t.mock.timers.tick(config.pollIntervalMs);
    const waitFor = async (ref: string, status: 'resolved' | 'failed', commit?: string) => {
      const deadline = Date.now() + 500;
      while (
        !authority
          .resolutions()
          .some(
            (row) =>
              row.sourceId === 'demo' &&
              row.ref === ref &&
              row.status === status &&
              (!commit || row.commit === commit),
          )
      ) {
        assert.ok(Date.now() < deadline, `poll must reconcile ${ref}`);
        await setImmediate();
      }
      await setImmediate();
    };
    await waitFor('experiment/farm', 'resolved', 'e'.repeat(40));
    await waitFor('main', 'resolved', 'd'.repeat(40));
    assert.deepEqual(
      authority.pins().find((pin) => pin.scope === 'farm'),
      first.pin,
    );
    assert.equal(first.pin.baseMainCommit, 'a'.repeat(40));
    assert.equal((await authority.lock({ project: 'demo' })).entries[0].commit, 'e'.repeat(40));
    assert.equal(original.entries[0].commit, 'a'.repeat(40));
    git.refs.delete('experiment/farm');
    t.mock.timers.tick(config.pollIntervalMs);
    await waitFor('experiment/farm', 'failed');
    await assert.rejects(authority.lock({ project: 'demo' }), /unavailable/);
    assert.equal(
      (await authority.lock({ project: 'demo', nodeId: 'node-main' })).entries[0].commit,
      'd'.repeat(40),
    );
  } finally {
    stop();
    await authority.reconcile();
    await rm(root, { recursive: true, force: true });
  }
});

test('a declaration revision cannot silently apply an old pin to its replacement repository', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-pin-declaration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new BranchFixtures(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const request = {
    sourceId: 'demo',
    scope: 'farm' as const,
    targetId: 'farm',
    ref: 'experiment/farm',
    expectedDeclarationRevision: 1,
    expectedPinRevision: 0,
    operationId: 'original-repo-pin',
  };
  await authority.mutatePin(request, 'operator', 'branch', () => {});
  const original = await authority.lock({ project: 'demo', runId: 'original' });
  const revised = {
    ...config,
    revision: 2,
    sources: config.sources.map((source) =>
      source.id === 'demo' ? { ...source, repo: 'https://example.test/owner/replacement' } : source,
    ),
  };
  const reopened = await SourceAuthority.open(revised, root, git);
  await reopened.reconcile();
  await assert.rejects(reopened.lock({ project: 'demo' }), /prior declaration/);
  assert.deepEqual(
    reopened.locks().find((lock) => lock.context.runId === 'original'),
    original,
  );
  await reopened.mutatePin(
    {
      ...unpinRequest(request),
      expectedDeclarationRevision: 2,
      expectedPinRevision: 1,
      operationId: 'replacement-main',
    },
    'operator',
    'main',
    () => {},
  );
  const current = await reopened.lock({ project: 'demo' });
  assert.equal(current.entries[0].repo, revised.sources[0].repo);
  assert.equal(current.entries[0].effectiveRef, 'main');
});

test('admission seals serialize with pins and reject a lock after its selected ref changes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-admission-seal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = new BranchFixtures(root);
  const authority = await SourceAuthority.open(config, root, git);
  await authority.reconcile();
  const lock = await authority.lock({ project: 'demo', runId: 'admitted', nodeId: 'node-1' });
  let release!: () => void;
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const events: string[] = [];
  const freezing = authority.withCurrentLock(lock, async () => {
    events.push('freeze');
    entered();
    await holding;
    events.push('frozen');
  });
  await started;
  const pinning = authority.mutatePin(
    {
      sourceId: 'demo',
      scope: 'farm',
      targetId: 'farm',
      ref: 'experiment/farm',
      expectedDeclarationRevision: 1,
      expectedPinRevision: 0,
      operationId: 'pin-after-freeze',
    },
    'operator',
    'branch',
    () => {
      events.push('pin-check');
    },
  );
  try {
    await setImmediate();
    assert.deepEqual(events, ['freeze']);
    assert.equal(authority.pinRevision(), 0);
  } finally {
    release();
  }
  await freezing;
  await pinning;
  assert.deepEqual(events.slice(0, 3), ['freeze', 'frozen', 'pin-check']);
  await assert.rejects(
    authority.withCurrentLock(lock, async () => {
      throw new Error('old admission callback must not run');
    }),
    /changed before admission/,
  );
  assert.equal(lock.entries[0].effectiveRef, 'main');
  const current = await authority.lock({ project: 'demo', runId: 'next', nodeId: 'node-1' });
  let admitted = false;
  await authority.withCurrentLock(current, async () => {
    admitted = true;
  });
  assert.equal(admitted, true);
});

test('published writes and reconciliation polls notify source observers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-observers-'));
  const authority = await SourceAuthority.open(config, root, new FixtureSources(root));
  let stop: (() => void) | undefined;
  try {
    let notified = 0;
    authority.observe(() => notified++);
    await authority.reconcile();
    assert(notified > 0, 'a published resolution notifies');
    const before = notified;
    stop = authority.startReconciliation(() => undefined);
    assert(notified > before, 'each poll notifies, so time-derived staleness is observed');
  } finally {
    stop?.();
    // Drain outstanding persistence before deleting its fixture.
    await authority.reconcile();
    await rm(root, { recursive: true, force: true });
  }
});
