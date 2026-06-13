// onboarding/add.ts — engine for `farmslot project add <source>`.
//
// Pipeline: resolve source → validate pack → register projects → blobless-clone
// product repos → register slots in the pool → run existing lifecycle scripts
// (sync-fixtures.sh, setup-slot.sh, preflight hook, preflight-slot.sh) → pack
// hooks → state. Idempotent: re-running the same source no-ops/repairs and
// never duplicates slots.
//
// Note: prepare-slot.sh is deliberately NOT called here — it delegates to the
// gateway (slot.prepare RPC) and onboarding must work before any gateway runs.
// Slot readiness is proven by the project preflight hook + preflight-slot.sh.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  decideAddAction,
  expandPackVars,
  hashPackDir,
  type PackJson,
  type PackProject,
  projectName,
  projectShortName,
  validatePackDir,
} from './pack.js';
import {
  allocatePort,
  defaultResources,
  platformResourceKeys,
  readPool,
  registerSlot,
  writePool,
} from './pool-config.js';
import { readState, type Workspace, type WorkspaceState, writeState } from './workspace.js';

export interface AddStep {
  label: string;
  detail?: string;
}

export interface AddProgress {
  step: (s: AddStep) => void;
  info: (msg: string) => void;
  /** JSON mode: child process output goes to stderr so stdout stays pure JSON. */
  childOutputToStderr?: boolean;
}

/** spawnSync stdio config honoring the JSON-mode stdout contract. */
function childStdio(progress: AddProgress): 'inherit' | [number, number, number] {
  return progress.childOutputToStderr ? [0, 2, 2] : 'inherit';
}

export class AddError extends Error {}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; stdio?: 'inherit' | [number, number, number] },
): void {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: opts.stdio ?? 'inherit',
  });
  if (result.error) throw new AddError(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new AddError(`${cmd} ${args.join(' ')} exited ${result.status} (cwd ${opts.cwd})`);
  }
}

function isGitUrl(source: string): boolean {
  return /^(https?|ssh|git):\/\//.test(source) || /^[\w.-]+@[\w.-]+:/.test(source);
}

/** Origin remote URL of a clone, or '' when git fails / no origin is configured. */
function gitOriginUrl(repoDir: string): string {
  const result = spawnSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], {
    encoding: 'utf-8',
  });
  if (result.error || result.status !== 0) return '';
  return result.stdout.trim();
}

/** Equivalent-URL compare: .git suffix and trailing slashes don't make a different repo. */
function sameRepoUrl(a: string, b: string): boolean {
  const normalize = (u: string): string => u.replace(/\/+$/, '').replace(/\.git$/, '');
  return normalize(a) === normalize(b);
}

/** Resolve a pack source (local dir or git URL) to a local pack directory. */
export function resolvePackSource(
  source: string,
  ws: Workspace,
  stdio: 'inherit' | [number, number, number] = 'inherit',
): string {
  if (isGitUrl(source)) {
    const name = basename(source).replace(/\.git$/, '');
    const dest = join(ws.root, 'packs', name);
    if (existsSync(join(dest, '.git'))) {
      // Same-named packs from different remotes must not silently share a clone.
      const origin = gitOriginUrl(dest);
      if (!sameRepoUrl(origin, source)) {
        throw new AddError(
          `pack clone ${dest} tracks ${origin || '(no origin remote)'}, not ${source} — remove it or rename one pack repo`,
        );
      }
      run('git', ['-C', dest, 'fetch', 'origin', '--quiet'], { cwd: ws.root, stdio });
      // Track the remote's CURRENT default branch, not the one cached at clone time.
      run('git', ['-C', dest, 'remote', 'set-head', 'origin', '--auto'], { cwd: ws.root, stdio });
      run('git', ['-C', dest, 'reset', '--hard', '--quiet', 'origin/HEAD'], {
        cwd: ws.root,
        stdio,
      });
      // reset --hard moves submodule POINTERS but not their working trees —
      // sync+update or the pack would keep serving stale project content.
      run('git', ['-C', dest, 'submodule', 'sync', '--recursive', '--quiet'], {
        cwd: ws.root,
        stdio,
      });
      try {
        run('git', ['-C', dest, 'submodule', 'update', '--init', '--recursive', '--quiet'], {
          cwd: ws.root,
          stdio,
        });
      } catch (err) {
        // Re-throw with recovery guidance: a partial clone (e.g. private
        // submodule auth failure) hits this on every retry otherwise.
        throw new AddError(
          `${err instanceof Error ? err.message : String(err)} — submodule update failed in ${dest}; fix submodule access (SSH keys) or remove that clone and re-run project add`,
        );
      }
    } else {
      mkdirSync(join(ws.root, 'packs'), { recursive: true });
      // Packs may mount their project dirs as submodules (separate repos per
      // project); a plain clone would leave those dirs empty and fail validation.
      run('git', ['clone', '--quiet', '--recurse-submodules', source, dest], {
        cwd: ws.root,
        stdio,
      });
    }
    return dest;
  }
  const dir = resolve(source);
  if (!existsSync(dir)) {
    throw new AddError(`pack source not found: ${dir} (expected a local directory or git URL)`);
  }
  return dir;
}

