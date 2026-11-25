import { withFarmGitConfig } from '../core/farm-git.js';
import { execOnSlot, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';
import { flowDir } from '../intelligence/engine.js';

import { FLOW_TYPES } from './slot-storage-cleanup.js';

const SCRUB_TIMEOUT_MS = 120_000;
/** The layout these commands own: only there is everything in temp/ a run's or the farm's. */
export const TEMP_TASK_ROOT = 'temp/tasks';
/** Kinds a removed nested Git checkout is reported with. */
export const CHECKOUT_KINDS = ['clone', 'linked worktree', 'bare'] as const;

/** Paths are relative to the slot checkout. */
export interface TempScrubResult {
  /** `kind` is file, dir, link, or one of `CHECKOUT_KINDS`. */
  removed: Array<{ path: string; kind: string }>;
  /** Entries left in place on purpose: a symlink that holds a kept path. */
  kept: Array<{ path: string; reason: string }>;
  refused: Array<{ path: string; reason: string }>;
}

// One definition of a Git checkout for every temp/ command: a `.git` entry, or a bare repo.
// `os.walk` stops on an unreadable dir instead of skipping it, so nothing below one is missed.
const PY_CHECKOUT = [
  'def is_checkout(path):',
  '    if os.path.lexists(os.path.join(path, ".git")):',
  '        return True',
  '    return os.path.isfile(os.path.join(path, "HEAD")) and os.path.isdir(os.path.join(path, "objects")) and os.path.isdir(os.path.join(path, "refs"))',
  'def walk_error(error):',
  '    raise error',
  'def checkouts_inside(path):',
  '    found = []',
  '    for parent, dirs, _ in os.walk(path, onerror=walk_error):',
  '        for name in list(dirs):',
  '            child = os.path.join(parent, name)',
  '            if not os.path.islink(child) and is_checkout(child):',
  '                found.append(child)',
  '                dirs.remove(name)',
  '    return found',
];

/**
 * Delete everything under the slot's `temp/` except the checkout-relative `keep` paths and
 * their ancestors. Task dirs under `taskRoot` and the flow folders left empty are removed one
 * by one and reported. Symlinks are unlinked, never followed; a symlink holding a kept path is
 * left and reported. A nested Git checkout is deleted outright and reported with its kind: a
 * linked worktree through `git worktree remove --force` on its own repository (only that
 * worktree's admin data goes), a clone or bare repo as a dir. A checkout holding a kept path is
 * refused. `temp/` must be a plain directory.
 */
export function buildTempScrubCommand(input: {
  repo: string;
  keep: string[];
  taskRoot: string;
}): string {
  const config = {
    repo: input.repo.replace(/\/+$/, ''),
    keep: input.keep,
    taskRoot: input.taskRoot,
  };
  return withFarmGitConfig(
    [
      `__fs_config=${shellQuote(JSON.stringify(config))}`,
      'python3 - "$__fs_config" <<\'PY\'',
      'import json, os, shutil, subprocess, sys',
      'cfg = json.loads(sys.argv[1])',
      'repo = os.path.realpath(cfg["repo"])',
      'temp = os.path.join(repo, "temp")',
      'keep = {os.path.normpath(os.path.join(repo, rel)) for rel in cfg["keep"]}',
      'task_root = os.path.normpath(os.path.join(repo, cfg["taskRoot"]))',
      'env = {k: v for k, v in os.environ.items() if k not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR")}',
      'def emit(kind, path, detail):',
      '    print(json.dumps({"kind": kind, "path": os.path.relpath(path, repo), "detail": detail}), flush=True)',
      'def keeps_below(path):',
      '    return any(k.startswith(path + os.sep) for k in keep)',
      ...PY_CHECKOUT,
      'def remove_checkout(path):',
      '    if keeps_below(path):',
      '        emit("refused", path, "a Git checkout holding a kept path")',
      '        return False',
      '    dot = os.path.join(path, ".git")',
      '    if os.path.isfile(dot):',
      '        common = subprocess.run(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], env=env, capture_output=True, text=True)',
      '        owner = os.path.realpath(common.stdout.strip()) if common.returncode == 0 else ""',
      '        # A worktree whose repository is gone has no admin data left to clean.',
      '        if owner and os.path.isdir(owner) and not owner.startswith(path + os.sep):',
      '            done = subprocess.run(["git", "-C", owner, "worktree", "remove", "--force", path], env=env, capture_output=True, text=True)',
      '            if done.returncode != 0:',
      '                emit("refused", path, "git worktree remove failed: " + done.stderr.strip()[-300:])',
      '                return False',
      '        if os.path.lexists(path):',
      '            shutil.rmtree(path)',
      '        emit("removed", path, "linked worktree")',
      '    else:',
      '        kind = "clone" if os.path.lexists(dot) else "bare"',
      '        shutil.rmtree(path)',
      '        emit("removed", path, kind)',
      '    return True',
      'def remove(path):',
      '    if os.path.islink(path):',
      '        os.unlink(path)',
      '        emit("removed", path, "link")',
      '    elif os.path.isdir(path):',
      '        if is_checkout(path):',
      '            remove_checkout(path)',
      '            return',
      '        if all(remove_checkout(inner) for inner in checkouts_inside(path)):',
      '            shutil.rmtree(path)',
      '            emit("removed", path, "dir")',
      '    else:',
      '        os.unlink(path)',
      '        emit("removed", path, "file")',
      'def scrub(parent):',
      '    for name in sorted(os.listdir(parent)):',
      '        path = os.path.join(parent, name)',
      '        if path in keep:',
      '            continue',
      '        try:',
      '            if os.path.islink(path) and keeps_below(path):',
      '                emit("kept", path, "a symlink holding a kept path")',
      '                continue',
      '            container = keeps_below(path) or path == task_root or os.path.dirname(path) == task_root',
      '            if not os.path.islink(path) and os.path.isdir(path) and container and not is_checkout(path):',
      '                scrub(path)',
      '                if not keeps_below(path) and path != task_root and not os.listdir(path):',
      '                    os.rmdir(path)',
      '                    emit("removed", path, "dir")',
      '                continue',
      '            remove(path)',
      '        except (OSError, subprocess.SubprocessError) as error:',
      '            emit("refused", path, str(error))',
      'if os.path.lexists(temp):',
      '    if os.path.islink(temp) or not os.path.isdir(temp):',
      '        emit("refused", temp, "temp/ is not a plain directory in the checkout")',
      '    else:',
      '        scrub(temp)',
      'PY',
    ].join('\n'),
  );
}

export interface TempScratchDeleteResult {
  deleted: string[];
  refused: Array<{ path: string; reason: string }>;
}

/**
 * Release's scratch clean-up for the temp/tasks layout: `scratch*` directories directly under
 * temp/, the task root or one of its flow folders are deleted, since a later trial must not
 * read them. A directory holding TASK.md is a task dir (a SCRATCH-12 Jira key or a QA title can
 * produce `scratch-…`) and is never touched; a TASK.md that cannot be checked counts as present.
 * Scratch holding a Git checkout, or one that cannot be read, is refused and left for the next
 * prepare, which deletes it. Paths are absolute.
 */
export function buildTempScratchDeleteCommand(input: { repo: string }): string {
  const config = {
    repo: input.repo.replace(/\/+$/, ''),
    parents: ['temp', TEMP_TASK_ROOT, ...FLOW_TYPES.map((flow) => `${TEMP_TASK_ROOT}/${flowDir(flow)}`)],
  };
  return [
    `__fs_config=${shellQuote(JSON.stringify(config))}`,
    'python3 - "$__fs_config" <<\'PY\'',
    'import json, os, shutil, sys',
    'cfg = json.loads(sys.argv[1])',
    'repo = os.path.realpath(cfg["repo"])',
    'def emit(kind, path, detail):',
    '    print(json.dumps({"kind": kind, "path": path, "detail": detail}), flush=True)',
    'def plain_dir(path):',
    '    # No symlink anywhere on the way: the real path is the spelled path.',
    '    return os.path.isdir(path) and os.path.realpath(path) == path',
    'def task_marker(path):',
    '    try:',
    '        os.lstat(os.path.join(path, "TASK.md"))',
    '        return True',
    '    except FileNotFoundError:',
    '        return False',
    '    except OSError:',
    '        return True',
    ...PY_CHECKOUT,
    'found = []',
    'for parent in [os.path.join(repo, p) for p in dict.fromkeys(cfg["parents"])]:',
    '    if plain_dir(parent):',
    '        found += [os.path.join(parent, n) for n in sorted(os.listdir(parent)) if n.startswith("scratch")]',
    'for path in found:',
    '    if not plain_dir(path) or task_marker(path):',
    '        continue',
    '    try:',
    '        if is_checkout(path) or checkouts_inside(path):',
    '            emit("refused", path, "holds a Git checkout; the next prepare deletes it")',
    '        else:',
    '            shutil.rmtree(path)',
    '            emit("deleted", path, "")',
    '    except OSError as error:',
    '        # Refused and kept out of the age prune; the next prepare clears or names it.',
    '        emit("refused", path, str(error))',
    'PY',
  ].join('\n');
}

type ScrubRecord = { kind?: unknown; path?: unknown; detail?: unknown };

function records(stdout: string): ScrubRecord[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line): ScrubRecord => {
      const parsed: unknown = JSON.parse(line);
      return parsed && typeof parsed === 'object' ? parsed : {};
    });
}

