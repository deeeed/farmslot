import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isRecord } from '@farmslot/protocol/recipe';

import { execLocal } from '../../core/exec.js';

import {
  workspaceMetadataCommand,
  type WorkspaceMetadataRoot,
} from './workspace-metadata-program.js';

test('one metadata command reads normal and linked roots, detects changes, and isolates absent roots', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "metadata ' roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'normal');
  const linked = path.join(root, 'linked');
  const gitDir = path.join(root, 'shared/worktrees/linked');
  await mkdir(path.join(repo, '.git/refs/heads'), { recursive: true });
  await writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(repo, '.git/refs/heads/main'), 'a'.repeat(40) + '\n');
  await mkdir(linked);
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(linked, '.git'), 'gitdir: ../shared/worktrees/linked\n');
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(gitDir, 'commondir'), '../..\n');
  const packed = path.join(root, 'shared/packed-refs');
  await writeFile(packed, 'a'.repeat(40) + ' refs/heads/main\n');
  const roots: WorkspaceMetadataRoot[] = [repo, linked, path.join(root, 'missing')].map(
    (repo, i) => ({
      slotId: `root-${i}`,
      machine: 'fixture',
      repo,
      defaultBranch: 'main',
    }),
  );
  const read = async () => {
    const result = await execLocal(workspaceMetadataCommand(roots), { timeout: 1000 });
    assert.equal(result.exitCode, 0, result.stderr);
    const rows: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(rows));
    const values = new Map<string, unknown>();
    for (const row of rows) {
      assert.ok(isRecord(row));
      assert.equal(typeof row.slotId, 'string');
      values.set(String(row.slotId), row.version);
    }
    return values;
  };
  const first = await read();
  assert.equal(typeof first.get('root-0'), 'string');
  assert.equal(typeof first.get('root-1'), 'string');
  assert.equal(first.get('root-2'), null);
  assert.deepEqual(await read(), first);
  await writeFile(path.join(repo, '.git/refs/heads/main'), 'b'.repeat(40) + '\n');
  await writeFile(path.join(gitDir, 'index'), 'changed index');
  const changed = await read();
  assert.notEqual(changed.get('root-0'), first.get('root-0'));
  assert.notEqual(changed.get('root-1'), first.get('root-1'));
  await writeFile(packed, 'c'.repeat(40) + ' refs/heads/main\n');
  const repacked = await read();
  assert.notEqual(repacked.get('root-1'), changed.get('root-1'));
  await writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/.invalid\n');
  assert.equal(
    (await read()).get('root-0'),
    null,
    'reftable compatibility HEAD cannot justify reuse',
  );
});

test('local and remote metadata expose alternates in the linked common directory', async (t) => {
  const { localWorkspaceVersion } = await import('./workspace-version.js');
  const { makeVars } = await import('../../runners/test-fixtures.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'metadata-alternates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'linked');
  const common = path.join(root, 'common');
  const gitDir = path.join(common, 'worktrees/linked');
  await mkdir(repo);
  await mkdir(gitDir, { recursive: true });
  await mkdir(path.join(common, 'objects/info'), { recursive: true });
  await writeFile(path.join(repo, '.git'), 'gitdir: ../common/worktrees/linked\n');
  await writeFile(path.join(gitDir, 'HEAD'), 'a'.repeat(40) + '\n');
  await writeFile(path.join(gitDir, 'commondir'), '../..\n');
  const alternates = path.join(common, 'objects/info/alternates');
  await writeFile(alternates, '');
  const vars = makeVars({ host: 'localhost', machine: 'fixture', remoteRepo: repo });
  const roots: WorkspaceMetadataRoot[] = [
    { slotId: vars.slotId, machine: vars.machine, repo, defaultBranch: 'main' },
  ];
  const remote = await execLocal(workspaceMetadataCommand(roots), { timeout: 5000 });
  assert.equal(remote.exitCode, 0, remote.stderr);
  const rows: unknown = JSON.parse(remote.stdout);
  assert.ok(Array.isArray(rows) && isRecord(rows[0]));
  assert.equal(rows[0].alternatesPath, alternates);
  const local = await localWorkspaceVersion(vars, 'main');
  assert.equal(local?.alternatesPath, alternates);
  await rm(alternates);
  assert.equal((await localWorkspaceVersion(vars, 'main', local))?.alternatesPath, undefined);
  const cleared: unknown = JSON.parse(
    (await execLocal(workspaceMetadataCommand(roots), { timeout: 5000 })).stdout,
  );
  assert.ok(Array.isArray(cleared) && isRecord(cleared[0]));
  assert.equal(cleared[0].alternatesPath, undefined);
});