function hookEnv(ws: Workspace): Record<string, string> {
  return {
    FARMSLOT_WORKSPACE: ws.root,
    FARMSLOT_DIR: ws.farmslotDir,
    FARMSLOT_REPOS_DIR: ws.reposDir,
  };
}

function runPackHook(
  pack: PackJson,
  hook: keyof NonNullable<PackJson['hooks']>,
  packDir: string,
  ws: Workspace,
  progress: AddProgress,
): void {
  const cmd = pack.hooks?.[hook];
  if (!cmd) return;
  progress.info(`running pack hook ${hook}: ${cmd}`);
  run('bash', ['-c', cmd], { cwd: packDir, env: hookEnv(ws), stdio: childStdio(progress) });
}

interface RegisteredProject {
  name: string;
  short: string;
  platform: string;
  repoUrl: string;
  defaultBranch: string;
  runtimeDir: string;
  preflight?: string;
  slots: number;
}

/**
 * Refuse to replace a registered project dir this pack does not own: another
 * pack's project, or a pre-existing unowned project dir. Full-replace would
 * silently destroy it and adopt its slots.
 *
 * MUST be checked against the PRE-claim state: once the pack has claimed its
 * project list in state.json, ownedByThisPack is always true and the unowned
 * check is unreachable.
 */
export function assertProjectOwnership(
  name: string,
  packName: string,
  state: WorkspaceState,
  dest: string,
): void {
  for (const [otherPack, packState] of Object.entries(state.packs)) {
    if (otherPack !== packName && packState.projects.includes(name)) {
      throw new AddError(
        `project '${name}' is owned by pack '${otherPack}' — packs collide on a project dir name`,
      );
    }
  }
  const ownedByThisPack = state.packs[packName]?.projects.includes(name) ?? false;
  if (!ownedByThisPack && existsSync(dest)) {
    throw new AddError(
      `projects/${name} already exists but is not registered to any pack — move it aside before adding this pack`,
    );
  }
}

/** Subset of `paths` (relative to `src`) that the pack source's git ignores. */
function packIgnoredFiles(src: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  // check-ignore exits 0 (some ignored, listed on stdout), 1 (none), or 128
  // (src is not a git repo / other error). Only a git pack source carries the
  // ignore signal that distinguishes operator-owned files from deleted ones.
  const result = spawnSync('git', ['-C', src, 'check-ignore', '--', ...paths], {
    encoding: 'utf-8',
  });
  if (result.status !== 0 && result.status !== 1) return new Set();
  return new Set(
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * Relative paths of REGULAR files under `dest` that should survive the
 * full-replace: present in the workspace project dir, absent from the pack
 * `src`, AND ignored by the pack source's git — i.e. operator-owned files the
 * pack intentionally does not ship (filled fixture secrets, local skills/notes
 * the pack lists in .gitignore alongside .sample templates).
 *
 * The git-ignore test is what makes this safe: a file a pack UPDATE deleted is
 * also absent from `src`, but it was tracked (not ignored), so it is excluded
 * and correctly disappears — full-replace still removes stale pack files.
 * `.git`/`node_modules`, symlinks (lstat reports dir-symlinks as not-a-dir, so
 * readFileSync would EISDIR on restore), and empty operator dirs are not
 * preserved. A non-git pack source yields no signal → nothing preserved
 * (matches the prior full-replace; real packs are git clones/submodules).
 */
export function operatorAddedFiles(dest: string, src: string): string[] {
  if (!existsSync(dest)) return [];
  const candidates: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dest, rel))) {
      if (entry === '.git' || entry === 'node_modules') continue;
      const childRel = rel ? join(rel, entry) : entry;
      const stat = lstatSync(join(dest, childRel));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(childRel);
      } else if (!existsSync(join(src, childRel))) {
        candidates.push(childRel);
      }
    }
  };
  walk('');
  const ignored = packIgnoredFiles(src, candidates);
  return candidates.filter((rel) => ignored.has(rel));
}

