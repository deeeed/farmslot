// slot-io.ts — Transport abstraction for local/remote slot file operations.
// Local: Node fs. Remote: agent RPC or SSH.
// All functions accept a SlotLocality context (SlotVars satisfies this).

import { existsSync } from 'node:fs';
import {
  chmod as fsChmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import path from 'node:path';

import { type FSWatcher, watch } from 'chokidar';

import { getNode } from '../fleet/machine-registry.js';
import { nodeFsPath, sendNodeRequest } from '../fleet/node-rpc.js';

import { isLocal } from './exec.js';

export const MAX_ARTIFACT_TREE_DEPTH = 12;
// Subset of SlotVars — SlotVars satisfies this via structural typing
export interface SlotLocality {
  host: string;
  machine: string;
  sshTarget: string;
}

export interface SlotCopyDirOptions {
  excludeTopLevel?: string[];
  excludeRelativePaths?: string[];
  /**
   * When set, per-file copy failures are reported via the callback and the
   * walk continues. Without this, the first per-file failure throws
   * SlotCopyDirEntryError. Use for best-effort artifact collection (slot.release)
   * where one transient EACCES on a screenshot must not abort the whole copy.
   */
  onEntryFailure?: (err: SlotCopyDirEntryError) => void;
}

export class SlotCopyDirEntryError extends Error {
  readonly sourcePath: string;
  readonly targetPath: string;
  override readonly cause: unknown;

  constructor(sourcePath: string, targetPath: string, cause: unknown) {
    super(
      `slotCopyDir failed to copy file ${sourcePath} -> ${targetPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'SlotCopyDirEntryError';
    this.sourcePath = sourcePath;
    this.targetPath = targetPath;
    this.cause = cause;
  }
}

function local(ctx: SlotLocality): boolean {
  return isLocal(ctx.host, ctx.machine);
}

function requireNode(machine: string) {
  const node = getNode(machine);
  if (!node) throw new Error(`No node connected for ${machine}`);
  return node;
}

async function assertConcreteDirRoot(
  dirPath: string,
  resolvePath: (inputPath: string) => Promise<string>,
): Promise<void> {
  const [resolvedDirPath, resolvedParentPath] = await Promise.all([
    resolvePath(dirPath),
    resolvePath(path.dirname(dirPath)),
  ]);
  const expectedResolvedDirPath = path.join(resolvedParentPath, path.basename(dirPath));
  if (resolvedDirPath !== expectedResolvedDirPath) {
    throw new Error(`slotCopyDir refuses symlinked root ${dirPath}`);
  }
}

// ─── slotReadFile ───

export async function slotReadFile(ctx: SlotLocality, filePath: string): Promise<string> {
  if (local(ctx)) {
    return readFile(filePath, 'utf-8');
  }
  const result = (await sendNodeRequest(requireNode(ctx.machine), 'fs.read', {
    ...nodeFsPath(filePath),
  })) as { content: string };
  return result.content;
}

export async function slotRealpath(ctx: SlotLocality, filePath: string): Promise<string> {
  if (local(ctx)) return realpath(filePath);
  const result = (await sendNodeRequest(requireNode(ctx.machine), 'fs.realpath', {
    ...nodeFsPath(filePath),
  })) as { path: string };
  return result.path;
}

// ─── slotFileExists ───

export async function slotFileExists(ctx: SlotLocality, filePath: string): Promise<boolean> {
  if (local(ctx)) {
    return existsSync(filePath);
  }
  const result = (await sendNodeRequest(requireNode(ctx.machine), 'fs.exists', {
    ...nodeFsPath(filePath),
  })) as { exists: boolean };
  return result.exists;
}

// ─── slotListDir ───

export async function slotListDir(ctx: SlotLocality, dirPath: string): Promise<string[]> {
  if (local(ctx)) {
    return readdir(dirPath);
  }
  const result = (await sendNodeRequest(requireNode(ctx.machine), 'fs.list', {
    ...nodeFsPath(dirPath),
  })) as { entries: Array<{ name: string }> };
  return result.entries.map((e) => e.name);
}

// ─── slotWriteFile ───

export async function slotWriteFile(
  ctx: SlotLocality,
  filePath: string,
  data: string,
): Promise<void> {
  if (local(ctx)) {
    await fsWriteFile(filePath, data, 'utf-8');
    return;
  }
  await sendNodeRequest(requireNode(ctx.machine), 'fs.write', {
    ...nodeFsPath(filePath),
    content: data,
  });
}

export interface SlotWriteFileEntry {
  /** Path relative to baseDir. */
  path: string;
  /** Base64-encoded file content. */
  content: string;
  /** Octal file mode (e.g. 0o755); left unchanged when omitted. */
  mode?: number;
}

// Batch base64 write: materializes a whole file set under baseDir (creating
// parent dirs and applying modes) in a single node RPC, instead of a mkdir +
// write + chmod round-trip per file.
export async function slotWriteFiles(
  ctx: SlotLocality,
  baseDir: string,
  files: SlotWriteFileEntry[],
): Promise<void> {
  if (local(ctx)) {
    for (const file of files) {
      const dest = path.join(baseDir, file.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await fsWriteFile(dest, Buffer.from(file.content, 'base64'));
      if (typeof file.mode === 'number') await fsChmod(dest, file.mode);
    }
    return;
  }
  await sendNodeRequest(requireNode(ctx.machine), 'fs.writeFiles', {
    root: path.dirname(baseDir),
    relPath: path.basename(baseDir),
    files,
  });
}

// ─── slotCopyFile ───
// Copy a single file from slot to a local destination.
// Local: fs.copyFile. Remote: agent fs.readBase64 → local write.

export async function slotCopyFile(
  ctx: SlotLocality,
  remotePath: string,
  localPath: string,
): Promise<void> {
  if (local(ctx)) {
    await copyFile(remotePath, localPath);
    return;
  }
  const result = (await sendNodeRequest(requireNode(ctx.machine), 'fs.readBase64', {
    ...nodeFsPath(remotePath),
  })) as { content: string };
  await fsWriteFile(localPath, Buffer.from(result.content, 'base64'));
}

// ─── slotCopyDir ───
// Copy a directory from slot to a local destination.
// Local: manual walk so the return value is the number of files copied.
// Remote: recursively walk via agent fs.list → fs.readBase64.

async function copyLocalRecursive(
  rootDir: string,
  sourceDir: string,
  targetDir: string,
  excluded: Set<string>,
  excludedRelativePaths: Set<string>,
  depth: number,
  onEntryFailure?: (err: SlotCopyDirEntryError) => void,
): Promise<number> {
  if (depth > MAX_ARTIFACT_TREE_DEPTH) {
    throw new Error(`slotCopyDir exceeded max recursion depth under ${sourceDir}`);
  }
  const entries = await readdir(sourceDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (depth === 0 && excluded.has(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (isExcludedRelativePath(rootDir, sourcePath, excludedRelativePaths)) continue;
    if (entry.isSymbolicLink()) {
      console.log(`[slot-io] skipping symlink ${sourcePath}`);
      continue;
    }
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      count += await copyLocalRecursive(
        rootDir,
        sourcePath,
        targetPath,
        excluded,
        excludedRelativePaths,
        depth + 1,
        onEntryFailure,
      );
      continue;
    }
    if (entry.isFile()) {
      try {
        await copyFile(sourcePath, targetPath);
        count += 1;
      } catch (err) {
        const entryError = new SlotCopyDirEntryError(sourcePath, targetPath, err);
        if (onEntryFailure) {
          onEntryFailure(entryError);
          continue;
        }
        throw entryError;
      }
      continue;
    }
    // Ignore sockets/fifos/blockdev/chardev — never appear in artifact trees.
  }
  return count;
}

function normalizeRelativeCopyPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function isExcludedRelativePath(
  rootDir: string,
  sourcePath: string,
  excludedRelativePaths: Set<string>,
): boolean {
  if (excludedRelativePaths.size === 0) return false;
  const relativePath = normalizeRelativeCopyPath(path.relative(rootDir, sourcePath));
  for (const excludedPath of excludedRelativePaths) {
    if (relativePath === excludedPath || relativePath.startsWith(`${excludedPath}/`)) return true;
  }
  return false;
}

export async function slotCopyDir(
  ctx: SlotLocality,
  remoteDir: string,
  localDir: string,
  options: SlotCopyDirOptions = {},
): Promise<number> {
  if (local(ctx)) {
    if (!existsSync(remoteDir)) return 0;
    const rootStats = await lstat(remoteDir).catch(() => null);
    if (rootStats?.isSymbolicLink()) {
      throw new Error(`slotCopyDir refuses symlinked root ${remoteDir}`);
    }
    const excluded = new Set(options.excludeTopLevel ?? []);
    const excludedRelativePaths = new Set(
      (options.excludeRelativePaths ?? []).map(normalizeRelativeCopyPath),
    );
    await mkdir(localDir, { recursive: true });
    return copyLocalRecursive(
      remoteDir,
      remoteDir,
      localDir,
      excluded,
      excludedRelativePaths,
      0,
      options.onEntryFailure,
    );
  }

  // Check remote dir exists
  if (!(await slotFileExists(ctx, remoteDir))) return 0;

  const node = requireNode(ctx.machine);
  await assertConcreteDirRoot(remoteDir, async (inputPath) => {
    const result = (await sendNodeRequest(node, 'fs.realpath', nodeFsPath(inputPath))) as {
      path: string;
    };
    return result.path;
  });
  await mkdir(localDir, { recursive: true });
  const excluded = new Set(options.excludeTopLevel ?? []);
  const excludedRelativePaths = new Set(
    (options.excludeRelativePaths ?? []).map(normalizeRelativeCopyPath),
  );

  async function copyRecursive(
    sourceDir: string,
    targetDir: string,
    depth: number,
  ): Promise<number> {
    if (depth > MAX_ARTIFACT_TREE_DEPTH) {
      throw new Error(`slotCopyDir exceeded max recursion depth under ${sourceDir}`);
    }
    const listResult = (await sendNodeRequest(node, 'fs.list', nodeFsPath(sourceDir))) as {
      entries: Array<{ name: string; type: string }>;
    };

    let count = 0;
    for (const entry of listResult.entries) {
      if (depth === 0 && excluded.has(entry.name)) continue;
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (isExcludedRelativePath(remoteDir, sourcePath, excludedRelativePaths)) continue;
      const normalizedSource = path.resolve(sourcePath);
      const normalizedRoot = path.resolve(remoteDir);
      if (
        !(
          normalizedSource === normalizedRoot ||
          normalizedSource.startsWith(`${normalizedRoot}${path.sep}`)
        )
      ) {
        throw new Error(`slotCopyDir encountered out-of-root path ${sourcePath}`);
      }
      if (entry.type === 'file') {
        try {
          const fileResult = (await sendNodeRequest(
            node,
            'fs.readBase64',
            nodeFsPath(sourcePath),
          )) as { content: string };
          await fsWriteFile(targetPath, Buffer.from(fileResult.content, 'base64'));
        } catch (err) {
          const entryError = new SlotCopyDirEntryError(sourcePath, targetPath, err);
          if (options.onEntryFailure) {
            options.onEntryFailure(entryError);
            continue;
          }
          throw entryError;
        }
        count++;
        continue;
      }

      if (entry.type === 'symlink') {
        console.log(`[slot-io] skipping symlink ${sourcePath}`);
        continue;
      }

      if (entry.type === 'directory' || entry.type === 'dir') {
        await mkdir(targetPath, { recursive: true });
        count += await copyRecursive(sourcePath, targetPath, depth + 1);
        continue;
      }

      throw new Error(
        `slotCopyDir encountered unsupported entry type '${entry.type}' at ${sourcePath}`,
      );
    }
    return count;
  }

  return copyRecursive(remoteDir, localDir, 0);
}

// ─── slotWatchFile ───

export function slotWatchFile(
  ctx: SlotLocality,
  filePath: string,
  cb: (content?: string) => void,
): FSWatcher | undefined {
  if (!local(ctx)) return undefined; // remote uses agent fs.watch — handled by caller
  const w = watch(filePath, { persistent: false, ignoreInitial: true });
  w.on('change', () => cb());
  w.on('add', () => cb());
  return w;
}
