import { withFarmGitConfig } from '../core/farm-git.js';
import { execOnSlot, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';
import { flowDir } from '../intelligence/engine.js';

import { FLOW_TYPES } from './slot-storage-cleanup.js';

const SCRUB_TIMEOUT_MS = 120_000;
/** The layout these commands own: only there is everything in temp/ a run's or the farm's. */
export const TEMP_TASK_ROOT = 'temp/tasks';
/** Kinds a removed nested Git checkout is reported with; a worktree may add `(branch … kept)`. */
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
      'def git(*args):',
      '    return subprocess.run(["git"] + list(args), env=env, capture_output=True, text=True)',
      'def outside_worktree(store):',
      '    # A worktree this repository owns outside temp/ would lose its Git data with it.',
      '    admin = os.path.join(store, "worktrees")',
      '    for name in sorted(os.listdir(admin)) if os.path.isdir(admin) else []:',
      '        try:',
      '            with open(os.path.join(admin, name, "gitdir")) as f:',
      '                where = os.path.realpath(os.path.dirname(f.read().strip()))',
      '        except OSError:',
      '            continue  # No gitdir record: Git treats it as prunable, so nothing outside depends on it.',
      '        if os.path.lexists(where) and not where.startswith(temp + os.sep):',
      '            return where',
      '    return None',
      'def registered(owner, path):',
      '    listed = git("-C", owner, "worktree", "list", "--porcelain")',
      '    return listed.returncode == 0 and ("worktree " + path) in listed.stdout.splitlines()',
      'def remove_checkout(path):',
      '    if keeps_below(path):',
      '        emit("refused", path, "a Git checkout holding a kept path")',
      '        return False',
      '    dot = os.path.join(path, ".git")',
      '    store = dot if os.path.isdir(dot) else path',
      '    elsewhere = None if os.path.isfile(dot) else outside_worktree(store)',
      '    if elsewhere:',
      '        emit("refused", path, "a repository whose worktree " + os.path.relpath(elsewhere, repo) + " is outside temp/")',
      '        return False',
      '    if os.path.isfile(dot):',
      '        common = git("-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir")',
      '        owner = os.path.realpath(common.stdout.strip()) if common.returncode == 0 else ""',
      '        head = git("-C", path, "symbolic-ref", "-q", "--short", "HEAD").stdout.strip()',
      '        # Only a worktree its repository lists at this path is removed through Git (a locked',
      '        # one needs --force twice); a moved, copied or separate-git-dir checkout is a dir.',
      '        if owner and os.path.isdir(owner) and not owner.startswith(path + os.sep) and registered(owner, path):',
      '            done = git("-C", owner, "worktree", "remove", "--force", "--force", path)',
      '            if done.returncode != 0:',
      '                emit("refused", path, "git worktree remove failed: " + done.stderr.strip()[-300:])',
      '                return False',
      '        if os.path.lexists(path):',
      '            shutil.rmtree(path)',
      '        # The branch stays: no worktree branch here is one Farmslot created.',
      '        emit("removed", path, "linked worktree" + (" (branch " + head + " kept)" if head else ""))',
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
    parents: [
      'temp',
      TEMP_TASK_ROOT,
      ...FLOW_TYPES.map((flow) => `${TEMP_TASK_ROOT}/${flowDir(flow)}`),
    ],
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

/** One record per line; a line cut off by a timeout or crash is dropped, not the rest. */
function records(stdout: string): ScrubRecord[] {
  return stdout.split('\n').flatMap((line): ScrubRecord[] => {
    if (!line.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed && typeof parsed === 'object' ? [parsed] : [];
    } catch (error) {
      // Only the last line of a stopped command can be partial; the failure is reported by
      // the caller from the exit status.
      if (error instanceof SyntaxError) return [];
      throw error;
    }
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

/** A failed or timed-out scrub still names what it had already removed. */
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
    const removed = parseTempScrubOutput(result.stdout)
      .removed.map((entry) => `${entry.path} (${entry.kind})`)
      .join(', ');
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

/**
 * Task dirs (a dir holding TASK.md) one or two levels under the task root, relative to the
 * checkout. No shell glob (macOS nodes run `zsh -f`, where an unmatched glob aborts) and no
 * symlink is entered at either level.
 */
export function buildTempTaskDirListCommand(input: { repo: string; taskRoot: string }): string {
  const config = { repo: input.repo.replace(/\/+$/, ''), taskRoot: input.taskRoot };
  return [
    `__fs_config=${shellQuote(JSON.stringify(config))}`,
    'python3 - "$__fs_config" <<\'PY\'',
    'import json, os, sys',
    'cfg = json.loads(sys.argv[1])',
    'repo = os.path.realpath(cfg["repo"])',
    'def dirs(parent):',
    '    try:',
    '        return [os.path.join(parent, n) for n in sorted(os.listdir(parent)) if not os.path.islink(os.path.join(parent, n)) and os.path.isdir(os.path.join(parent, n))]',
    '    except FileNotFoundError:',
    '        return []',
    'root = os.path.join(repo, cfg["taskRoot"])',
    'if os.path.islink(root):',
    '    sys.exit(0)',
    'for first in dirs(root):',
    '    for path in [first] + dirs(first):',
    '        if os.path.lexists(os.path.join(path, "TASK.md")):',
    '            print(os.path.relpath(path, repo))',
    'PY',
  ].join('\n');
}

export async function listTempTaskDirs(vars: SlotVars, taskRoot: string): Promise<string[]> {
  const result = await execOnSlot(
    vars,
    buildTempTaskDirListCommand({ repo: vars.remoteRepo, taskRoot }),
    { cwd: vars.remoteRepo, timeout: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `task dir listing failed for ${vars.slotId}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  return result.stdout.split('\n').filter(Boolean);
}
