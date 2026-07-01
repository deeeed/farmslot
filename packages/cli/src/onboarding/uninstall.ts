// onboarding/uninstall.ts — remove a farmslot installation created by install.sh.
//
// Reads the persisted workspace state (bin_dir, home_dir) so a *custom* install is
// removed at its real locations, not the defaults. Run history and the home dir hold
// things people don't want to lose (archived runs, gateway auth/profiles), so each is
// an explicit keep | backup | delete decision — the caller prompts; this module only
// builds and executes a plan.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { type Workspace, type WorkspaceState } from './workspace.js';

export type Disposition = 'keep' | 'backup' | 'delete';

export interface UninstallOptions {
  history: Disposition;
  home: Disposition;
  historyBackupPath?: string;
  homeBackupPath?: string;
  dryRun: boolean;
}

export interface UninstallPlan {
  workspaceRoot: string;
  /** Always removed: the farmslot clone + product-repo clones. */
  installDirs: string[];
  /** Always removed: state.json. */
  installFiles: string[];
  runsDir: string;
  homeDir: string;
  history: Disposition;
  home: Disposition;
  historyBackupPath?: string;
  homeBackupPath?: string;
  /** The PATH symlink to remove — only when it is a symlink resolving into this workspace. */
  symlink: string | null;
  dryRun: boolean;
}

/** Refuse to operate on obviously unsafe roots (a bug in state.json must never rm $HOME). */
function assertSafeRoot(dir: string): void {
  if (!dir || !isAbsolute(dir)) {
    throw new Error(`refusing to uninstall an unsafe path: ${dir}`);
  }
  // Canonicalize first: a workspace/home that is a symlink to / or $HOME must not slip past.
  const canon = canonicalPath(dir);
  const home = process.env.HOME ? canonicalPath(process.env.HOME) : '';
  if (canon === '/' || canon === home) {
    throw new Error(`refusing to uninstall an unsafe path: ${dir}`);
  }
}

/**
 * Canonical absolute path: realpath the deepest existing ancestor (resolving symlinks),
 * then re-append any non-existent remainder — so a symlinked parent can't defeat the
 * containment checks below (e.g. a home dir that reaches the workspace via a symlink).
 */
function canonicalPath(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = resolve(cur, '..');
    if (parent === cur) break; // reached the filesystem root
    tail.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  const base = realpathSync(cur);
  return tail.length ? join(base, ...tail) : base;
}

/** True when `child` resolves (canonically) to `dir` or a path inside it. */
function isInsideDir(child: string, dir: string): boolean {
  const c = canonicalPath(child);
  const d = canonicalPath(dir);
  return c === d || c.startsWith(d + sep);
}

/** The PATH symlink is only ours to remove if it is a symlink resolving inside the workspace. */
function resolveOwnedSymlink(binDir: string | undefined, workspaceRoot: string): string | null {
  if (!binDir) return null;
  const link = join(binDir, 'farmslot');
  if (!existsSync(link)) return null;
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    // realpath BOTH sides: on macOS the workspace may sit under a symlinked parent
    // (e.g. /var -> /private/var), which would otherwise fail a raw prefix check.
    const target = realpathSync(link);
    const root = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);
    return target === root || target.startsWith(root + sep) ? link : null;
  } catch {
    // Broken/unreadable symlink — leave it rather than risk removing a foreign one.
    return null;
  }
}

