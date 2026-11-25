import { execOnSlot, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

const SCRUB_TIMEOUT_MS = 120_000;

/** Paths are relative to the slot checkout; `detail` names where a retained checkout went. */
export interface TempScrubResult {
  removed: Array<{ path: string; kind: string }>;
  retained: Array<{ path: string; to: string }>;
  refused: Array<{ path: string; reason: string }>;
}

/**
 * Delete everything under the slot's `temp/` except the checkout-relative `keep` paths and
 * their ancestors. Task dirs under `taskRoot` are removed and reported one by one, and flow
 * folders left empty go too. Symlinks are unlinked, never followed (a symlinked ancestor of a
 * kept path is left alone). A nested Git checkout, bare repos included, is never deleted: it is
 * renamed out of the checkout to `<checkout parent>/.farmslot-retained/<checkout>/<stamp>/`,
 * on the same volume, and the dir around it goes. `temp/` must be a plain directory.
 */
export function buildTempScrubCommand(input: {
  repo: string;
  keep: string[];
  taskRoot: string;
  stamp: string;
}): string {
  const config = {
    repo: input.repo.replace(/\/+$/, ''),
    keep: input.keep,
    taskRoot: input.taskRoot,
    stamp: input.stamp,
  };
  return [
    `__fs_config=${shellQuote(JSON.stringify(config))}`,
    'python3 - "$__fs_config" <<\'PY\'',
    'import json, os, shutil, sys',
    'cfg = json.loads(sys.argv[1])',
    'repo = os.path.realpath(cfg["repo"])',
    'temp = os.path.join(repo, "temp")',
    'keep = {os.path.normpath(os.path.join(repo, rel)) for rel in cfg["keep"]}',
    'task_root = os.path.normpath(os.path.join(repo, cfg["taskRoot"]))',
    'retain_root = os.path.join(os.path.dirname(repo), ".farmslot-retained", os.path.basename(repo), cfg["stamp"])',
    'def emit(kind, path, detail):',
    '    print(json.dumps({"kind": kind, "path": os.path.relpath(path, repo), "detail": detail}))',
    'def keeps_below(path):',
    '    return any(k.startswith(path + os.sep) for k in keep)',
    'def is_checkout(path):',
    '    if os.path.lexists(os.path.join(path, ".git")):',
    '        return True',
    '    return os.path.isfile(os.path.join(path, "HEAD")) and os.path.isdir(os.path.join(path, "objects")) and os.path.isdir(os.path.join(path, "refs"))',
    'def retain(path):',
    '    dest = os.path.join(retain_root, os.path.relpath(path, repo))',
    '    os.makedirs(os.path.dirname(dest), exist_ok=True)',
    '    os.rename(path, dest)',
    '    emit("retained", path, dest)',
    'def retain_inside(path):',
    '    for parent, dirs, _ in os.walk(path):',
    '        for name in list(dirs):',
    '            child = os.path.join(parent, name)',
    '            if not os.path.islink(child) and is_checkout(child):',
    '                retain(child)',
    '                dirs.remove(name)',
    'def remove(path):',
    '    if os.path.islink(path):',
    '        os.unlink(path)',
    '        emit("removed", path, "link")',
    '    elif os.path.isdir(path):',
    '        if is_checkout(path):',
    '            retain(path)',
    '            return',
    '        retain_inside(path)',
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
    '                continue',
    '            if not os.path.islink(path) and os.path.isdir(path) and (keeps_below(path) or path == task_root or os.path.dirname(path) == task_root):',
    '                scrub(path)',
    '                if not keeps_below(path) and path != task_root and not os.listdir(path):',
    '                    os.rmdir(path)',
    '                    emit("removed", path, "dir")',
    '                continue',
    '            remove(path)',
    '        except OSError as error:',
    '            emit("refused", path, str(error))',
    'if os.path.lexists(temp):',
    '    if os.path.islink(temp) or not os.path.isdir(temp):',
    '        emit("refused", temp, "temp/ is not a plain directory in the checkout")',
    '    else:',
    '        scrub(temp)',
    'PY',
  ].join('\n');
}

export function parseTempScrubOutput(stdout: string): TempScrubResult {
  const result: TempScrubResult = { removed: [], retained: [], refused: [] };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { kind?: string; path?: string; detail?: string };
    if (typeof record.path !== 'string' || typeof record.detail !== 'string') continue;
    if (record.kind === 'removed') result.removed.push({ path: record.path, kind: record.detail });
    else if (record.kind === 'retained')
      result.retained.push({ path: record.path, to: record.detail });
    else if (record.kind === 'refused')
      result.refused.push({ path: record.path, reason: record.detail });
  }
  return result;
}

export async function scrubSlotTemp(
  vars: SlotVars,
  keep: string[],
  taskRoot: string,
  stamp = new Date().toISOString().replace(/[:.]/g, '-'),
): Promise<TempScrubResult> {
  const command = buildTempScrubCommand({ repo: vars.remoteRepo, keep, taskRoot, stamp });
  const result = await execOnSlot(vars, command, {
    cwd: vars.remoteRepo,
    timeout: SCRUB_TIMEOUT_MS,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `temp/ scrub failed for ${vars.slotId}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  return parseTempScrubOutput(result.stdout);
}
