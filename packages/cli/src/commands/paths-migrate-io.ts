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
import {
  type FileIdentity,
  type Inventory,
  inventory,
} from '@farmslot/protocol/node/tree-fingerprint';

import type { MoveStep } from './paths-migrate-plan.js';

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
type LinkEntry = Pick<FileIdentity, 'kind' | 'digest'>;
type LinkLookup = (file: string) => Promise<LinkEntry | undefined>;

async function filesystemEntry(file: string): Promise<LinkEntry | undefined> {
  const value = await info(file);
  if (!value) return undefined;
  return {
    kind: value.isSymbolicLink() ? 'link' : value.isDirectory() ? 'directory' : 'file',
    digest: value.isSymbolicLink() ? await readlink(file) : '',
  };
}

/** Walk before normalizing: a symlink followed by /.. traverses its real parent. */
async function resolveLink(link: string, lookup: LinkLookup): Promise<string> {
  const components = (target: string) =>
    target
      .split(path.sep)
      .filter(Boolean)
      .concat(target.endsWith(path.sep) ? ['.'] : []);
  let pending = components(link);
  let resolved = path.parse(link).root;
  let hops = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === '.') continue;
    if (part === '..') {
      resolved = path.dirname(resolved);
      continue;
    }
    const file = path.join(resolved, part);
    const value = await lookup(file);
    if (!value) throw new Error(`Migration symlink would dangle: ${link} -> ${file}`);
    if (value.kind === 'link') {
      if (++hops > 40) throw new Error(`Migration symlink cycles: ${link}`);
      if (path.isAbsolute(value.digest)) resolved = path.parse(value.digest).root;
      pending = [...components(value.digest), ...pending];
    } else {
      if (pending.length && value.kind !== 'directory')
        throw new Error(`Migration symlink traverses a file: ${link}`);
      resolved = file;
    }
  }
  return resolved;
}

/** The journal's original inventory also resolves links during resume and rollback. */
function originalLookup(steps: Pick<MoveStep, 'source' | 'expected'>[]): LinkLookup {
  return async (file) => {
    const source = steps.find((step) => within(step.source, file));
    if (source) return source.expected[path.relative(source.source, file)];
    if (steps.some((step) => within(file, step.source))) return { kind: 'directory', digest: '' };
    return filesystemEntry(file);
  };
}

/** The journal keeps original link text; only the destination inventory is translated. */
export async function movedInventory(
  step: Pick<MoveStep, 'source' | 'target' | 'expected'>,
): Promise<Inventory> {
  const result = { ...step.expected };
  const lookup = originalLookup([step]);
  for (const [relative, entry] of Object.entries(result)) {
    if (entry.kind !== 'link' || !path.isAbsolute(entry.digest)) continue;
    const target = await resolveLink(entry.digest, lookup);
    if (within(step.source, target))
      result[relative] = {
        ...entry,
        digest: path.join(step.target, path.relative(step.source, target)),
      };
  }
  return result;
}

/** Resolve both trees and refuse any link whose real target changes during the move. */
export async function assertMigratedLinks(steps: MoveStep[]): Promise<void> {
  const destinations = await Promise.all(
    steps.map(async (step) => ({ ...step, inventory: await movedInventory(step) })),
  );
  const before = originalLookup(steps);
  const after: LinkLookup = async (file) => {
    const destination = destinations.find((step) => within(step.target, file));
    if (destination) return destination.inventory[path.relative(destination.target, file)];
    if (steps.some((step) => within(step.source, file))) return undefined;
    // The migration creates these parents before installing any tree.
    if (steps.some((step) => within(file, step.target))) return { kind: 'directory', digest: '' };
    return filesystemEntry(file);
  };
  for (const step of destinations)
    for (const [relative, entry] of Object.entries(step.inventory)) {
      if (entry.kind !== 'link') continue;
      const original = await resolveLink(path.join(step.source, relative), before);
      const owner = steps.find((move) => within(move.source, original));
      const expected = owner
        ? path.join(owner.target, path.relative(owner.source, original))
        : original;
      const link = path.join(step.target, relative);
      if ((await resolveLink(link, after)) !== expected)
        throw new Error(`Migration symlink target would change: ${link}`);
    }
}

/** Copy files from source and install the supplied destination link text. */
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
  targetExpected = expected,
): Promise<void> {
  await assertIdentity(target, targetExpected);
  if (await info(source)) {
    // A crash can interrupt recursive unlink. Only the journal's remaining entries may disappear.
    await assertIdentity(source, expected, true);
    await rm(source, { recursive: true });
    await syncDirectory(path.dirname(source));
  }
}
