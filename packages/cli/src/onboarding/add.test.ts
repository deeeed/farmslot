import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertProjectOwnership,
  findMissingState,
  operatorAddedFiles,
  registerProject,
} from './add.js';
import type { PackJson, PackProject } from './pack.js';
import { type Workspace, workspaceAt, type WorkspaceState } from './workspace.js';

function stateWith(packs: WorkspaceState['packs']): WorkspaceState {
  return {
    schema_version: 1,
    source: { mode: 'local', path: '/src' },
    machine: 'm',
    pool_file: 'pool/m.json',
    packs,
    pool_migrations: { applied: [] },
  };
}

test('assertProjectOwnership guards cross-pack and unowned project dirs (pre-claim state)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-own-'));
  const dest = join(root, 'projects', 'app-farm');

  // Owned by another pack → always rejected, even before the dir exists.
  assert.throws(
    () =>
      assertProjectOwnership(
        'app-farm',
        'pack-b',
        stateWith({ 'pack-a': { source: '/a', hash: 'x', projects: ['app-farm'], slots: [] } }),
        dest,
      ),
    /owned by pack 'pack-a'/,
  );

  // Not on disk, not owned → fine (fresh add).
  assert.doesNotThrow(() => assertProjectOwnership('app-farm', 'pack-b', stateWith({}), dest));

  // On disk but unowned (hand-created or lost state) → rejected, never deleted.
  mkdirSync(dest, { recursive: true });
  assert.throws(
    () => assertProjectOwnership('app-farm', 'pack-b', stateWith({}), dest),
    /not registered to any pack/,
  );

  // Owned by this pack → re-add/repair allowed.
  assert.doesNotThrow(() =>
    assertProjectOwnership(
      'app-farm',
      'pack-b',
      stateWith({ 'pack-b': { source: '/b', hash: 'x', projects: ['app-farm'], slots: [] } }),
      dest,
    ),
  );
});

test('findMissingState: complete state is a true no-op, missing pieces escalate', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-noop-'));
  const ws = { farmslotDir: join(root, 'farmslot'), reposDir: join(root, 'repos') };
  const pack: PackJson = {
    name: 'p',
    projects: [{ dir: 'projects/app-farm', platform: 'cli', slots: 1 }],
  };
  const pool = { machine: 'm', slots: [{ id: 'm-app-1' }] };

  mkdirSync(join(ws.farmslotDir, 'projects', 'app-farm'), { recursive: true });
  writeFileSync(join(ws.farmslotDir, 'projects', 'app-farm', 'project.json'), '{}');
  mkdirSync(join(ws.reposDir, 'app-1', '.git'), { recursive: true });

  // Everything in place → verify-only no-op: no lifecycle steps would rerun.
  assert.deepEqual(findMissingState(pack, pool, ws), []);

  // Missing slot repo → escalates to repair.
  rmSync(join(ws.reposDir, 'app-1'), { recursive: true });
  assert.deepEqual(findMissingState(pack, pool, ws), ['repo app-1 missing']);

  // Missing pool slot and project registration are reported too.
  assert.equal(findMissingState(pack, { machine: 'm', slots: [] }, ws).length, 2);
});

test('findMissingState escalates platform slots missing their device/browser resource', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-res-'));
  const ws = { farmslotDir: join(root, 'farmslot'), reposDir: join(root, 'repos') };
  const pack: PackJson = {
    name: 'p',
    projects: [{ dir: 'projects/app-farm', platform: 'ios', slots: 1 }],
  };
  mkdirSync(join(ws.farmslotDir, 'projects', 'app-farm'), { recursive: true });
  writeFileSync(join(ws.farmslotDir, 'projects', 'app-farm', 'project.json'), '{}');
  mkdirSync(join(ws.reposDir, 'app-1', '.git'), { recursive: true });

  // Slot created by pre-defaultResources code: no ios-sim → repair escalation.
  const bare = { machine: 'm', slots: [{ id: 'm-app-1' }] };
  assert.deepEqual(findMissingState(pack, bare, ws), ['slot m-app-1 missing ios-sim resource']);

  // With the resource present the state is complete.
  const complete = {
    machine: 'm',
    slots: [{ id: 'm-app-1', resources: { 'ios-sim': { simulator: 'app-1' } } }],
  };
  assert.deepEqual(findMissingState(pack, complete, ws), []);
});

