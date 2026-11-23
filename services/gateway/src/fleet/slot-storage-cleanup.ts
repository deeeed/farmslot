import path from 'node:path';

import { DEFAULT_TASK_DIR } from '@farmslot/protocol';
import { currentFarmPaths, legacyRemoteFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { reportedFarmPaths } from '@farmslot/slot-config';

import { resolveProjectRuntimeDirName, resolveProjectTaskDirName } from '../core/config.js';
import {
  execOnSlot,
  getProjectField,
  isLocal,
  type RawProjectJson,
  type SlotVars,
} from '../core/index.js';
import { shellQuote } from '../core/tmux.js';
import { flowDir } from '../intelligence/engine.js';

const DEFAULT_RETENTION_HOURS = 7 * 24;
const CLEANUP_TIMEOUT_MS = 120_000;

export interface SlotStorageCleanupOptions {
  activeTaskRel?: string | null;
  /** Absolute paths the task-dir prune must keep (scratch that parking refused). */
  keepPaths?: string[];
  /** Skip the task-dir prune (scratch parking could not classify the task root). */
  skipTaskPrune?: boolean;
  includeBrowserProfiles?: boolean;
  retentionHours?: number;
}

export interface SlotStorageCleanupResult {
  deleted: Array<{ label: string; path: string }>;
  skipped: Array<{ label: string; path: string; reason: string }>;
}

interface SlotStorageCleanupCommandInput extends SlotStorageCleanupOptions {
  repo: string;
  taskDirName: string;
  artifactDirName: string;
  runtimeDirName: string;
}

function cleanupRetentionHours(input?: number): number {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) return input;
  const raw = process.env.FARMSLOT_SLOT_STORAGE_RETENTION_HOURS;
  if (!raw) return DEFAULT_RETENTION_HOURS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_HOURS;
}

function safeRelativeDir(input: string | undefined, fallback: string): string {
  const raw = input?.trim() || fallback;
  const normalized = path.posix.normalize(raw);
  if (
    normalized === '.' ||
    normalized === '/' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return fallback;
  }
  return normalized;
}

function safeRelativePath(input: string | null | undefined): string {
  if (!input) return '';
  const normalized = path.posix.normalize(input);
  if (
    normalized === '.' ||
    normalized === '/' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return '';
  }
  return normalized;
}

