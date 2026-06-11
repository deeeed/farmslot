import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertProjectOwnership, findMissingState } from './add.js';
import type { PackJson } from './pack.js';
import type { WorkspaceState } from './workspace.js';

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
