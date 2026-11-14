import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isRecord } from '@farmslot/protocol/recipe';

const source =
  process.env.BOUNDARY_SOURCE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('authenticated Git child boundary RPC proof', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-child-rpc-'));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FARMSLOT_') || key === 'TMUX' || key === 'TMUX_PANE')
      delete process.env[key];
  }
  Object.assign(process.env, {
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_ROOT: root,
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  for (const name of ['pool', 'projects/proof', 'home', 'bin', 'files', 'git'])
    await mkdir(path.join(root, name), { recursive: true });
  for (const name of [
    'scripts',
    'packages',
    'services',
    'node_modules',
    'schemas',
    'package.json',
    'CLAUDE.md',
  ])
    await symlink(path.join(source, name), path.join(root, name));
  await writeFile(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  process.env.PATH = path.join(root, 'bin') + ':' + process.env.PATH;
  const repo = path.join(root, 'git');
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
      { encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repo, 'tracked'), 'baseline\n');
  git('add', '.');
  git('commit', '-qm', 'test: baseline');
  const repoKey = createHash('sha256')
    .update(path.resolve(repo, git('rev-parse', '--git-common-dir')))
    .digest('hex');
  const badRef = `refs/farmslot/parked/proof-park/v1/${repoKey}/bad-metadata`;
  git('update-ref', badRef, 'HEAD');
  const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {
    input: 'not-json',
    encoding: 'utf8',
  }).trim();
  git('update-ref', badRef.replace('/parked/', '/parked-meta/'), blob);
  await writeFile(
    path.join(root, 'projects/proof/project.json'),
    JSON.stringify({ name: 'proof', default_branch: 'main' }),
  );
  await writeFile(
    path.join(root, 'pool/local.json'),
    JSON.stringify({
      machine: os.hostname(),
      host: 'localhost',
      os: 'darwin',
      project: 'proof',
      platform: 'cli',
      slots: [
        { id: 'proof-files', repo: path.join(root, 'files') },
        { id: 'proof-park', repo },
      ],
    }),
  );
  const names = Array.from({ length: 2048 }, (_, i) => `entry-${i}-${'x'.repeat(200)}`);
  for (let i = 0; i < names.length; i += 64)
    await Promise.all(names.slice(i, i + 64).map((name) => mkdir(path.join(root, 'files', name))));
  await import(
    pathToFileURL(path.join(source, 'services/gateway/src/runtime/mock-pty.test-support.ts')).href
  );
  const helpers: typeof import('../runtime/native-proof-fixture.live-support.js') = await import(
    pathToFileURL(
      path.join(source, 'services/gateway/src/runtime/native-proof-fixture.live-support.ts'),
    ).href
  );
  const fixture = await helpers.createNativeProofFixture(t, root);
  const completed: string[] = [];

  await t.test('early Git stdin closure leaves the authenticated gateway usable', async () => {
    const listed = await fixture.client.call('fs.list', {
      slotId: 'proof-files',
      path: '.',
      includeIgnored: true,
    });
    assert.ok(isRecord(listed) && Array.isArray(listed.entries));
    assert.equal(listed.entries.length, names.length);
    await fixture.client.call('gateway.status', {});
    completed.push('git-input-closed');
  });
  await t.test('a child that exits before producing JSON reports its actual failure', async () => {
    const retained = repo + '-retained';
    await rename(repo, retained);
    try {
      await assert.rejects(
        fixture.client.call('slot.parked', { slotId: 'proof-park', action: 'list' }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /proof-park/);
          assert.match(error.message, /failed \(exit 1\)/);
          assert.match(error.message, /ENOENT/);
          assert.doesNotMatch(error.message, /not valid JSON/);
          return true;
        },
      );
    } finally {
      await rename(retained, repo);
    }
    await fixture.client.call('gateway.status', {});
    completed.push('child-failed-before-json');
  });
  await t.test('malformed stored receipt names its Git ref', async () => {
    await assert.rejects(
      fixture.client.call('slot.parked', { slotId: 'proof-park', action: 'list' }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(badRef), error.message);
        assert.match(error.message, /receipt/);
        return true;
      },
    );
    completed.push('stored-receipt-context');
  });
  assert.deepEqual(completed, [
    'git-input-closed',
    'child-failed-before-json',
    'stored-receipt-context',
  ]);
  assert.ok(isRecord(await fixture.client.call('gateway.status', {})));
  console.log(
    JSON.stringify({
      source,
      rpcProofPassed: true,
      recipeNodes: ['git-input-closed', 'child-failed-before-json', 'stored-receipt-context'],
    }),
  );
});
