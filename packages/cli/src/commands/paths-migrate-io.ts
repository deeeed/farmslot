import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  statfs,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export {
  type FileIdentity,
  type Inventory,
  inventory,
} from '@farmslot/protocol/node/tree-fingerprint';
import { type Inventory, inventory } from '@farmslot/protocol/node/tree-fingerprint';

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
/** Cross-volume links must stay inside this move, including through chained links. */
export function assertContainedLinks(source: string, expected: Inventory): void {
  for (const [relative, entry] of Object.entries(expected)) {
    if (entry.kind !== 'link') continue;
    let parts = path
      .relative(source, path.dirname(path.join(source, relative)))
      .split(path.sep)
      .filter(Boolean);
    let pending = entry.digest.split(path.sep);
    let hops = 0;
    if (path.isAbsolute(entry.digest)) {
      if (!within(source, path.resolve(entry.digest)))
        throw new Error(`Cross-volume symlink points outside moved tree: ${source}/${relative}`);
      parts = [];
      pending = path.relative(source, entry.digest).split(path.sep);
    }
    while (pending.length) {
      const part = pending.shift()!;
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length)
          throw new Error(`Cross-volume symlink points outside moved tree: ${source}/${relative}`);
        parts.pop();
      } else {
        parts.push(part);
        const linked = expected[parts.join(path.sep)];
        if (linked?.kind === 'link') {
          if (++hops > 40)
            throw new Error(
              `Cross-volume symlink points outside moved tree or cycles: ${source}/${relative}`,
            );
          parts.pop();
          let target = linked.digest;
          if (path.isAbsolute(target)) {
            if (!within(source, path.resolve(target)))
              throw new Error(
                `Cross-volume symlink points outside moved tree: ${source}/${relative}`,
              );
            parts = [];
            target = path.relative(source, target);
          }
          pending = [...target.split(path.sep), ...pending];
        }
      }
    }
  }
}

/** Preserve links literally. The caller validates them against the original move root. */
export async function copyTree(source: string, target: string, expected: Inventory): Promise<void> {
  for (const [relative, entry] of Object.entries(expected)) {
    const to = path.join(target, relative);
    await assertUnredirected(entry.kind === 'link' ? path.dirname(to) : to);
    if (entry.kind === 'directory') {
      await mkdir(to, { recursive: true, mode: entry.mode | 0o700 });
      await chmod(to, entry.mode | 0o700);
    } else if (entry.kind === 'link') {
      await mkdir(path.dirname(to), { recursive: true });
      if (await info(to)) {
        if (!(await info(to))?.isSymbolicLink() || (await readlink(to)) !== entry.digest)
          throw new Error(`Migration link changed: ${to}`);
      } else await symlink(entry.digest, to);
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