export function registerProject(
  proj: PackProject,
  packDir: string,
  ws: Workspace,
  state: WorkspaceState,
  packName: string,
  progress: AddProgress,
): RegisteredProject {
  const name = projectName(proj);
  const src = join(packDir, proj.dir);
  const dest = join(ws.farmslotDir, 'projects', name);
  assertProjectOwnership(name, packName, state, dest);
  // Snapshot operator-added files (filled fixture secrets etc.) — the pack
  // ships only .sample templates, so the real files exist only here and would
  // be lost by the full-replace. Capture content + mode (secrets are 0600).
  const preserved = operatorAddedFiles(dest, src).map((rel) => ({
    rel,
    content: readFileSync(join(dest, rel)),
    mode: statSync(join(dest, rel)).mode,
  }));
  // Full replace: packs own their project dirs — files deleted from the pack
  // must disappear here too, not survive as stale hooks/fixtures.
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  // Restore preserved operator files on top of the fresh pack copy.
  for (const file of preserved) {
    const target = join(dest, file.rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    chmodSync(target, file.mode);
  }
  if (preserved.length > 0) {
    progress.info(`preserved ${preserved.length} operator file(s) in projects/${name}`);
  }

  const projectJsonPath = join(dest, 'project.json');
  const projectJson = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as {
    repo_url?: string;
    default_branch?: string;
    paths?: { runtime_dir?: string };
    hooks?: { preflight?: string };
  };
  if (proj.repo_url) {
    projectJson.repo_url = expandPackVars(proj.repo_url, { workspace: ws.root });
    writeFileSync(projectJsonPath, JSON.stringify(projectJson, null, 2) + '\n');
  }
  if (!projectJson.repo_url) {
    throw new AddError(
      `project '${name}' has no repo_url (set it in project.json or as repo_url in pack.json)`,
    );
  }
  progress.step({ label: `project ${name} registered`, detail: dest });
  return {
    name,
    short: projectShortName(proj),
    platform: proj.platform,
    repoUrl: projectJson.repo_url,
    defaultBranch: projectJson.default_branch ?? 'main',
    runtimeDir: projectJson.paths?.runtime_dir ?? '.agent',
    preflight: projectJson.hooks?.preflight,
    slots: proj.slots,
  };
}

function cloneSlotRepo(repoUrl: string, repoPath: string, progress: AddProgress): void {
  const stdio = childStdio(progress);
  if (!isAbsolute(repoUrl) && !isGitUrl(repoUrl) && !repoUrl.startsWith('file://')) {
    throw new AddError(
      `repo_url must be an absolute path or git URL, got '${repoUrl}' — relative paths would clone from an undefined location`,
    );
  }
  // file:// keeps --filter working for local sources (plain paths bypass the transport).
  const url = isAbsolute(repoUrl) ? `file://${repoUrl}` : repoUrl;
  if (existsSync(join(repoPath, '.git'))) {
    // The clone must still track what the pack declares — a repo_url change
    // with a leftover old clone would validate the wrong codebase.
    const origin = gitOriginUrl(repoPath);
    if (!sameRepoUrl(origin, url) && !sameRepoUrl(origin, repoUrl)) {
      throw new AddError(
        `slot repo ${repoPath} tracks ${origin || '(no origin remote)'}, but the pack declares ${repoUrl} — move or remove the old clone, then re-run project add`,
      );
    }
    progress.info(`repo exists: ${repoPath}`);
    return;
  }
  run('git', ['clone', '--quiet', '--filter=blob:none', url, repoPath], { cwd: '/', stdio });
  progress.step({ label: `repo cloned (blobless)`, detail: repoPath });
}

export interface AddResult {
  pack: PackJson;
  action: 'add' | 'noop' | 'repair';
  slots: string[];
}

/**
 * Re-copy a pack's project dirs into the workspace (no slot work). Used by
 * `farmslot update` so content-only pack changes (hooks, fixtures, templates)
 * are applied when the hash is stamped; structural gaps (new slots/repos) are
 * caught by findMissingState on the next `project add`.
 */
export function syncPackProjects(
  pack: PackJson,
  packDir: string,
  ws: Workspace,
  state: WorkspaceState,
  progress: AddProgress,
): void {
  for (const proj of pack.projects) {
    registerProject(proj, packDir, ws, state, pack.name, progress);
  }
}

/** Read an already-registered project's metadata without re-copying the pack dir. */
function readRegisteredProject(proj: PackProject, ws: Workspace): RegisteredProject {
  const name = projectName(proj);
  const projectJsonPath = join(ws.farmslotDir, 'projects', name, 'project.json');
  const projectJson = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as {
    repo_url?: string;
    default_branch?: string;
    paths?: { runtime_dir?: string };
    hooks?: { preflight?: string };
  };
  return {
    name,
    short: projectShortName(proj),
    platform: proj.platform,
    repoUrl: projectJson.repo_url ?? '',
    defaultBranch: projectJson.default_branch ?? 'main',
    runtimeDir: projectJson.paths?.runtime_dir ?? '.agent',
    preflight: projectJson.hooks?.preflight,
    slots: proj.slots,
  };
}

/**
 * Verify-only check for an unchanged pack: list anything missing that the add
 * pipeline would have created. Empty list = true no-op; anything missing
 * escalates the run to a repair.
 */
export function findMissingState(
  pack: PackJson,
  pool: {
    machine: string;
    slots: Array<{ id: string; repo?: string; resources?: Record<string, unknown> }>;
  },
  ws: { farmslotDir: string; reposDir: string },
): string[] {
  const missing: string[] = [];
  const slots = new Map(pool.slots.map((s) => [s.id, s]));
  for (const proj of pack.projects) {
    const name = projectName(proj);
    const short = projectShortName(proj);
    if (!existsSync(join(ws.farmslotDir, 'projects', name, 'project.json'))) {
      missing.push(`project ${name} not registered`);
    }
    for (let n = 1; n <= proj.slots; n++) {
      const slotId = `${pool.machine}-${short}-${n}`;
      const slot = slots.get(slotId);
      if (!slot) missing.push(`slot ${slotId} not in pool`);
      // Slots created before platform defaults existed lack their device/browser
      // resource forever (registerSlot preserves user edits) — escalate so the
      // repair path can backfill.
      if (slot) {
        for (const key of platformResourceKeys(proj.platform)) {
          if (!slot.resources?.[key]) missing.push(`slot ${slotId} missing ${key} resource`);
        }
      }
      // Respect an operator-repointed slot repo: check the pool's actual path,
      // not the derived default — otherwise every re-add re-clones an orphan.
      const repoPath = slot?.repo ?? join(ws.reposDir, `${short}-${n}`);
      if (!existsSync(join(repoPath, '.git'))) {
        missing.push(`repo ${short}-${n} missing`);
      }
    }
  }
  return missing;
}

export function projectAdd(source: string, ws: Workspace, progress: AddProgress): AddResult {
  const state = readState(ws);
  if (!state) {
    throw new AddError(`workspace state not found at ${ws.statePath} — run install.sh first`);
  }

  const packDir = resolvePackSource(source, ws, childStdio(progress));
  const { pack, errors } = validatePackDir(packDir);
  if (!pack) {
    throw new AddError(`invalid pack at ${packDir}:\n  - ${errors.join('\n  - ')}`);
  }
  const hash = hashPackDir(packDir);
  let action = decideAddAction(state.packs[pack.name]?.hash, hash);

  const poolPath = join(ws.farmslotDir, state.pool_file);
  const pool = readPool(poolPath);

  // An unchanged pack is verify-only — one-time setup must not rerun. Anything
  // missing (deleted repo, edited pool, lost project dir) escalates to repair.
  if (action === 'noop') {
    const missing = findMissingState(pack, pool, ws);
    if (missing.length > 0) {
      progress.info(`pack unchanged but state incomplete — repairing: ${missing.join('; ')}`);
      action = 'repair';
    }
  }
  const mutate = action !== 'noop';
  progress.step({ label: `pack ${pack.name} validated`, detail: `${packDir} (${action})` });

  // Ownership is authoritative against the PRE-claim state — the claim below
  // would make every project look owned and disarm the unowned-dir guard.
  if (mutate) {
    for (const proj of pack.projects) {
      const name = projectName(proj);
      assertProjectOwnership(name, pack.name, state, join(ws.farmslotDir, 'projects', name));
    }
  }

  // Claim ownership BEFORE mutating: a failed add must leave a state where the
  // re-run repairs (empty hash never matches → repair) instead of rejecting the
  // half-created project dirs as unowned.
  let claimedState = state;
  if (mutate) {
    claimedState = {
      ...state,
      packs: {
        ...state.packs,
        [pack.name]: {
          source: isGitUrl(source) ? source : resolve(source),
          hash: '',
          projects: pack.projects.map(projectName),
          slots: state.packs[pack.name]?.slots ?? [],
        },
      },
    };
    writeState(ws, claimedState);
  }

  if (mutate) runPackHook(pack, 'pre_add', packDir, ws, progress);

  const allSlots: string[] = [];
  const projects: string[] = [];

  for (const proj of pack.projects) {
    const registered = mutate
      ? registerProject(proj, packDir, ws, claimedState, pack.name, progress)
      : readRegisteredProject(proj, ws);
    projects.push(registered.name);

    for (let n = 1; n <= registered.slots; n++) {
      const slotId = `${pool.machine}-${registered.short}-${n}`;
      const session = `${registered.short}-${n}`;
      allSlots.push(slotId);

      // Fail fast when the slot id is already taken by anything this project
      // does not own — another pack's project, or a hand-created slot with no
      // project field (adopting it would run lifecycle scripts against it).
      const existing = pool.slots.find((s) => s.id === slotId);
      if (existing && existing.project !== registered.name) {
        throw new AddError(
          `slot ${slotId} already belongs to ${existing.project ? `project '${existing.project}'` : 'an operator-defined slot (no project field)'} — set a distinct 'short' in pack.json or remove the conflicting slot`,
        );
      }
      // Honor an operator-repointed slot repo; default for new slots.
      const repoPath = existing?.repo ?? join(ws.reposDir, `${registered.short}-${n}`);

      if (mutate) {
        cloneSlotRepo(registered.repoUrl, repoPath, progress);

        const added = registerSlot(pool, {
          id: slotId,
          project: registered.name,
          platform: registered.platform,
          repo: repoPath,
          session,
          branch: registered.defaultBranch,
          resources: {
            'dev-server': { port: allocatePort(pool) },
            ...defaultResources(registered.platform, registered.short, n, pool),
          },
        });
        if (added) {
          writePool(poolPath, pool);
          progress.step({ label: `slot ${slotId} registered`, detail: state.pool_file });
        } else if (existing) {
          // Backfill platform resources missing on slots created before
          // defaultResources existed. Merge-only: user-edited values win.
          const defaults = defaultResources(registered.platform, registered.short, n, pool);
          const backfill = Object.fromEntries(
            Object.entries(defaults).filter(([key]) => !existing.resources?.[key]),
          );
          if (Object.keys(backfill).length > 0) {
            existing.resources = { ...backfill, ...existing.resources };
            writePool(poolPath, pool);
            progress.step({
              label: `slot ${slotId} resources backfilled`,
              detail: Object.keys(backfill).join(', '),
            });
          } else {
            progress.info(`slot ${slotId} already in pool — left untouched`);
          }
        }

        // Existing lifecycle scripts own fixtures, setup, and hook expansion;
        // never reimplement them.
        run('bash', ['scripts/sync-fixtures.sh', '--slot', slotId], {
          cwd: ws.farmslotDir,
          stdio: childStdio(progress),
        });
        progress.step({ label: `slot ${slotId} fixtures synced` });
        run('bash', ['scripts/setup-slot.sh', slotId, registered.defaultBranch], {
          cwd: ws.farmslotDir,
          stdio: childStdio(progress),
        });
        progress.step({ label: `slot ${slotId} setup complete` });

        if (registered.preflight) {
          run('bash', ['scripts/run-project-hook.sh', slotId, 'preflight'], {
            cwd: ws.farmslotDir,
            stdio: childStdio(progress),
          });
          progress.step({ label: `slot ${slotId} preflight hook ran` });
        }
      }

      run('bash', ['scripts/preflight-slot.sh', slotId], {
        cwd: ws.farmslotDir,
        stdio: childStdio(progress),
      });
      progress.step({ label: `slot ${slotId} validated (preflight + health)` });
    }
  }

  if (mutate) runPackHook(pack, 'post_add', packDir, ws, progress);
  if (pack.hooks?.smoke) {
    runPackHook(pack, 'smoke', packDir, ws, progress);
    progress.step({ label: `pack ${pack.name} smoke check passed` });
  }

  const newState: WorkspaceState = {
    ...claimedState,
    packs: {
      ...claimedState.packs,
      [pack.name]: {
        source: isGitUrl(source) ? source : resolve(source),
        hash,
        projects,
        slots: allSlots,
      },
    },
  };
  writeState(ws, newState);

  return { pack, action, slots: allSlots };
}
