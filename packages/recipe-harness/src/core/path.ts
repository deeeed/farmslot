import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { normalizeRelativePath } from './json.js';

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export async function readFileWithinRoot(root: string, relativePath: string): Promise<Buffer> {
  const handle = await openExistingFileWithinRoot(root, relativePath);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function statFileWithinRoot(root: string, relativePath: string) {
  const handle = await openExistingFileWithinRoot(root, relativePath);
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

export async function writeFileWithinRoot(
  root: string,
  relativePath: string,
  data: string | Uint8Array,
): Promise<string> {
  const { handle, path: outputPath } = await openOutputFileWithinRoot(root, relativePath);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  return outputPath;
}

export async function copyFileWithinRoots(
  sourceRoot: string,
  sourceRelativePath: string,
  destinationRoot: string,
  destinationRelativePath: string,
): Promise<string> {
  let source: FileHandle | undefined;
  let destination: { handle: FileHandle; path: string } | undefined;
  try {
    source = await openExistingFileWithinRoot(sourceRoot, sourceRelativePath);
    destination = await openOutputFileWithinRoot(destinationRoot, destinationRelativePath);
    await pipeline(source.createReadStream(), destination.handle.createWriteStream());
    return destination.path;
  } finally {
    await Promise.allSettled([
      ...(source ? [source.close()] : []),
      ...(destination ? [destination.handle.close()] : []),
    ]);
  }
}

async function openExistingFileWithinRoot(root: string, relativePath: string): Promise<FileHandle> {
  const rootReal = await realpath(root);
  const candidateReal = await realpath(path.join(root, normalizeRelativePath(relativePath)));
  assertContained(rootReal, candidateReal, relativePath);
  return open(candidateReal, constants.O_RDONLY | constants.O_NOFOLLOW);
}

async function openOutputFileWithinRoot(
  root: string,
  relativePath: string,
): Promise<{ handle: FileHandle; path: string }> {
  const normalized = normalizeRelativePath(relativePath);
  const rootReal = await realpath(root);
  const parentReal = await ensureContainedDirectory(
    rootReal,
    path.dirname(normalized),
    relativePath,
  );
  const outputPath = path.join(parentReal, path.basename(normalized));
  // A hostile same-user process can still swap an already-checked parent; closing
  // that race requires directory-fd/openat isolation beyond this accidental-use guard.
  try {
    const existing = await lstat(outputPath);
    if (existing.isSymbolicLink()) {
      throw new Error(`Path ${relativePath} must not resolve through a symbolic link.`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return {
    path: outputPath,
    handle: await open(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    ),
  };
}

async function ensureContainedDirectory(
  rootReal: string,
  relativeDirectory: string,
  displayPath: string,
): Promise<string> {
  let current = rootReal;
  const components = relativeDirectory === '.' ? [] : relativeDirectory.split(path.sep);
  for (const component of components) {
    const candidate = path.join(current, component);
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        throw new Error(`Path ${displayPath} has a non-directory parent component.`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
    }
    const resolved = await realpath(candidate);
    assertContained(rootReal, resolved, displayPath);
    const resolvedInfo = await lstat(resolved);
    if (!resolvedInfo.isDirectory()) {
      throw new Error(`Path ${displayPath} has a non-directory parent component.`);
    }
    current = resolved;
  }
  return current;
}

function assertContained(root: string, candidate: string, relativePath: string): void {
  if (!isPathWithin(root, candidate)) {
    throw new Error(`Path ${relativePath} resolves outside its root.`);
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}
