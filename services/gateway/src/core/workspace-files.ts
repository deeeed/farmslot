import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isPathInside } from './path.js';

export const WORKSPACE_TEXT_LIMIT = 1024 * 1024;

/** Native workspace readers share lexical and symlink checks. Node lacks openat2;
 * whole-path races against an agent with equivalent local OS access remain possible. */
export async function workspacePath(
  root: string,
  relative: string,
  missing = false,
): Promise<string> {
  // Reject even legal POSIX backslash filenames to avoid separator ambiguity across clients.
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0'))
    throw new Error('Use a relative workspace path');
  const parts = relative.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..' || part.toLowerCase() === '.git'))
    throw new Error('Path outside workspace is not allowed');
  const base = await realpath(root);
  const target = path.resolve(base, ...parts);
  if (!isPathInside(base, target)) throw new Error('Path outside workspace is not allowed');
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Workspace symlinks are not readable');
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

export async function readWorkspaceText(root: string, relative: string): Promise<string> {
  const target = await workspacePath(root, relative);
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Select a regular file');
    if (info.size > WORKSPACE_TEXT_LIMIT) throw new Error('File exceeds the 1 MiB viewer limit');
    const buffer = Buffer.alloc(WORKSPACE_TEXT_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > WORKSPACE_TEXT_LIMIT) throw new Error('File exceeds the 1 MiB viewer limit');
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw new Error('Binary files cannot be displayed');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}