export function normalizeTaskRelativeDir(
  input: string | null | undefined,
  taskDirName: string,
): string {
  const safeInput = safeRelativePath(input);
  if (!safeInput) return '';
  const safeTaskRoot = safeRelativeDir(taskDirName, DEFAULT_TASK_DIR).replace(/\/+$/, '');
  const withoutTaskRoot = safeInput.startsWith(`${safeTaskRoot}/`)
    ? safeInput.slice(safeTaskRoot.length + 1)
    : safeInput;
  return path.posix.basename(withoutTaskRoot) === 'TASK.md'
    ? path.posix.dirname(withoutTaskRoot)
    : withoutTaskRoot;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function remoteJoin(repo: string, rel: string): string {
  return `${repo.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`;
}

export function buildSlotStorageCleanupCommand(input: SlotStorageCleanupCommandInput): string {
  const retentionMinutes = Math.max(
    1,
    Math.floor(cleanupRetentionHours(input.retentionHours) * 60),
  );
  const taskRoot = remoteJoin(input.repo, safeRelativeDir(input.taskDirName, DEFAULT_TASK_DIR));
  const artifactRoot = remoteJoin(
    input.repo,
    safeRelativeDir(input.artifactDirName, input.taskDirName),
  );
  const runtimeRoot = remoteJoin(input.repo, safeRelativeDir(input.runtimeDirName, '.agent'));
  const activeTaskRel = normalizeTaskRelativeDir(input.activeTaskRel, input.taskDirName);
  const taskRoots = unique([taskRoot, artifactRoot]);
  const activeTaskPaths = activeTaskRel
    ? taskRoots.map((root) => remoteJoin(root, activeTaskRel))
    : [];
  const runtimeChildRoots = unique([
    remoteJoin(runtimeRoot, 'artifacts'),
    remoteJoin(runtimeRoot, 'recipe-runs'),
    remoteJoin(runtimeRoot, 'screenshots'),
    remoteJoin(input.repo, 'temp/agentic'),
  ]);
  const config = {
    keepPaths: input.keepPaths ?? [],
    skipTaskPrune: input.skipTaskPrune === true,
    activeTaskPaths,
    cutoffMinutes: retentionMinutes,
    includeBrowserProfiles: input.includeBrowserProfiles === true,
    repo: input.repo.replace(/\/+$/, ''),
    runtimeChildRoots,
    runtimeRoot,
    taskRoots,
  };

  return [
    `__fs_config=${shellQuote(JSON.stringify(config))}`,
    'python3 - "$__fs_config" <<\'PY\'',
    'import fnmatch',
    'import json',
    'import os',
    'import shutil',
    'import sys',
    'import time',
    '',
    'cfg = json.loads(sys.argv[1])',
    'repo = os.path.abspath(cfg["repo"])',
    'active_tasks = {os.path.abspath(path) for path in cfg.get("activeTaskPaths", [])}',
    'kept = {os.path.realpath(path) for path in cfg.get("keepPaths", [])}',
    '# Kept scratch and every directory above it, indexed once.',
    'kept_or_above = set()',
    'for k in kept:',
    '    probe = k',
    '    while probe not in kept_or_above and probe != os.path.dirname(probe):',
    '        kept_or_above.add(probe)',
    '        probe = os.path.dirname(probe)',
    'def guarded(path):',
    '    # Kept scratch, any candidate containing it, and anything inside it.',
    '    real = os.path.realpath(path)',
    '    if real in kept_or_above:',
    '        return True',
    '    probe = os.path.dirname(real)',
    '    while probe != os.path.dirname(probe):',
    '        if probe in kept:',
    '            return True',
    '        probe = os.path.dirname(probe)',
    '    return False',
    'cutoff_seconds = float(cfg["cutoffMinutes"]) * 60.0',
    'now = time.time()',
    '',
    'def inside_repo(path):',
    '    try:',
    '        return os.path.commonpath([repo, os.path.abspath(path)]) == repo and os.path.abspath(path) != repo',
    '    except ValueError:',
    '        return False',
    '',
    'def print_skipped(label, path, reason):',
    '    print(f"skipped\\t{label}\\t{path}\\t{reason}")',
    '',
    'def delete_dir(label, path):',
    '    if not inside_repo(path):',
    '        print_skipped(label, path, "outside repo")',
    '        return',
    '    print(f"deleted\\t{label}\\t{path}")',
    '    shutil.rmtree(path)',
    '',
    'def is_dir(path):',
    '    return os.path.isdir(path) and not os.path.islink(path)',
    '',
    'def direct_children(root):',
    '    if not is_dir(root):',
    '        return []',
    '    return [os.path.join(root, name) for name in os.listdir(root) if is_dir(os.path.join(root, name))]',
    '',
    'def task_candidates(root):',
    '    if not is_dir(root):',
    '        return []',
    '    candidates = []',
    '    for child in direct_children(root):',
    '        if os.path.isfile(os.path.join(child, "TASK.md")) or is_dir(os.path.join(child, "artifacts")):',
    '            candidates.append(child)',
    '        for grandchild in direct_children(child):',
    '            candidates.append(grandchild)',
    '    return candidates',
    '',
    'def browser_profile_candidates(root):',
    '    patterns = ("*chrome-profile*", "*browser-profile*", "*playwright*")',
    '    return [p for p in direct_children(root) if any(fnmatch.fnmatch(os.path.basename(p), pat) for pat in patterns)]',
    '',
    'def prune(label, candidates):',
    '    unique = {}',
    '    for path in candidates:',
    '        unique[os.path.abspath(path)] = path',
    '    ordered = sorted(unique.values(), key=lambda p: os.stat(p).st_mtime, reverse=True)',
    '    for path in ordered:',
    '        if os.path.abspath(path) in active_tasks or guarded(path):',
    '            continue',
    '        age_seconds = now - os.stat(path).st_mtime',
    '        if age_seconds > cutoff_seconds:',
    '            delete_dir(label, path)',
    '',
    'for root in cfg["taskRoots"]:',
    '    if not inside_repo(root):',
    '        print_skipped("task-root", root, "outside repo")',
    '        continue',
    '    if cfg.get("skipTaskPrune"):',
    '        print_skipped("task-root", root, "scratch parking unavailable")',
    '        continue',
    '    prune("task-dir", task_candidates(root))',
    '',
    '# Runtime caches can be shared by the task that currently owns the slot.',
    '# Only prune them once the slot has no active task; release performs that',
    '# cleanup after copying the completed task artifacts back to the gateway.',
    'for root in cfg["runtimeChildRoots"]:',
    '    if not inside_repo(root):',
    '        print_skipped("runtime-cache", root, "outside repo")',
    '        continue',
    '    if active_tasks:',
    '        print_skipped("runtime-cache", root, "active task")',
    '        continue',
    '    prune("runtime-cache", direct_children(root))',
    '',
    'if cfg.get("includeBrowserProfiles"):',
    '    root = cfg["runtimeRoot"]',
    '    if not inside_repo(root):',
    '        print_skipped("browser-profile", root, "outside repo")',
    '    else:',
    '        prune("browser-profile", browser_profile_candidates(root))',
    'PY',
  ].join('\n');
}

export async function cleanupSlotStorage(
  vars: SlotVars,
  projectJson: RawProjectJson,
  options: SlotStorageCleanupOptions = {},
): Promise<SlotStorageCleanupResult> {
  const taskDirName = resolveProjectTaskDirName(projectJson);
  const artifactDirName = getProjectField(projectJson, 'paths.artifact_dir') || taskDirName;
  const runtimeDirName = resolveProjectRuntimeDirName(projectJson);
  const command = buildSlotStorageCleanupCommand({
    repo: vars.remoteRepo,
    taskDirName,
    artifactDirName,
    runtimeDirName,
    ...options,
  });
  const result = await execOnSlot(vars, command, {
    cwd: vars.remoteRepo,
    timeout: CLEANUP_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `slot storage cleanup failed for ${vars.slotId}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return parseSlotStorageCleanupOutput(result.stdout);
}

export function parseSlotStorageCleanupOutput(stdout: string): SlotStorageCleanupResult {
  const deleted: SlotStorageCleanupResult['deleted'] = [];
  const skipped: SlotStorageCleanupResult['skipped'] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [kind, label, pathValue, reason] = line.split('\t');
    if (kind === 'deleted' && label && pathValue) {
      deleted.push({ label, path: pathValue });
    } else if (kind === 'skipped' && label && pathValue) {
      skipped.push({ label, path: pathValue, reason: reason || 'unknown' });
    }
  }
  return { deleted, skipped };
}

export interface TaskScratchParkResult {
  parked: Array<{ path: string; to: string }>;
  refused: Array<{ path: string; reason: string }>;
}

// The flow folders Farmslot creates under the task root (tasks/writer.ts: flowDir(flowType)).
const FLOW_TYPES = ['fix-bug', 'review-pr', 'qa', 'dev', 'pr-complete', 'update-branch'] as const;

/**
 * Workers sometimes write scratch beside their task dir (temp/tasks/scratch-probe,
 * temp/tasks/feat/scratch-tat-4753). No run owns it, so it outlived release and the next
 * blind run saw it. Move `scratch*` directories directly under the task root, under temp/
 * (only for the temp/tasks layout) or under one of its
 * flow folders to a fresh `<parkHome>/parked-scratch/<slot>/<time>/`, by atomic rename only:
 * never delete, and refuse rather than copy across devices. A directory holding TASK.md is a
 * task dir (a SCRATCH-12 Jira key or a QA title can produce `scratch-…`) and is never moved;
 * a TASK.md that cannot be checked counts as present.
 */
export function buildTaskScratchParkCommand(input: {
  repo: string;
  taskDirName: string;
  slotId: string;
  parkHome: string;
  /** Fixed parking directory name; tests use it to force a collision. */
  parkStamp?: string;
}): string {
  const taskRoot = safeRelativeDir(input.taskDirName, DEFAULT_TASK_DIR).replace(/\/+$/, '');
  const config = {
    repo: input.repo.replace(/\/+$/, ''),
    taskRoot,
    flows: unique(FLOW_TYPES.map((flow) => flowDir(flow))),
    // temp/ itself only for the temp/tasks layout: a custom task root's parent may hold
    // unrelated data, or be the task root's own scratch-named ancestor.
    tempParent: taskRoot === 'temp/tasks' ? 'temp' : null,
    parkStamp: input.parkStamp ?? null,
    parkRoot: `${input.parkHome.replace(/\/+$/, '')}/parked-scratch/${input.slotId.replace(/[^A-Za-z0-9._-]/g, '_')}`,
  };
  return [
    `__fs_config=${shellQuote(JSON.stringify(config))}`,
    'python3 - "$__fs_config" <<\'PY\'',
    'import json, os, sys, time',
    'cfg = json.loads(sys.argv[1])',
    'repo = os.path.realpath(cfg["repo"])',
    'def emit(kind, path, detail):',
    '    print(json.dumps({"kind": kind, "path": path, "detail": detail}))',
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
    'root = os.path.join(repo, cfg["taskRoot"])',
    'parents = [root] + [os.path.join(root, flow) for flow in cfg["flows"]]',
    'if cfg["tempParent"]:',
    '    parents.append(os.path.join(repo, cfg["tempParent"]))',
    'found = []',
    'for parent in parents:',
    '    if plain_dir(parent):',
    '        found += [os.path.join(parent, n) for n in sorted(os.listdir(parent)) if n.startswith("scratch")]',
    '# The configured base is trusted and resolved; parked-scratch/<slot> below it stay as spelled.',
    'raw = os.path.abspath(os.path.expanduser(cfg["parkRoot"]))',
    'home = os.path.join(os.path.realpath(os.path.dirname(os.path.dirname(raw))), os.path.basename(os.path.dirname(raw)), os.path.basename(raw))',
    'def unsafe_home():',
    '    # parked-scratch and the slot directory are plain directories, and the result is outside the checkout.',
    '    if any(os.path.islink(p) for p in (os.path.dirname(home), home)):',
    '        return True',
    '    return os.path.commonpath([repo, os.path.realpath(home)]) == repo',
    'park = None',
    'for path in found:',
    '    if not plain_dir(path) or task_marker(path):',
    '        continue',
    '    try:',
    '        if park is None:',
    '            if unsafe_home():',
    '                raise OSError("parking location is a symlink or inside the checkout")',
    '            os.makedirs(home, exist_ok=True)',
    '            # A fresh directory of our own: nothing inside it can already exist. Only a',
    '            # successful mkdir makes it the parking directory.',
    '            fresh = os.path.join(home, cfg["parkStamp"] or time.strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}")',
    '            os.mkdir(fresh)',
    '            park = fresh',
    '        dest = os.path.join(park, os.path.relpath(path, repo))',
    '        os.makedirs(os.path.dirname(dest), exist_ok=True)',
    '        if os.path.realpath(os.path.dirname(dest)) != os.path.dirname(dest):',
    '            emit("refused", path, "parking location is not a plain directory")',
    '        elif os.stat(path).st_dev != os.stat(park).st_dev:',
    '            emit("refused", path, "parking crosses devices")',
    '        else:',
    '            os.rename(path, dest)',
    '            emit("parked", path, dest)',
    '    except OSError as error:',
    '        # Refused, never retried as a copy; earlier moves stay reported.',
    '        emit("refused", path, str(error))',
    'PY',
  ].join('\n');
}

export function parseTaskScratchParkOutput(stdout: string): TaskScratchParkResult {
  const result: TaskScratchParkResult = { parked: [], refused: [] };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { kind?: string; path?: string; detail?: string };
    if (typeof record.path !== 'string' || typeof record.detail !== 'string') continue;
    if (record.kind === 'parked') result.parked.push({ path: record.path, to: record.detail });
    else if (record.kind === 'refused')
      result.refused.push({ path: record.path, reason: record.detail });
  }
  return result;
}

/**
 * The slot machine's farm home, resolved exactly as blind trials resolve the home their
 * sandbox denies (blind-trial.ts blindFarmPaths): a layout-2 path report, else this
 * gateway's paths for a local slot, else the legacy node default with the pool env.
 */
export function slotFarmHome(vars: Pick<SlotVars, 'machine' | 'host' | 'machineEnv'>): string {
  const report = reportedFarmPaths(vars.machine);
  if (report?.layout === 2) return report.home;
  return isLocal(vars.host, vars.machine)
    ? currentFarmPaths('gateway').home
    : legacyRemoteFarmPaths(vars.machineEnv).home;
}

export async function parkTaskScratch(
  vars: SlotVars,
  projectJson: RawProjectJson,
): Promise<TaskScratchParkResult> {
  const command = buildTaskScratchParkCommand({
    repo: vars.remoteRepo,
    taskDirName: resolveProjectTaskDirName(projectJson),
    slotId: vars.slotId,
    parkHome: slotFarmHome(vars),
  });
  const result = await execOnSlot(vars, command, {
    cwd: vars.remoteRepo,
    timeout: CLEANUP_TIMEOUT_MS,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `scratch parking failed for ${vars.slotId}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  return parseTaskScratchParkOutput(result.stdout);
}
