// chat/self-inspection-tools.ts — Bounded Farmslot self-inspection read/search tools.

import { constants, createReadStream, existsSync } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { isPathInside } from '../core/path.js';
import { farmslotRoot } from '../fleet/state.js';
import {
  findRegisteredLogEntry,
  listLogRegistryEntries,
  redactLogContent,
} from '../observability/log-registry.js';
import { getRun, listRuns } from '../runs/store.js';

const SELF_READ_LIMIT = 20_000;
const SELF_READ_MAX_CHARS = 80_000;
const SELF_SEARCH_MAX_BYTES_PER_FILE = 1_000_000;
const SELF_SEARCH_MAX_FILES = 1_500;
const SELF_SEARCH_MAX_PATTERN_CHARS = 200;
const SELF_SEARCH_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.md',
  '.sh',
  '.toml',
  '.yaml',
  '.yml',
  '.log',
]);
const SELF_SEARCH_ROOTS = [
  'services/gateway/src',
  'packages/protocol/src',
  'apps/command-center/ui/src',
  'docs',
  'scripts',
];
const SELF_SKIP_DIRS = new Set([
  '.cache',
  '.git',
  '.next',
  '.yarn',
  'coverage',
  'dist',
  'build',
  '.turbo',
  'node_modules',
]);
function resolveSelfReadPath(rawPath: string): string {
  if (!rawPath) throw new Error('path is required');
  const allowedRoots = SELF_SEARCH_ROOTS.map((root) => path.resolve(farmslotRoot, root));
  if (path.isAbsolute(rawPath)) {
    const absPath = path.resolve(rawPath);
    // Lexical scoping keeps accidental paths out early; canonical realpath checks in readTextPrefix remain the security boundary.
    if (allowedRoots.some((root) => isPathInside(root, absPath))) return absPath;
    throw new Error(`Path outside approved self-inspection scope: ${rawPath}`);
  }
  const absPath = path.resolve(farmslotRoot, rawPath);
  if (!allowedRoots.some((root) => isPathInside(root, absPath))) {
    throw new Error(`Path outside approved self-inspection scope: ${rawPath}`);
  }
  return absPath;
}

function displaySelfPath(absPath: string): string {
  return absPath.startsWith(`${farmslotRoot}/`) ? absPath.replace(`${farmslotRoot}/`, '') : absPath;
}

export async function readFarmslotFileTool(args: Record<string, unknown>) {
  const requestedPath = String(args.path ?? '');
  const logEntries = await listLogRegistryEntries();
  const registeredLog = await findRegisteredLogEntry(requestedPath, logEntries);
  if (registeredLog && !registeredLog.exists) {
    throw new Error(
      `Registered log is not currently present: ${registeredLog.id} (${registeredLog.displayPath})`,
    );
  }
  const absPath = registeredLog?.path ?? resolveSelfReadPath(requestedPath);
  const maxChars = Number(args.max_chars ?? SELF_READ_LIMIT);
  const bounded = await readTextPrefix(
    absPath,
    maxChars,
    registeredLog
      ? {}
      : { allowedRoots: SELF_SEARCH_ROOTS.map((root) => path.resolve(farmslotRoot, root)) },
  );
  return {
    path: registeredLog?.displayPath ?? displaySelfPath(absPath),
    content: registeredLog ? redactLogContent(bounded.content) : bounded.content,
    truncated: bounded.truncated,
    ...(registeredLog ? { redacted: true } : {}),
  };
}

export async function searchFarmslotFilesTool(args: Record<string, unknown>) {
  return searchSelfFiles(
    String(args.pattern ?? ''),
    args.path_prefix as string | undefined,
    (args.max_results as number | undefined) ?? 50,
  );
}

export async function listFarmslotLogsTool() {
  return listLogRegistryEntries();
}

export async function readTaskFileTool(args: Record<string, unknown>) {
  const runId = args.run_id as string | undefined;
  const fileSuffix = (args.file as string | undefined) ?? 'TASK.md';
  const directPath = args.path as string | undefined;
  let absPath: string;
  if (runId) {
    const run = getRun(runId) ?? listRuns({ limit: 200 }).runs.find((r) => r.id.startsWith(runId));
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!run.taskFile) throw new Error(`Run ${runId} has no taskFile`);
    absPath = resolveTaskFileReadPath({ taskFile: run.taskFile, fileSuffix });
  } else if (directPath) {
    absPath = resolveTaskFileReadPath({ directPath });
  } else {
    throw new Error('Provide run_id or path');
  }
  const { content, truncated } = await readTextPrefix(absPath, SELF_READ_LIMIT, {
    allowedRoots: [farmslotRoot],
    requireTasksSegment: true,
  });
  return { path: displaySelfPath(absPath), content, truncated };
}

