// onboarding/update.ts — engine for `farmslot update`.
//
// Hard-updates the workspace farmslot clone (it is a tool, not a workspace),
// reinstalls dependencies, applies pool schema migrations, and re-syncs
// registered packs whose content hash changed. Ends with doctor (command side).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { AddError, assertProjectOwnership, resolvePackSource, syncPackProjects } from './add.js';
import { applyMigrations, loadMigrations } from './migrations.js';
import { hashPackDir, projectName, validatePackDir } from './pack.js';
import { readPool, writePool } from './pool-config.js';
import { readState, type Workspace, writeState } from './workspace.js';

export interface UpdateProgress {
  step: (label: string, detail?: string) => void;
  info: (msg: string) => void;
  /** JSON mode: child process output goes to stderr so stdout stays pure JSON. */
  childOutputToStderr?: boolean;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.error) {
    throw new AddError(`git failed to start in ${cwd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new AddError(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr?.trim() ?? ''}`);
  }
  return result.stdout.trim();
}

function sh(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  stdio: 'inherit' | [number, number, number] = 'inherit',
): void {
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio,
  });
  if (result.error) {
    throw new AddError(`${cmd} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new AddError(`${cmd} ${args.join(' ')} exited ${result.status} (cwd ${cwd})`);
  }
}

export interface UpdateResult {
  branch: string;
  commit: string;
  migrationsApplied: string[];
  packsSynced: string[];
}

export async function farmslotUpdate(
  ws: Workspace,
  progress: UpdateProgress,
): Promise<UpdateResult> {
  const state = readState(ws);
  if (!state) {
    throw new AddError(`workspace state not found at ${ws.statePath} — run install.sh first`);
  }
  const clone = ws.farmslotDir;

  // 1. Hard-update the clone. Back up local edits — the clone is a tool, not a workspace.
  const dirty = git(['status', '--porcelain'], clone);
  if (dirty) {
    progress.info(
      'clone has local changes — backing them up with git stash (recover: git stash pop)',
    );
    git(['stash', 'push', '--include-untracked', '-m', 'farmslot-update backup'], clone);
  }
  git(['fetch', 'origin', '--quiet'], clone);
  let branch: string;
  if (state.source.mode === 'local') {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], state.source.path);
  } else {
    // Track the remote's current default branch, not a hardcoded name.
    git(['remote', 'set-head', 'origin', '--auto'], clone);
    branch = git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], clone).replace(/^origin\//, '');
  }
  const hasBranch =
    spawnSync('git', ['rev-parse', '--verify', branch], { cwd: clone }).status === 0;
  git(
    hasBranch
      ? ['checkout', '--quiet', branch]
      : ['checkout', '--quiet', '-b', branch, `origin/${branch}`],
    clone,
  );
  git(['reset', '--hard', '--quiet', `origin/${branch}`], clone);
  const commit = git(['rev-parse', '--short', 'HEAD'], clone);
  progress.step('farmslot clone updated', `${branch} @ ${commit}`);

  const stdio: 'inherit' | [number, number, number] = progress.childOutputToStderr
    ? [0, 2, 2]
    : 'inherit';

  // 2. Reinstall dependencies + rebuild the CLI's workspace deps.
  sh('yarn', ['install'], clone, {}, stdio);
  sh('yarn', ['workspace', '@farmslot/recipe-harness', 'build'], clone, {}, stdio);
  progress.step('dependencies installed and CLI rebuilt');

  // 3. Pool schema migrations (versioned, preserve user edits).
  const steps = await loadMigrations(join(clone, 'migrations', 'pool'));
  const poolPath = join(clone, state.pool_file);
  const pool = readPool(poolPath);
  const { pool: migrated, applied } = applyMigrations(pool, steps);
  if (applied.length > 0) {
    writePool(poolPath, migrated);
    progress.step(`pool migrated to schema v${migrated.schema_version}`, applied.join(', '));
  } else {
    progress.info(`pool already at schema v${pool.schema_version ?? 0} — no migrations pending`);
  }

  // 4. Re-sync packs whose content changed.
  const packsSynced: string[] = [];
  const packs = { ...state.packs };
  for (const [name, packState] of Object.entries(packs)) {
    const packDir = resolvePackSource(packState.source, ws, stdio);
    const hash = hashPackDir(packDir);
    if (hash === packState.hash) {
      progress.info(`pack ${name} unchanged`);
      continue;
    }
    const { pack, errors } = validatePackDir(packDir);
    if (!pack) {
      throw new AddError(`pack ${name} changed but is now invalid:\n  - ${errors.join('\n  - ')}`);
    }
    if (pack.hooks?.sync) {
      sh(
        'bash',
        ['-c', pack.hooks.sync],
        packDir,
        {
          FARMSLOT_WORKSPACE: ws.root,
          FARMSLOT_DIR: ws.farmslotDir,
          FARMSLOT_REPOS_DIR: ws.reposDir,
        },
        stdio,
      );
    }
    // Ownership is authoritative against the PRE-claim state: a project newly
    // added to the pack must not silently adopt another pack's dir or destroy
    // a pre-existing unowned one.
    for (const proj of pack.projects) {
      const projName = projectName(proj);
      assertProjectOwnership(
        projName,
        name,
        { ...state, packs },
        join(ws.farmslotDir, 'projects', projName),
      );
    }
    // Claim ownership of any newly added project dirs BEFORE copying them, and
    // keep the old hash until the sync succeeds — a failed sync retries on the
    // next update, and the follow-up `project add` never sees unowned dirs.
    packs[name] = {
      ...packState,
      projects: [...new Set([...packState.projects, ...pack.projects.map(projectName)])],
    };
    writeState(ws, { ...state, packs });
    // Apply content changes now — stamping the hash without re-copying would
    // strand them (the next add would see noop). Structural changes (new
    // slots/repos) escalate to repair on the next project add.
    syncPackProjects(
      pack,
      packDir,
      ws,
      { ...state, packs },
      {
        step: (s) => progress.step(s.label, s.detail),
        info: progress.info,
        childOutputToStderr: progress.childOutputToStderr,
      },
    );
    packs[name] = { ...packs[name], hash };
    packsSynced.push(name);
    progress.step(
      `pack ${name} re-synced (project defs re-registered)`,
      `slot/repo additions need: farmslot project add ${packState.source}`,
    );
  }

  writeState(ws, {
    ...state,
    packs,
    // Dedup: a downgraded-then-remigrated pool must not accumulate duplicates.
    pool_migrations: { applied: [...new Set([...state.pool_migrations.applied, ...applied])] },
  });

  return { branch, commit, migrationsApplied: applied, packsSynced };
}