test('local and remote metadata bypass ancestry caches for shallow, grafted and replaced graphs', async (t) => {
  const { localWorkspaceVersion } = await import('./workspace-version.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'metadata-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'linked'),
    common = path.join(root, 'shared'),
    gitDir = path.join(common, 'worktrees/linked');
  await mkdir(repo);
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(repo, '.git'), `gitdir: ${gitDir}\n`);
  await writeFile(path.join(gitDir, 'commondir'), '../..\n');
  await writeFile(path.join(gitDir, 'HEAD'), 'a'.repeat(40) + '\n');
  const vars = { host: 'localhost', machine: 'fixture', sshTarget: '', remoteRepo: repo };
  const remote = async () => {
    const result = await execLocal(
      workspaceMetadataCommand([
        { slotId: 'graph', machine: 'fixture', repo, defaultBranch: 'main' },
      ]),
      { timeout: 1000 },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const rows: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(rows));
    const row: unknown = rows[0];
    assert.ok(isRecord(row));
    return row.ancestryCacheable;
  };
  assert.equal((await localWorkspaceVersion(vars, 'main'))?.ancestryCacheable, true);
  assert.equal(await remote(), true);
  for (const file of ['shallow', 'info/grafts', 'refs/replace']) {
    const target = path.join(common, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (file === 'refs/replace') await mkdir(target);
    else await writeFile(target, 'graph rewrite\n');
    assert.equal((await localWorkspaceVersion(vars, 'main'))?.ancestryCacheable, false, file);
    assert.equal(await remote(), false, file);
    await rm(target, { recursive: true, force: true });
  }
});

test('packed-only replacement refs in a linked common repository disable local and remote reuse', async (t) => {
  const { localWorkspaceVersion } = await import('./workspace-version.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'metadata-packed-replace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'linked'),
    common = path.join(root, 'shared'),
    gitDir = path.join(common, 'worktrees/linked');
  await mkdir(repo);
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(repo, '.git'), `gitdir: ${gitDir}\n`);
  await writeFile(path.join(gitDir, 'commondir'), '../..\n');
  await writeFile(path.join(gitDir, 'HEAD'), 'a'.repeat(40) + '\n');
  await writeFile(
    path.join(common, 'packed-refs'),
    '# pack-refs with: peeled fully-peeled sorted\n' +
      'b'.repeat(40) +
      ' refs/replace/' +
      'a'.repeat(40) +
      '\n',
  );
  const vars = { host: 'localhost', machine: 'fixture', sshTarget: '', remoteRepo: repo };
  const local = await localWorkspaceVersion(vars, 'main');
  assert.ok(local);
  const readRemote = async (previous?: typeof local) => {
    const result = await execLocal(
      workspaceMetadataCommand([
        { slotId: 'packed', machine: 'fixture', repo, defaultBranch: 'main', previous },
      ]),
      { timeout: 1000 },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const rows: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(rows));
    const row: unknown = rows[0];
    assert.ok(
      isRecord(row) &&
        typeof row.version === 'string' &&
        typeof row.ancestryCacheable === 'boolean',
    );
    return { version: row.version, ancestryCacheable: row.ancestryCacheable };
  };
  const remote = await readRemote();
  assert.deepEqual(
    { local: local.ancestryCacheable, remote: remote.ancestryCacheable },
    { local: false, remote: false },
  );
  const packed = path.join(common, 'packed-refs');
  // chmod changes neither mtime nor size: unchanged generations must not rescan file contents.
  await chmod(packed, 0o000);
  try {
    assert.deepEqual(await localWorkspaceVersion(vars, 'main', local), local);
    assert.deepEqual(await readRemote(remote), remote);
  } finally {
    await chmod(packed, 0o600);
  }
  await writeFile(packed, 'c'.repeat(40) + ' refs/heads/main\n');
  assert.equal((await localWorkspaceVersion(vars, 'main', local))?.ancestryCacheable, true);
  assert.equal(
    (await readRemote(remote)).ancestryCacheable,
    true,
    'changed packed refs must be read again',
  );
});
