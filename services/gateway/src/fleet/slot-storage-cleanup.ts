import path from 'node:path';

import { DEFAULT_TASK_DIR } from '@farmslot/protocol';

import { execOnSlot, getProjectField, type RawProjectJson, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

const DEFAULT_RETENTION_HOURS = 168;
const DEFAULT_KEEP_RUNS = 5;
const CLEANUP_TIMEOUT_MS = 120_000;

export interface SlotStorageCleanupOptions {
  activeTaskRel?: string | null;
  includeBrowserProfiles?: boolean;
  keepRuns?: number;
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

function cleanupKeepRuns(input?: number): number {
  if (typeof input === 'number' && Number.isInteger(input) && input >= 0) return input;
  const raw = process.env.FARMSLOT_SLOT_STORAGE_KEEP_RUNS;
  if (!raw) return DEFAULT_KEEP_RUNS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_KEEP_RUNS;
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
  const keepRuns = cleanupKeepRuns(input.keepRuns);
  const taskRoot = remoteJoin(input.repo, safeRelativeDir(input.taskDirName, DEFAULT_TASK_DIR));
  const artifactRoot = remoteJoin(
    input.repo,
    safeRelativeDir(input.artifactDirName, input.taskDirName),
  );
  const runtimeRoot = remoteJoin(input.repo, safeRelativeDir(input.runtimeDirName, '.agent'));
  const activeTaskRel = safeRelativePath(input.activeTaskRel);
  const activeTaskPath = activeTaskRel ? remoteJoin(taskRoot, activeTaskRel) : '';
  const taskRoots = unique([taskRoot, artifactRoot]);
  const runtimeChildRoots = unique([
    remoteJoin(runtimeRoot, 'artifacts'),
    remoteJoin(runtimeRoot, 'recipe-runs'),
    remoteJoin(runtimeRoot, 'screenshots'),
    remoteJoin(input.repo, 'temp/agentic'),
  ]);
  const config = {
    activeTaskPath,
    cutoffMinutes: retentionMinutes,
    includeBrowserProfiles: input.includeBrowserProfiles === true,
    keepRuns,
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
    'active_task = os.path.abspath(cfg["activeTaskPath"]) if cfg.get("activeTaskPath") else ""',
    'cutoff_seconds = float(cfg["cutoffMinutes"]) * 60.0',
    'keep_runs = int(cfg["keepRuns"])',
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
    '    kept = 0',
    '    for path in ordered:',
    '        if active_task and os.path.abspath(path) == active_task:',
    '            continue',
    '        age_seconds = now - os.stat(path).st_mtime',
    '        if kept >= keep_runs or age_seconds > cutoff_seconds:',
    '            delete_dir(label, path)',
    '        else:',
    '            kept += 1',
    '',
    'for root in cfg["taskRoots"]:',
    '    if not inside_repo(root):',
    '        print_skipped("task-root", root, "outside repo")',
    '        continue',
    '    prune("task-dir", task_candidates(root))',
    '',
    'for root in cfg["runtimeChildRoots"]:',
    '    if not inside_repo(root):',
    '        print_skipped("runtime-cache", root, "outside repo")',
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
  const taskDirName = getProjectField(projectJson, 'task_dir') || DEFAULT_TASK_DIR;
  const artifactDirName = getProjectField(projectJson, 'paths.artifact_dir') || taskDirName;
  const runtimeDirName = getProjectField(projectJson, 'paths.runtime_dir') || '.agent';
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
