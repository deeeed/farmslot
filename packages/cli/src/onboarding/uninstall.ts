// onboarding/uninstall.ts — remove a farmslot installation created by install.sh.
//
// Reads the persisted workspace state (bin_dir, home_dir) so a *custom* install is
// removed at its real locations, not the defaults. Run history and the home dir hold
// things people don't want to lose (archived runs, gateway auth/profiles), so each is
// an explicit keep | backup | delete decision — the caller prompts; this module only
// builds and executes a plan.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { readPool } from './pool-config.js';
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
  /** Absolute path to the pool config (state.pool_file resolved against the farmslot clone) —
   *  read to tear down this workspace's slot tmux sessions before installDirs are removed.
   *  Null when there is no state (nothing to key the teardown off). */
  poolFile: string | null;
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

/** A backup destination must not already exist (no overwrite) nor sit inside a removed dir. */
function assertBackupDest(dest: string, removedDirs: string[]): void {
  if (existsSync(dest)) {
    throw new Error(`backup path already exists (refusing to overwrite): ${dest}`);
  }
  for (const danger of removedDirs) {
    if (isInsideDir(dest, danger)) {
      throw new Error(`backup ${dest} is inside a removed path (${danger})`);
    }
  }
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
  // A backup written inside a removed dir is destroyed with it; an existing dest would be
  // overwritten. Reject both, before anything is deleted.
  if (opts.history === 'backup' && opts.historyBackupPath) {
    assertBackupDest(opts.historyBackupPath, [ws.runsDir, ws.root, homeDir]);
  }
  if (opts.home === 'backup' && opts.homeBackupPath) {
    assertBackupDest(opts.homeBackupPath, [ws.root, homeDir]);
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
    poolFile: state?.pool_file ? join(ws.farmslotDir, state.pool_file) : null,
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

/** rmSync retries specifically on ENOTEMPTY/EBUSY with this maxRetries/retryDelay — the safety
 *  net for any straggler write that lands between teardownSlots() and this removal. Exported
 *  so tests can assert the retry config without racing a real filesystem to trigger it. */
export const REMOVE_PATH_RETRY_OPTIONS = { maxRetries: 5, retryDelay: 200 } as const;

function removePath(p: string): void {
  rmSync(p, { recursive: true, force: true, ...REMOVE_PATH_RETRY_OPTIONS });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const pid = Number(readFileSync(path, 'utf-8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    // An unreadable pidfile just means we can't target that service — skip it.
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH/EPERM: not a process we can signal — treat as not running.
    return false;
  }
}

/** True when pid's command line runs out of `workspaceRoot` — so a stale pidfile whose pid
 *  the OS reused for an unrelated process can never be signalled by uninstall. */
function pidBelongsToWorkspace(pid: number, workspaceRoot: string): boolean {
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
  if (res.status !== 0 || !res.stdout) return false;
  return res.stdout.includes(workspaceRoot);
}

/** Stop a farmslot service (gateway/node) recorded in `pidFile` before its files are removed.
 *  Otherwise a live gateway keeps writing state (e.g. .monitor_state.json) into the tree being
 *  deleted → ENOTEMPTY. The `up` command starts these detached (process-group leaders), so a
 *  group kill (-pid) takes down the tsx wrapper + node + esbuild children together. */
async function stopService(
  pidFile: string,
  label: string,
  workspaceRoot: string,
  hooks: UninstallHooks,
): Promise<void> {
  const pid = readPidFile(pidFile);
  if (!pid || !isAlive(pid)) return;
  if (!pidBelongsToWorkspace(pid, workspaceRoot)) return;

  let signalled = false;
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig); // whole detached group first
      signalled = true;
    } catch {
      try {
        process.kill(pid, sig); // fall back to the single process
        signalled = true;
      } catch {
        // Already gone between checks — nothing to signal.
      }
    }
  };

  signal('SIGTERM');
  for (let i = 0; i < 20 && isAlive(pid); i++) await delay(250); // up to ~5s for a clean exit
  if (isAlive(pid)) signal('SIGKILL');
  // Only report a stop we actually issued — the process may have exited on its own between
  // the alive check and the signal, in which case we did nothing.
  if (signalled) hooks.step(`stopped ${label} (pid ${pid})`);
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

/** Best-effort: kill a slot's tmux session. Scoped to one session id — never kill-server,
 *  which would take down other installs' sessions on the shared default tmux server. The `=`
 *  prefix forces an exact-name match: without it, tmux falls back to prefix matching when no
 *  exact session exists, so a dead session `mm` in this workspace's pool would kill an
 *  unrelated live `mm-1`/`mmprod-1` on the same server — exactly the cross-install kill this
 *  teardown exists to avoid. Any failure (tmux missing, session already gone) is silently
 *  ignored; a killed session is reported so the operator can see what was torn down. */
function killTmuxSession(session: string, hooks: UninstallHooks): void {
  const result = spawnSync('tmux', ['kill-session', '-t', `=${session}`], { encoding: 'utf-8' });
  if (result.status === 0) hooks.step(`stopped tmux session ${session}`);
}

/** Best-effort: drop a watchman watch on a slot repo so its file-event daemon stops touching
 *  the tree before removal. Skips silently when watchman isn't installed. */
function watchmanForget(repo: string, hooks: UninstallHooks): void {
  const result = spawnSync('watchman', ['watch-del', repo], { encoding: 'utf-8' });
  if (result.error) return; // watchman not installed — nothing to do
  if (result.status === 0) hooks.step(`stopped watchman watch on ${repo}`);
}

/** Tear down this workspace's slot processes before installDirs (repos + the farmslot clone)
 *  are removed. Uninstall stops the gateway/node (step 0) but never touched per-slot tmux
 *  sessions — metro/watchman/dev-server running inside one keeps writing into repos/<slot>
 *  while removePath deletes it, racing into ENOTEMPTY. Reads the pool this workspace recorded
 *  at install time and kills exactly its slot sessions; every step is best-effort and never
 *  fatal — a stuck or already-gone session must not block the rest of uninstall. */
function teardownSlots(poolFile: string | null, hooks: UninstallHooks): void {
  if (!poolFile || !existsSync(poolFile)) return;
  let slots: { session: string; repo: string }[];
  try {
    slots = readPool(poolFile).slots;
  } catch {
    return; // unreadable/invalid pool — nothing to key the teardown off
  }
  for (const slot of slots) {
    try {
      killTmuxSession(slot.session, hooks);
      watchmanForget(slot.repo, hooks);
    } catch (err) {
      hooks.step(
        `slot ${slot.session} teardown warning: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function executeUninstallPlan(
  plan: UninstallPlan,
  hooks: UninstallHooks,
): Promise<void> {
  if (plan.dryRun) return;

  // 0. Stop running services first. Their pidfiles live in homeDir (removed in step 1), and a
  //    live gateway/node keeps writing into the workspace being deleted → ENOTEMPTY. Must run
  //    before homeDir is touched, regardless of the home keep/backup/delete decision.
  await stopService(join(plan.homeDir, 'node.pid'), 'local node', plan.workspaceRoot, hooks);
  await stopService(join(plan.homeDir, 'gateway.pid'), 'gateway', plan.workspaceRoot, hooks);

  // 0.5. Stop per-slot tmux sessions before repos are removed — see teardownSlots doc comment.
  teardownSlots(plan.poolFile, hooks);

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
