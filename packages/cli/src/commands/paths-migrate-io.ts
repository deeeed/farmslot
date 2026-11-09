import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  statfs,
} from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export interface FileIdentity {
  kind: 'file' | 'directory' | 'link';
  mode: number;
  bytes: number;
  digest: string;
}
export type Inventory = Record<string, FileIdentity>;
export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
export async function info(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}
export function within(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}
export async function inventory(root: string): Promise<Inventory> {
  const result: Inventory = {};
  async function visit(file: string): Promise<void> {
    const value = await lstat(file);
    const key = path.relative(root, file);
    const mode = value.mode & 0o777;
    if (value.isSymbolicLink())
      result[key] = { kind: 'link', mode, bytes: 0, digest: await readlink(file) };
    else if (value.isDirectory()) {
      result[key] = { kind: 'directory', mode, bytes: 0, digest: '' };
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name));
    } else if (value.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      result[key] = { kind: 'file', mode, bytes: value.size, digest: hash.digest('hex') };
    } else throw new Error(`Cannot migrate special file: ${file}`);
  }
  await visit(root);
  return result;
}
export async function assertIdentity(
  file: string,
  expected: Inventory,
  subset = false,
): Promise<void> {
  const actual = await inventory(file);
  if (
    subset
      ? !Object.entries(actual).every(([key, value]) => isDeepStrictEqual(value, expected[key]))
      : !isDeepStrictEqual(actual, expected)
  )
    throw new Error(`Migration bytes changed: ${file}`);
}
export async function assertUnredirected(file: string): Promise<void> {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if ((await info(current))?.isSymbolicLink())
      throw new Error(`Migration path is redirected by symlink: ${current}`);
    if (path.dirname(current) === current) return;
  }
}
export async function existingParent(file: string): Promise<string> {
  let current = file;
  while (!(await info(current))) current = path.dirname(current);
  return current;
}
export async function availableBytes(file: string): Promise<number> {
  const value = await statfs(await existingParent(file));
  return value.bavail * value.bsize;
}
export async function atomicFile(file: string, body: string | Buffer, mode = 0o600): Promise<void> {
  const temporary = `${file}.migrate-${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await syncDirectory(path.dirname(file));
}
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Copy only regular files/directories. Migration never creates a symlink. */
export async function copyTree(source: string, target: string, expected: Inventory): Promise<void> {
  if (Object.values(expected).some((entry) => entry.kind === 'link'))
    throw new Error(`Cross-volume tree contains symlinks: ${source}`);
  for (const [relative, entry] of Object.entries(expected)) {
    const to = path.join(target, relative);
    await assertUnredirected(to);
    if (entry.kind === 'directory') {
      await mkdir(to, { recursive: true, mode: entry.mode | 0o700 });
      await chmod(to, entry.mode | 0o700);
    } else {
      await mkdir(path.dirname(to), { recursive: true });
      if (await info(to)) await chmod(to, entry.mode | 0o600);
      await copyFile(path.join(source, relative), to);
      await chmod(to, entry.mode);
      const handle = await open(to, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  for (const [relative, entry] of Object.entries(expected).reverse())
    if (entry.kind === 'directory') {
      await chmod(path.join(target, relative), entry.mode);
      await syncDirectory(path.join(target, relative));
    }
}
export async function removeVerifiedSource(
  source: string,
  target: string,
  expected: Inventory,
): Promise<void> {
  await assertIdentity(target, expected);
  if (await info(source)) {
    // A crash can interrupt recursive unlink. Only the journal's remaining entries may disappear.
    await assertIdentity(source, expected, true);
    await rm(source, { recursive: true });
    await syncDirectory(path.dirname(source));
  }
}
