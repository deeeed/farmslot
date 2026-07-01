import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { buildUninstallPlan } from './uninstall.js';
import { workspaceAt, type WorkspaceState } from './workspace.js';

const KEEP = { history: 'keep', home: 'keep', dryRun: false } as const;

function baseState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    schema_version: 1,
    source: { mode: 'git', url: 'x' },
    machine: 'test',
    pool_file: 'pool/test.json',
    packs: {},
    pool_migrations: { applied: [] },
    ...overrides,
  };
}

test('refuses to uninstall an unsafe root', () => {
  assert.throws(() => buildUninstallPlan(workspaceAt('/'), baseState(), KEEP), /unsafe path/);
  assert.throws(
    () => buildUninstallPlan(workspaceAt(process.env.HOME ?? '/home/x'), baseState(), KEEP),
    /unsafe path/,
  );
});

test('home falls back to FARMSLOT_HOME when state has no home_dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-uninstall-'));
  try {
    const plan = buildUninstallPlan(workspaceAt(root), baseState(), {
      ...KEEP,
      home: 'keep',
    });
    // No home_dir in state → resolver default (not asserting exact path, just that it resolved).
    assert.ok(plan.homeDir.length > 0);
    assert.equal(plan.symlink, null); // no bin_dir → nothing owned
    assert.deepEqual(plan.installDirs, [join(root, 'farmslot'), join(root, 'repos')]);
    assert.equal(plan.runsDir, join(root, 'runs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only a symlink resolving into the workspace is owned', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-uninstall-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const cliTarget = join(root, 'farmslot', 'packages', 'cli', 'bin', 'farmslot.mjs');
  mkdirSync(join(root, 'farmslot', 'packages', 'cli', 'bin'), { recursive: true });
  writeFileSync(cliTarget, '#!/usr/bin/env node\n');
  try {
    // Symlink into the workspace → owned.
    const ownLink = join(binDir, 'farmslot');
    symlinkSync(cliTarget, ownLink);
    const owned = buildUninstallPlan(workspaceAt(root), baseState({ bin_dir: binDir }), KEEP);
    assert.equal(owned.symlink, ownLink);

    // Symlink pointing OUTSIDE the workspace → not ours, left alone.
    const foreignDir = mkdtempSync(join(tmpdir(), 'fs-foreign-'));
    const foreignTarget = join(foreignDir, 'other-farmslot');
    writeFileSync(foreignTarget, 'x');
    rmSync(ownLink);
    symlinkSync(foreignTarget, ownLink);
    const foreign = buildUninstallPlan(workspaceAt(root), baseState({ bin_dir: binDir }), KEEP);
    assert.equal(foreign.symlink, null);
    rmSync(foreignDir, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dispositions and backup paths pass through to the plan', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-uninstall-'));
  const homeDir = join(tmpdir(), `fs-home-${root.slice(-8)}`); // disjoint from the workspace
  try {
    const plan = buildUninstallPlan(workspaceAt(root), baseState({ home_dir: homeDir }), {
      history: 'backup',
      home: 'delete',
      historyBackupPath: '/tmp/runs.tgz',
      homeBackupPath: undefined,
      dryRun: true,
    });
    assert.equal(plan.history, 'backup');
    assert.equal(plan.historyBackupPath, '/tmp/runs.tgz');
    assert.equal(plan.home, 'delete');
    assert.equal(plan.homeDir, homeDir);
    assert.equal(plan.dryRun, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a non-absolute or ancestor home dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-uninstall-'));
  try {
    assert.throws(
      () => buildUninstallPlan(workspaceAt(root), baseState({ home_dir: 'relative/home' }), KEEP),
      /unsafe path/,
    );
    // A home dir that contains the workspace (ancestor) — or sits inside it (mirror) —
    // overlaps and is refused in either direction.
    assert.throws(
      () =>
        buildUninstallPlan(workspaceAt(root), baseState({ home_dir: resolve(root, '..') }), {
          ...KEEP,
          home: 'delete',
        }),
      /overlaps the workspace/,
    );
    assert.throws(
      () =>
        buildUninstallPlan(workspaceAt(root), baseState({ home_dir: join(root, 'repos', 'x') }), {
          ...KEEP,
          home: 'keep',
        }),
      /overlaps the workspace/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a backup path inside a directory being removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-uninstall-'));
  try {
    assert.throws(
      () =>
        buildUninstallPlan(workspaceAt(root), baseState(), {
          history: 'backup',
          home: 'keep',
          historyBackupPath: join(root, 'runs', 'backup.tgz'), // inside runs → destroyed with it
          dryRun: false,
        }),
      /inside a removed path/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical containment catches a symlinked home ancestor', () => {
  const real = mkdtempSync(join(tmpdir(), 'fs-real-'));
  const wsRoot = join(real, 'ws');
  mkdirSync(wsRoot, { recursive: true });
  const link = join(tmpdir(), `fs-link-${process.pid}-${real.slice(-8)}`);
  symlinkSync(real, link); // link -> real, and real contains wsRoot
  try {
    // home_dir reaches the workspace's real ancestor via a symlink — a lexical check
    // would miss it; the canonical guard must still refuse.
    assert.throws(
      () =>
        buildUninstallPlan(workspaceAt(wsRoot), baseState({ home_dir: link }), {
          ...KEEP,
          home: 'delete',
        }),
      /overlaps the workspace/,
    );
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('a workspace symlinked to $HOME is still rejected', () => {
  const home = process.env.HOME;
  if (!home) return;
  const link = join(tmpdir(), `fs-wslink-${process.pid}`);
  symlinkSync(home, link); // link -> $HOME; a lexical guard would miss it
  try {
    assert.throws(() => buildUninstallPlan(workspaceAt(link), baseState(), KEEP), /unsafe path/);
  } finally {
    rmSync(link, { force: true });
  }
});

test('rejects a backup path that already exists (no overwrite)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-uninstall-'));
  const dest = join(tmpdir(), `fs-existing-backup-${process.pid}.tgz`);
  writeFileSync(dest, 'important');
  try {
    assert.throws(
      () =>
        buildUninstallPlan(workspaceAt(root), baseState(), {
          history: 'backup',
          home: 'keep',
          historyBackupPath: dest, // exists, outside the workspace → overwrite refused
          dryRun: false,
        }),
      /already exists/,
    );
  } finally {
    rmSync(dest, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
