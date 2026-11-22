import path from 'node:path';

import { DEFAULT_TASK_DIR } from '@farmslot/protocol';

import { resolveProjectRuntimeDirName, resolveProjectTaskDirName } from '../core/config.js';
import { execOnSlot, getProjectField, type RawProjectJson, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

const DEFAULT_RETENTION_HOURS = 7 * 24;
const CLEANUP_TIMEOUT_MS = 120_000;

export interface SlotStorageCleanupOptions {
  activeTaskRel?: string | null;
  includeBrowserProfiles?: boolean;
  retentionHours?: number;
}

export interface SlotStorageCleanupResult {
  deleted: Array<{ label: string; path: string }>;
  skipped: Array<{ label: string; path: string; reason: string }>;
  /** Worker scratch moved out of the task root (release only), with its new location. */
  parked?: Array<{ path: string; to: string }>;
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
    parkRoot: remoteJoin(runtimeRoot, 'parked-scratch'),
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
    '        if os.path.abspath(path) in active_tasks:',
    '            continue',
    '        age_seconds = now - os.stat(path).st_mtime',
    '        if age_seconds > cutoff_seconds:',
    '            delete_dir(label, path)',
    '',
    'for root in cfg["taskRoots"]:',
    '    if not inside_repo(root):',
    '        print_skipped("task-root", root, "outside repo")',
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
    '# Workers sometimes write scratch beside their task dir (temp/tasks/scratch-probe,',
    '# temp/tasks/feat/scratch-tat-4753). No run owns it, so it outlived release and the',
    '# next blind run saw it. With no active task, move it out of the task root (never',
    '# delete) into the runtime dir.',
    'TASK_MARKERS = ("TASK.md", "CHECKLIST.md", "SIGNAL.json", "artifacts")',
    '',
    'def is_task(path):',
    '    return any(os.path.lexists(os.path.join(path, name)) for name in TASK_MARKERS)',
    '',
    'def holds_task(path, depth=3):',
    '    if depth == 0:',
    '        return False',
    '    return any(is_task(child) or holds_task(child, depth - 1) for child in direct_children(path))',
    '',
    'def has_files(path):',
    '    for _root, _dirs, files in os.walk(path):',
    '        if files:',
    '            return True',
    '    return False',
    '',
    'def scratch_candidates(root):',
    '    found = []',
    '    for child in direct_children(root):',
    '        if is_task(child):',
    '            continue',
    '        if holds_task(child):',
    '            found.extend(g for g in direct_children(child) if not is_task(g) and not holds_task(g) and has_files(g))',
    '        elif has_files(child):',
    '            found.append(child)',
    '    return found',
    '',
    'if not active_tasks:',
    '    stamp = time.strftime("%Y%m%d-%H%M%S")',
    '    for root in cfg["taskRoots"]:',
    '        if not inside_repo(root):',
    '            continue',
    '        for path in scratch_candidates(root):',
    '            dest = os.path.join(cfg["parkRoot"], stamp, os.path.relpath(path, repo))',
    '            os.makedirs(os.path.dirname(dest), exist_ok=True)',
    '            shutil.move(path, dest)',
    '            print(f"parked\\tscratch\\t{path}\\t{dest}")',
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
  const parked: NonNullable<SlotStorageCleanupResult['parked']> = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [kind, label, pathValue, reason] = line.split('\t');
    if (kind === 'deleted' && label && pathValue) {
      deleted.push({ label, path: pathValue });
    } else if (kind === 'skipped' && label && pathValue) {
      skipped.push({ label, path: pathValue, reason: reason || 'unknown' });
    } else if (kind === 'parked' && pathValue && reason) {
      parked.push({ path: pathValue, to: reason });
    }
  }
  return parked.length ? { deleted, skipped, parked } : { deleted, skipped };
}