function hasTasksPathSegment(basePath: string, absPath: string): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(absPath));
  return relative.split(path.sep).includes('tasks');
}

function errorHasCode(err: unknown, code: string): boolean {
  return err instanceof Error && Reflect.get(err, 'code') === code;
}

export function resolveTaskFileReadPath(params: {
  taskFile?: string;
  fileSuffix?: string;
  directPath?: string;
}): string {
  if (params.taskFile) {
    const suffix = params.fileSuffix ?? 'TASK.md';
    if (path.isAbsolute(suffix)) throw new Error('Task file suffix must be relative');
    const taskDir = path.dirname(path.resolve(params.taskFile));
    if (!isPathInside(farmslotRoot, taskDir))
      throw new Error('Run task directory outside farmslotRoot');
    if (!hasTasksPathSegment(farmslotRoot, taskDir))
      throw new Error('Run task directory must be under a task directory');
    const absPath = path.resolve(taskDir, suffix);
    if (!isPathInside(taskDir, absPath)) throw new Error('Path outside run task directory');
    if (!isPathInside(farmslotRoot, absPath)) throw new Error('Path outside farmslotRoot');
    return absPath;
  }

  const directPath = params.directPath;
  if (!directPath) throw new Error('Provide taskFile or directPath');
  if (path.isAbsolute(directPath))
    throw new Error('Direct read_task_file path must be relative to farmslotRoot');
  const absPath = path.resolve(farmslotRoot, directPath);
  if (!isPathInside(farmslotRoot, absPath)) throw new Error('Path outside farmslotRoot');
  if (!hasTasksPathSegment(farmslotRoot, absPath))
    throw new Error('Direct read_task_file path must be under a task directory');
  return absPath;
}

async function canonicalizeReadPath(
  absPath: string,
  allowedRoots: string[],
  allowedFiles: readonly string[],
  requireTasksSegment = false,
): Promise<string> {
  const linkInfo = await lstat(absPath);
  if (linkInfo.isSymbolicLink()) throw new Error('Refusing to read symbolic link');
  const realPath = await realpath(absPath);
  const [realRoots, realFiles] = await Promise.all([
    Promise.all(allowedRoots.map(async (root) => realpath(root))),
    Promise.all(
      allowedFiles.map(async (file) =>
        realpath(file).catch((err: unknown) => {
          if (errorHasCode(err, 'ENOENT')) return null;
          throw err;
        }),
      ),
    ),
  ]);
  if (realFiles.some((file) => file === realPath)) return realPath;
  const matchedRoot = realRoots.find((root) => isPathInside(root, realPath));
  if (!matchedRoot) throw new Error('Resolved path outside approved read scope');
  if (requireTasksSegment && !hasTasksPathSegment(matchedRoot, realPath)) {
    throw new Error('Resolved task path must be under a task directory');
  }
  return realPath;
}

async function readTextPrefix(
  absPath: string,
  requestedMaxChars: number,
  options: {
    allowedRoots?: string[];
    allowedFiles?: readonly string[];
    requireTasksSegment?: boolean;
  } = {},
): Promise<{ content: string; truncated: boolean }> {
  const maxChars = Math.min(
    Math.max(1, Math.floor(requestedMaxChars) || SELF_READ_LIMIT),
    SELF_READ_MAX_CHARS,
  );
  const readPath =
    options.allowedRoots || options.allowedFiles
      ? await canonicalizeReadPath(
          absPath,
          options.allowedRoots ?? [],
          options.allowedFiles ?? [],
          options.requireTasksSegment,
        )
      : absPath;
  const handle = await open(readPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.size === 0) return { content: '', truncated: false };
    const bytesToRead = Math.min(info.size, maxChars + 1);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    return {
      content: content.slice(0, maxChars),
      truncated: info.size > bytesToRead || content.length > maxChars,
    };
  } finally {
    await handle.close();
  }
}

async function searchSelfFiles(
  pattern: string,
  pathPrefix: string | undefined,
  maxResults: number,
) {
  if (!pattern) throw new Error('pattern is required');
  const regex = compileSearchRegex(pattern);
  const roots = resolveSearchRoots(pathPrefix);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let filesScanned = 0;
  let contentTruncated = false;
  const resultLimit = Math.max(1, Math.min(200, Math.floor(maxResults) || 50));
  for (const root of roots) {
    for (const filePath of await walkFiles(root, SELF_SEARCH_MAX_FILES)) {
      if (!SELF_SEARCH_EXTENSIONS.has(path.extname(filePath))) continue;
      filesScanned++;
      const info = await stat(filePath);
      if (info.size === 0) continue;
      contentTruncated ||= info.size > SELF_SEARCH_MAX_BYTES_PER_FILE;
      const stream = createReadStream(filePath, {
        encoding: 'utf8',
        start: 0,
        end: Math.max(0, Math.min(info.size, SELF_SEARCH_MAX_BYTES_PER_FILE) - 1),
      });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let lineNo = 0;
      for await (const line of lines) {
        lineNo++;
        if (!regex.test(line)) continue;
        matches.push({ path: displaySelfPath(filePath), line: lineNo, text: line.slice(0, 300) });
        if (matches.length >= resultLimit) {
          lines.close();
          stream.destroy();
          return { matches, truncated: true, filesScanned };
        }
      }
    }
  }
  return { matches, truncated: contentTruncated, filesScanned };
}

