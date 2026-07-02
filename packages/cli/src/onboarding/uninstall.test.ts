import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildUninstallPlan,
  executeUninstallPlan,
  REMOVE_PATH_RETRY_OPTIONS,
} from './uninstall.js';
import { workspaceAt, type WorkspaceState } from './workspace.js';

const execFileAsync = promisify(execFile);

/** Real tmux is required for the teardown tests below — mirrors the skip pattern used by
 *  services/node/src/commands/tmux.test.ts for machines/CI without tmux installed. */
async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V'], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function hasTmuxSession(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session]).status === 0;
}

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

test('executeUninstallPlan removes install artifacts and skips stop when no pidfiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-uninstall-exec-'));
  const homeDir = join(tmpdir(), `fs-home-exec-${root.slice(-8)}`);
  mkdirSync(join(root, 'farmslot'), { recursive: true });
  mkdirSync(join(root, 'repos'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(root, 'state.json'), '{}');
  try {
    const plan = buildUninstallPlan(workspaceAt(root), baseState({ home_dir: homeDir }), {
      history: 'keep',
      home: 'delete',
      dryRun: false,
    });
    const steps: string[] = [];
    await executeUninstallPlan(plan, { step: (label) => steps.push(label) });
    assert.ok(!existsSync(join(root, 'farmslot')), 'farmslot dir removed');
    assert.ok(!existsSync(homeDir), 'home dir removed');
    // No pidfiles present → the stop step is a no-op (no "stopped …" step emitted).
    assert.ok(!steps.some((s) => s.startsWith('stopped ')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
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

test('executeUninstallPlan kills each slot session before repos are removed, and never kill-server', async (t) => {
  if (!(await tmuxAvailable())) {
    t.skip('tmux is not installed');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'fs-uninstall-tmux-'));
  const homeDir = join(tmpdir(), `fs-home-tmux-${root.slice(-8)}`);
  const targetSession = `farmslot_uninstall_target_${process.pid}`;
  // Simulates ANOTHER install's session on the same shared tmux server — this workspace's
  // pool never references it, so it must survive. If teardown ever used kill-server instead
  // of a scoped kill-session, this would be the session that catches the regression.
  const otherSession = `farmslot_uninstall_other_${process.pid}`;

  mkdirSync(join(root, 'farmslot', 'pool'), { recursive: true });
  mkdirSync(join(root, 'repos'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(root, 'state.json'), '{}');
  writeFileSync(
    join(root, 'farmslot', 'pool', 'test.json'),
    JSON.stringify({
      schema_version: 1,
      machine: 'test',
      host: 'localhost',
      ssh_user: 'test',
      slots: [
        { id: 'slot-1', repo: join(root, 'repos', 'slot-1'), session: targetSession },
        // A slot session that was never actually started — teardown must not fail on it.
        { id: 'slot-2', repo: join(root, 'repos', 'slot-2'), session: 'no-such-session-ever' },
      ],
    }),
  );

  await execFileAsync('tmux', ['new-session', '-d', '-s', targetSession, '-c', root, 'bash']);
  await execFileAsync('tmux', ['new-session', '-d', '-s', otherSession, '-c', root, 'bash']);

  try {
    const plan = buildUninstallPlan(workspaceAt(root), baseState({ home_dir: homeDir }), {
      history: 'keep',
      home: 'delete',
      dryRun: false,
    });
    const steps: string[] = [];
    await executeUninstallPlan(plan, { step: (label) => steps.push(label) });

    assert.ok(steps.includes(`stopped tmux session ${targetSession}`));
    assert.ok(!hasTmuxSession(targetSession), 'this workspace’s slot session was killed');
    assert.ok(hasTmuxSession(otherSession), 'an unrelated session must survive (no kill-server)');
    assert.ok(!existsSync(join(root, 'repos')), 'repos removed once its session stopped writing');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', otherSession]);
    rmSync(root, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('removePath retries on ENOTEMPTY/EBUSY instead of failing on the first straggler write', () => {
  // node:fs's rmSync doesn't expose a way to observe or mock its internal retry loop (its
  // exports are non-configurable, so it can't be spied on), and racing a real filesystem
  // write against it is inherently timing-dependent — flaky under load. Asserting the retry
  // config removePath passes is the deterministic proxy: maxRetries > 0 is what makes rmSync
  // retry ENOTEMPTY/EBUSY at all (see the Node fs docs), which is the actual fix.
  assert.ok(REMOVE_PATH_RETRY_OPTIONS.maxRetries > 0);
  assert.ok(REMOVE_PATH_RETRY_OPTIONS.retryDelay > 0);
});
