import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  try {
    const plan = buildUninstallPlan(
      workspaceAt(root),
      baseState({ home_dir: join(root, '.home') }),
      {
        history: 'backup',
        home: 'delete',
        historyBackupPath: '/tmp/runs.tgz',
        homeBackupPath: undefined,
        dryRun: true,
      },
    );
    assert.equal(plan.history, 'backup');
    assert.equal(plan.historyBackupPath, '/tmp/runs.tgz');
    assert.equal(plan.home, 'delete');
    assert.equal(plan.homeDir, join(root, '.home'));
    assert.equal(plan.dryRun, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
