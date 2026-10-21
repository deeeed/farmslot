import { chmod, lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Retained bundle files are stored read-only (0400). A copy of one into a task directory is
 * that run's own file, which its worker may edit and capture may overwrite, so give the owner
 * read and write (and directory search) back. The bundle store itself stays read-only.
 */
export async function makeOwnerWritable(target: string): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) return;
  await chmod(target, (info.mode & 0o7777) | (info.isDirectory() ? 0o700 : 0o600));
  if (info.isDirectory())
    for (const entry of await readdir(target)) await makeOwnerWritable(path.join(target, entry));
}

/** Copying onto a read-only file fails with EACCES; remove such a destination before replacing it. */
export async function replaceReadOnlyDestination(destination: string): Promise<void> {
  const info = await lstat(destination).catch(() => null);
  if (info?.isFile() && !(info.mode & 0o200)) await unlink(destination);
}
