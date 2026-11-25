import { execOnSlot, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

const SCRUB_TIMEOUT_MS = 120_000;

/** Paths are relative to the slot checkout. */
export interface TempScrubResult {
  removed: Array<{ path: string; kind: string }>;
  /** Entries left in place on purpose: a symlink that holds a kept path. */
  kept: Array<{ path: string; reason: string }>;
  refused: Array<{ path: string; reason: string }>;
}

/** A Git checkout under temp/, found before anything is deleted. */
export interface TempCheckout {
  path: string;
  bare: boolean;
  /** Absolute `git rev-parse --git-common-dir`: where its refs live. */
  commonDir: string;
  /** Its `.git` is a file: a linked worktree whose admin data lives in `commonDir`. */
  linked: boolean;
  /** The checked-out branch, or null when detached or bare. */
  branch: string | null;
  branches: string[];
  /** HEAD names a commit; an unborn checkout has nothing to park. */
  hasHead: boolean;
}

export interface TempSurvey {
  checkouts: TempCheckout[];
  /** Task dirs present under the task root (a dir holding TASK.md), before the scrub. */
  taskDirs: string[];
  refused: Array<{ path: string; reason: string }>;
}

const PYTHON_COMMON = [
  'import json, os, shutil, subprocess, sys',
  'cfg = json.loads(sys.argv[1])',
  'repo = os.path.realpath(cfg["repo"])',
  'temp = os.path.join(repo, "temp")',
  'keep = {os.path.normpath(os.path.join(repo, rel)) for rel in cfg["keep"]}',
  'task_root = os.path.normpath(os.path.join(repo, cfg["taskRoot"]))',
  'def rel(path):',
  '    return os.path.relpath(path, repo)',
  'def emit(kind, path, detail):',
  '    print(json.dumps({"kind": kind, "path": rel(path), "detail": detail}))',
  'def keeps_below(path):',
  '    return any(k.startswith(path + os.sep) for k in keep)',
  'def is_checkout(path):',
  '    if os.path.lexists(os.path.join(path, ".git")):',
  '        return True',
  '    return os.path.isfile(os.path.join(path, "HEAD")) and os.path.isdir(os.path.join(path, "objects")) and os.path.isdir(os.path.join(path, "refs"))',
  'def plain_temp():',
  '    if not os.path.lexists(temp):',
  '        return False',
  '    if os.path.islink(temp) or not os.path.isdir(temp):',
  '        emit("refused", temp, "temp/ is not a plain directory in the checkout")',
  '        return False',
  '    return True',
];

/**
 * Find every Git checkout under the slot's `temp/` (bare repos and linked worktrees included)
 * and every task dir, outside the `keep` paths. A checkout is not entered: parking it saves
 * its tree, and a checkout nested in its work fails that parking by name. Symlinks are never
 * followed. A checkout Git cannot read as itself is refused by name.
 */
export function buildTempSurveyCommand(input: {
  repo: string;
  keep: string[];
  taskRoot: string;
}): string {
  const config = {
    repo: input.repo.replace(/\/+$/, ''),
    keep: input.keep,
    taskRoot: input.taskRoot,
  };
  return [
    `__fs_config=${shellQuote(JSON.stringify(config))}`,
    'python3 - "$__fs_config" <<\'PY\'',
    ...PYTHON_COMMON,
    'env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}',
    'env["GIT_OPTIONAL_LOCKS"] = "0"',
    'def git(path, *args):',
    '    r = subprocess.run(["git", "-C", path] + list(args), env=env, capture_output=True, text=True)',
    '    return r.stdout.strip() if r.returncode == 0 else None',
    'def describe(path):',
    '    bare = not os.path.lexists(os.path.join(path, ".git"))',
    '    gitdir = git(path, "rev-parse", "--absolute-git-dir")',
    '    common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")',
    '    if not gitdir or not common:',
    '        return None',
    '    if bare:',
    '        if os.path.realpath(gitdir) != path:',
    '            return None',
    '    elif os.path.realpath(git(path, "rev-parse", "--show-toplevel") or "") != path:',
    '        return None',
    '    heads = git(path, "for-each-ref", "--format=%(refname:short)", "refs/heads")',
    '    return {',
    '        "bare": bare,',
    '        "commonDir": os.path.realpath(common),',
    '        "linked": os.path.isfile(os.path.join(path, ".git")),',
    '        "branch": None if bare else git(path, "symbolic-ref", "-q", "--short", "HEAD"),',
    '        "branches": heads.split("\\n") if heads else [],',
    '        "hasHead": git(path, "rev-parse", "-q", "--verify", "HEAD^{commit}") is not None,',
    '    }',
    'found = []',
    'def survey(parent):',
    '    for name in sorted(os.listdir(parent)):',
    '        path = os.path.join(parent, name)',
    '        if path in keep or name == ".git" or os.path.islink(path) or not os.path.isdir(path):',
    '            continue',
    '        if os.path.dirname(path) == task_root or os.path.dirname(os.path.dirname(path)) == task_root:',
    '            if os.path.lexists(os.path.join(path, "TASK.md")):',
    '                emit("task", path, "")',
    '        try:',
    '            if is_checkout(path):',
    '                info = describe(path)',
    '                if info is None:',
    '                    emit("refused", path, "a Git checkout Git cannot read as itself")',
    '                    continue',
    '                found.append((path, info))',
    '                continue',
    '            survey(path)',
    '        except OSError as error:',
    '            emit("refused", path, str(error))',
    'if plain_temp():',
    '    survey(temp)',
    'for path, info in found:',
    '    print(json.dumps({"kind": "checkout", "path": rel(path), "detail": info}))',
    'PY',
  ].join('\n');
}

/**
 * Delete everything under the slot's `temp/` except the checkout-relative `keep` paths and
 * their ancestors. Task dirs under `taskRoot` and the flow folders left empty are removed one
 * by one and reported. Symlinks are unlinked, never followed; a symlink holding a kept path is
 * left and reported. A Git checkout is never deleted here: prepare parks and removes each one
 * first, so one found now is refused. `temp/` must be a plain directory.
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
  return [
    `__fs_config=${shellQuote(JSON.stringify(config))}`,
    'python3 - "$__fs_config" <<\'PY\'',
    ...PYTHON_COMMON,
    'def checkout_inside(path):',
    '    for parent, dirs, _ in os.walk(path):',
    '        for name in dirs:',
    '            child = os.path.join(parent, name)',
    '            if not os.path.islink(child) and is_checkout(child):',
    '                return child',
    '    return None',
    'def remove(path):',
    '    if os.path.islink(path):',
    '        os.unlink(path)',
    '        emit("removed", path, "link")',
    '    elif os.path.isdir(path):',
    '        inner = path if is_checkout(path) else checkout_inside(path)',
    '        if inner:',
    '            emit("refused", inner, "a Git checkout that was not parked")',
    '            return',
    '        shutil.rmtree(path)',
    '        emit("removed", path, "dir")',
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
    '        except OSError as error:',
    '            emit("refused", path, str(error))',
    'if plain_temp():',
    '    scrub(temp)',
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

export function parseTempSurveyOutput(stdout: string): TempSurvey {
  const result: TempSurvey = { checkouts: [], taskDirs: [], refused: [] };
  for (const record of records(stdout)) {
    const where = text(record.path);
    if (where === null) continue;
    const info = record.detail;
    if (record.kind === 'task') result.taskDirs.push(where);
    else if (record.kind === 'refused')
      result.refused.push({ path: where, reason: text(info) ?? 'refused' });
    else if (record.kind === 'checkout' && info && typeof info === 'object') {
      const field = (name: string): unknown => (name in info ? Reflect.get(info, name) : undefined);
      const branches = field('branches');
      result.checkouts.push({
        path: where,
        bare: field('bare') === true,
        commonDir: text(field('commonDir')) ?? '',
        linked: field('linked') === true,
        branch: text(field('branch')),
        branches: Array.isArray(branches) ? branches.filter((b) => typeof b === 'string') : [],
        hasHead: field('hasHead') === true,
      });
    }
  }
  return result;
}

async function runOnSlot(vars: SlotVars, command: string, what: string): Promise<string> {
  const result = await execOnSlot(vars, command, {
    cwd: vars.remoteRepo,
    timeout: SCRUB_TIMEOUT_MS,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `temp/ ${what} failed for ${vars.slotId}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  return result.stdout;
}

export async function surveySlotTemp(
  vars: SlotVars,
  keep: string[],
  taskRoot: string,
): Promise<TempSurvey> {
  return parseTempSurveyOutput(
    await runOnSlot(
      vars,
      buildTempSurveyCommand({ repo: vars.remoteRepo, keep, taskRoot }),
      'survey',
    ),
  );
}

export async function scrubSlotTemp(
  vars: SlotVars,
  keep: string[],
  taskRoot: string,
): Promise<TempScrubResult> {
  return parseTempScrubOutput(
    await runOnSlot(
      vars,
      buildTempScrubCommand({ repo: vars.remoteRepo, keep, taskRoot }),
      'scrub',
    ),
  );
}