test('operatorAddedFiles finds files in dest absent from the pack source', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fs-op-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(join(src, 'fixtures'), { recursive: true });
  mkdirSync(join(dest, 'fixtures'), { recursive: true });
  // Pack ships only the .sample template + project.json.
  writeFileSync(join(src, 'project.json'), '{}');
  writeFileSync(join(src, 'fixtures', '.js.env.sample'), 'KEY=');
  // Operator copy: same tracked files PLUS a filled secret + a nested one.
  writeFileSync(join(dest, 'project.json'), '{}');
  writeFileSync(join(dest, 'fixtures', '.js.env.sample'), 'KEY=');
  writeFileSync(join(dest, 'fixtures', '.js.env'), 'KEY=secret');
  mkdirSync(join(dest, 'fixtures', 'runtime'), { recursive: true });
  writeFileSync(join(dest, 'fixtures', 'runtime', 'wallet-fixture.json'), '{"k":1}');
  // A dir-symlink must be skipped, not treated as a file (would EISDIR on read).
  symlinkSync(join(dest, 'fixtures', 'runtime'), join(dest, 'linked-runtime'));

  assert.deepEqual(operatorAddedFiles(dest, src).sort(), [
    join('fixtures', '.js.env'),
    join('fixtures', 'runtime', 'wallet-fixture.json'),
  ]);
  // Fresh dest (first add) has nothing to preserve.
  assert.deepEqual(operatorAddedFiles(join(root, 'missing'), src), []);
});

test('registerProject re-add preserves operator secrets, refreshes pack files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fs-reg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws: Workspace = workspaceAt(join(root, 'ws'));
  const packDir = join(root, 'pack');
  const proj: PackProject = { dir: 'projects/app-farm', platform: 'cli', slots: 1 };
  const noop = { step: () => {}, info: () => {} };

  // Pack source: project.json (with repo_url) + a .sample template only.
  mkdirSync(join(packDir, 'projects', 'app-farm', 'fixtures'), { recursive: true });
  writeFileSync(
    join(packDir, 'projects', 'app-farm', 'project.json'),
    JSON.stringify({ name: 'app-farm', repo_url: 'https://example.invalid/app.git' }),
  );
  writeFileSync(join(packDir, 'projects', 'app-farm', 'fixtures', '.js.env.sample'), 'KEY=\n');

  const state: WorkspaceState = {
    schema_version: 1,
    source: { mode: 'local', path: packDir },
    machine: 'm',
    pool_file: 'pool/m.json',
    packs: { p: { source: packDir, hash: '', projects: ['app-farm'], slots: [] } },
    pool_migrations: { applied: [] },
  };

  // First add lays down the pack.
  registerProject(proj, packDir, ws, state, 'p', noop);
  const secret = join(ws.farmslotDir, 'projects', 'app-farm', 'fixtures', '.js.env');
  writeFileSync(secret, 'KEY=filled-by-operator\n', { mode: 0o600 });

  // The pack changes a tracked file between adds (must win on re-copy).
  writeFileSync(
    join(packDir, 'projects', 'app-farm', 'fixtures', '.js.env.sample'),
    'KEY=\nNEW=\n',
  );

  // Re-add: operator secret survives with its mode; pack file is refreshed.
  registerProject(proj, packDir, ws, state, 'p', noop);
  assert.equal(readFileSync(secret, 'utf-8'), 'KEY=filled-by-operator\n');
  assert.equal(statSync(secret).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(
      join(ws.farmslotDir, 'projects', 'app-farm', 'fixtures', '.js.env.sample'),
      'utf-8',
    ),
    'KEY=\nNEW=\n',
  );
});