const text = (value: unknown) => (typeof value === 'string' ? value : null);

export function parseTempScrubOutput(stdout: string): TempScrubResult {
  const result: TempScrubResult = { removed: [], kept: [], refused: [] };
  for (const record of records(stdout)) {
    const where = text(record.path);
    const detail = text(record.detail);
    if (where === null || detail === null) continue;
    if (record.kind === 'removed') result.removed.push({ path: where, kind: detail });
    else if (record.kind === 'kept') result.kept.push({ path: where, reason: detail });
    else if (record.kind === 'refused') result.refused.push({ path: where, reason: detail });
  }
  return result;
}

export function parseTempScratchDeleteOutput(stdout: string): TempScratchDeleteResult {
  const result: TempScratchDeleteResult = { deleted: [], refused: [] };
  for (const record of records(stdout)) {
    const where = text(record.path);
    if (where === null) continue;
    if (record.kind === 'deleted') result.deleted.push(where);
    else if (record.kind === 'refused')
      result.refused.push({ path: where, reason: text(record.detail) ?? 'refused' });
  }
  return result;
}

/** Names what a failed or timed-out scrub had already removed. */
export async function scrubSlotTemp(
  vars: SlotVars,
  keep: string[],
  taskRoot: string,
): Promise<TempScrubResult> {
  const result = await execOnSlot(
    vars,
    buildTempScrubCommand({ repo: vars.remoteRepo, keep, taskRoot }),
    { cwd: vars.remoteRepo, timeout: SCRUB_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    let removed = '';
    try {
      removed = parseTempScrubOutput(result.stdout)
        .removed.map((entry) => `${entry.path} (${entry.kind})`)
        .join(', ');
    } catch (error) {
      // A cut-off last line: the failure below is what matters; say the list is partial.
      removed = `output unreadable: ${(error as Error).message}`;
    }
    throw new Error(
      `temp/ scrub failed for ${vars.slotId}: ${result.stderr.trim() || `exit ${result.exitCode}`}${removed ? `; removed before it stopped: ${removed}` : ''}`,
    );
  }
  return parseTempScrubOutput(result.stdout);
}

export async function deleteTempScratch(vars: SlotVars): Promise<TempScratchDeleteResult> {
  const result = await execOnSlot(vars, buildTempScratchDeleteCommand({ repo: vars.remoteRepo }), {
    cwd: vars.remoteRepo,
    timeout: SCRUB_TIMEOUT_MS,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `scratch delete failed for ${vars.slotId}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  return parseTempScratchDeleteOutput(result.stdout);
}

/** Task dirs (a dir holding TASK.md) one or two levels under the task root; links skipped. */
export async function listTempTaskDirs(vars: SlotVars, taskRoot: string): Promise<string[]> {
  const result = await execOnSlot(
    vars,
    `cd ${shellQuote(vars.remoteRepo)} && for d in ${shellQuote(taskRoot)}/*/ ${shellQuote(taskRoot)}/*/*/; do d=\${d%/}; [ ! -L "$d" ] && [ -e "$d/TASK.md" ] && printf '%s\\n' "$d"; done; true`,
    { timeout: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(`task dir listing failed for ${vars.slotId}: exit ${result.exitCode}`);
  return result.stdout.split('\n').filter(Boolean);
}