function resolveSearchRoots(pathPrefix: string | undefined): string[] {
  const allowedRoots = SELF_SEARCH_ROOTS.map((root) => path.resolve(farmslotRoot, root));
  if (!pathPrefix) return allowedRoots.filter((root) => existsSync(root));
  const requested = path.resolve(farmslotRoot, pathPrefix);
  if (!allowedRoots.some((root) => isPathInside(root, requested))) {
    throw new Error(`path_prefix must be inside one of: ${SELF_SEARCH_ROOTS.join(', ')}`);
  }
  return [requested].filter((root) => existsSync(root));
}

function compileSearchRegex(pattern: string): RegExp {
  if (pattern.length > SELF_SEARCH_MAX_PATTERN_CHARS) {
    throw new Error(
      `Search regex is too long (${pattern.length} chars, max ${SELF_SEARCH_MAX_PATTERN_CHARS})`,
    );
  }
  if (hasBacktrackingRisk(pattern)) {
    throw new Error(
      'Search regex uses nested or ambiguous quantifiers that are not allowed in gateway self-search',
    );
  }
  try {
    // Keep search case-insensitive; do not enable global/sticky flags because matching is line-by-line.
    return new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(`Invalid search regex: ${(err as Error).message}`);
  }
}

function splitTopLevelAlternatives(pattern: string): string[] {
  const alternatives: string[] = [];
  let current = '';
  let escaped = false;
  let charClass = false;
  let depth = 0;
  for (const ch of pattern) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (charClass) {
      current += ch;
      if (ch === ']') charClass = false;
      continue;
    }
    if (ch === '[') {
      current += ch;
      charClass = true;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === '|' && depth === 0) {
      alternatives.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  alternatives.push(current);
  return alternatives;
}

function hasAmbiguousAlternation(pattern: string): boolean {
  const alternatives = splitTopLevelAlternatives(pattern)
    .map((part) => part.trim())
    .filter(Boolean);
  for (let i = 0; i < alternatives.length; i++) {
    for (let j = i + 1; j < alternatives.length; j++) {
      const a = alternatives[i];
      const b = alternatives[j];
      if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
    }
  }
  return false;
}

function hasBacktrackingRisk(pattern: string): boolean {
  let escaped = false;
  const stack: Array<{ hasQuantifier: boolean; content: string }> = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      if (stack.length) stack[stack.length - 1].content += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (stack.length) stack[stack.length - 1].content += ch;
      escaped = true;
      continue;
    }
    if (ch === '[') {
      if (stack.length) stack[stack.length - 1].content += ch;
      while (++i < pattern.length) {
        if (stack.length) stack[stack.length - 1].content += pattern[i];
        if (pattern[i] === '\\') i++;
        else if (pattern[i] === ']') break;
      }
      continue;
    }
    if (ch === '(') {
      if (stack.length) stack[stack.length - 1].content += ch;
      stack.push({ hasQuantifier: false, content: '' });
      continue;
    }
    if (ch === ')') {
      const group = stack.pop();
      const next = pattern[i + 1];
      if (group?.hasQuantifier && (next === '+' || next === '*' || next === '?' || next === '{'))
        return true;
      if (
        group &&
        hasAmbiguousAlternation(group.content) &&
        (next === '+' || next === '*' || next === '{')
      )
        return true;
      if (stack.length) stack[stack.length - 1].content += `(${group?.content ?? ''})`;
      continue;
    }
    if (stack.length) stack[stack.length - 1].content += ch;
    if (ch === '+' || ch === '*' || ch === '?' || ch === '{') {
      for (const group of stack) group.hasQuantifier = true;
      if ((ch === '+' || ch === '*') && (pattern[i + 1] === '+' || pattern[i + 1] === '*'))
        return true;
    }
  }
  return false;
}

async function walkFiles(root: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SELF_SKIP_DIRS.has(entry.name)) continue;
        await visit(absPath);
      } else if (entry.isFile()) {
        out.push(absPath);
      }
    }
  }
  await visit(root);
  return out;
}