export function buildUninstallPlan(
  ws: Workspace,
  state: WorkspaceState | null,
  opts: UninstallOptions,
): UninstallPlan {
  assertSafeRoot(ws.root);
  const homeDir = state?.home_dir ?? farmslotHome();
  assertSafeRoot(homeDir);
  // Home and the workspace must be disjoint trees. If either contains the other, removing
  // one clobbers the other: a home above the workspace (e.g. ~/dev) takes kept run history
  // with it, and a home *inside* the workspace is destroyed by the install-dir removal even
  // with home=keep.
  const rootR = canonicalPath(ws.root);
  const homeR = canonicalPath(homeDir);
  if (rootR === homeR || rootR.startsWith(homeR + sep) || homeR.startsWith(rootR + sep)) {
    throw new Error(`refusing to uninstall: home dir ${homeDir} overlaps the workspace ${ws.root}`);
  }
  // A backup written inside a directory that will be removed is destroyed with it.
  if (opts.history === 'backup' && opts.historyBackupPath) {
    for (const danger of [ws.runsDir, ws.root, homeDir]) {
      if (isInsideDir(opts.historyBackupPath, danger)) {
        throw new Error(
          `history backup ${opts.historyBackupPath} is inside a removed path (${danger})`,
        );
      }
    }
  }
  if (opts.home === 'backup' && opts.homeBackupPath) {
    for (const danger of [ws.root, homeDir]) {
      if (isInsideDir(opts.homeBackupPath, danger)) {
        throw new Error(`home backup ${opts.homeBackupPath} is inside a removed path (${danger})`);
      }
    }
  }
  return {
    workspaceRoot: ws.root,
    installDirs: [ws.farmslotDir, ws.reposDir],
    installFiles: [ws.statePath],
    runsDir: ws.runsDir,
    homeDir,
    history: opts.history,
    home: opts.home,
    historyBackupPath: opts.historyBackupPath,
    homeBackupPath: opts.homeBackupPath,
    symlink: resolveOwnedSymlink(state?.bin_dir, ws.root),
    dryRun: opts.dryRun,
  };
}

export interface UninstallHooks {
  step: (label: string) => void;
}

/** tar a directory to destPath; throws (so we never delete what we failed to archive). */
function archiveDir(dir: string, destPath: string): void {
  if (!existsSync(dir)) return;
  const parent = resolve(dir, '..');
  const name = dir.slice(parent.length + 1);
  const result = spawnSync('tar', ['-czf', destPath, '-C', parent, name], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`backup failed (tar exited ${result.status}): ${result.stderr || destPath}`);
  }
}

function removePath(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

/** Apply a directory's keep|backup|delete decision. Returns whether it was removed. */
function disposeOf(
  dir: string,
  disposition: Disposition,
  backupPath: string | undefined,
  hooks: UninstallHooks,
): boolean {
  if (!existsSync(dir)) return true;
  switch (disposition) {
    case 'keep':
      hooks.step(`kept ${dir}`);
      return false;
    case 'backup':
      if (!backupPath) throw new Error(`backup path required to back up ${dir}`);
      archiveDir(dir, backupPath);
      removePath(dir);
      hooks.step(`backed up ${dir} -> ${backupPath}`);
      return true;
    case 'delete':
      removePath(dir);
      hooks.step(`deleted ${dir}`);
      return true;
  }
}

export function executeUninstallPlan(plan: UninstallPlan, hooks: UninstallHooks): void {
  if (plan.dryRun) return;

  // 1. History + home first — if a backup fails it throws before anything is destroyed.
  disposeOf(plan.runsDir, plan.history, plan.historyBackupPath, hooks);
  disposeOf(plan.homeDir, plan.home, plan.homeBackupPath, hooks);

  // 2. Always-remove install artifacts.
  for (const dir of plan.installDirs) {
    if (existsSync(dir)) {
      removePath(dir);
      hooks.step(`removed ${dir}`);
    }
  }
  for (const file of plan.installFiles) {
    if (existsSync(file)) {
      removePath(file);
      hooks.step(`removed ${file}`);
    }
  }
  if (plan.symlink) {
    removePath(plan.symlink);
    hooks.step(`removed symlink ${plan.symlink}`);
  }

  // 3. Remove the now-empty workspace dir (kept history leaves it in place on purpose).
  if (existsSync(plan.workspaceRoot)) {
    try {
      if (readdirSync(plan.workspaceRoot).length === 0) {
        rmdirSync(plan.workspaceRoot);
        hooks.step(`removed empty workspace ${plan.workspaceRoot}`);
      } else {
        hooks.step(`kept non-empty workspace ${plan.workspaceRoot} (contains kept files)`);
      }
    } catch (err) {
      hooks.step(
        `could not remove workspace ${plan.workspaceRoot}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
