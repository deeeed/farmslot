import { execOnSlot, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

const SCRUB_TIMEOUT_MS = 120_000;

export interface TempScrubResult {
  removed: Array<{ path: string; kind: string }>;
  refused: Array<{ path: string; reason: string }>;
}

/**
 * Delete everything under the slot's `temp/` except the repo-relative `keep` paths and their
 * ancestors. Task dirs under `taskRoot` are removed one by one, so each is reported. Symlinks
 * are unlinked, never followed; a nested Git checkout is refused, never deleted, and what is
 * around it still goes. `temp/` itself must be a plain directory inside the checkout.
 */
export function buildTempScrubCommand(input: {
  repo: string;
  keep: string[];
  taskRoot?: string;
}): string {
  const config = {
    repo: input.repo.replace(/\/+$/, ''),
    keep: input.keep,
    taskRoot: input.taskRoot ?? 'temp/tasks',
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
    'def descend(path):',
    '    # The task root and its flow folders: their task dirs are removed and reported singly.',
    '    return path == task_root or os.path.dirname(path) == task_root or any(k.startswith(path + os.sep) for k in keep)',
    'def emit(kind, path, detail):',
    '    print(json.dumps({"kind": kind, "path": path, "detail": detail}))',
    'def holds_checkout(path):',
    '    for _, dirs, files in os.walk(path):',
    '        if ".git" in dirs or ".git" in files:',
    '            return True',
    '    return False',
    'def scrub(parent):',
    '    for name in sorted(os.listdir(parent)):',
    '        path = os.path.join(parent, name)',
    '        if path in keep:',
    '            continue',
    '        try:',
    '            if os.path.islink(path):',
    '                os.unlink(path)',
    '                emit("removed", path, "link")',
    '            elif os.path.isdir(path):',
    '                if os.path.lexists(os.path.join(path, ".git")):',
    '                    emit("refused", path, "is a nested Git checkout")',
    '                elif descend(path) or holds_checkout(path):',
    '                    scrub(path)',
    '                else:',
    '                    shutil.rmtree(path)',
    '                    emit("removed", path, "dir")',
    '            else:',
    '                os.unlink(path)',
    '                emit("removed", path, "file")',
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
  const result: TempScrubResult = { removed: [], refused: [] };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { kind?: string; path?: string; detail?: string };
    if (typeof record.path !== 'string' || typeof record.detail !== 'string') continue;
    if (record.kind === 'removed') result.removed.push({ path: record.path, kind: record.detail });
    else if (record.kind === 'refused')
      result.refused.push({ path: record.path, reason: record.detail });
  }
  return result;
}

export async function scrubSlotTemp(
  vars: SlotVars,
  keep: string[],
  taskRoot: string,
): Promise<TempScrubResult> {
  const command = buildTempScrubCommand({ repo: vars.remoteRepo, keep, taskRoot });
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
