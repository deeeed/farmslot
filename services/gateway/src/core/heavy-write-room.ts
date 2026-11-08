// core/heavy-write-room.ts — refuse heavy gateway writes that would fill the disk or land in the
// wrong place. Heavy writes are the slot-to-gateway copies (artifact mirror, session archives,
// scaffolding, review workspaces) and run-bundle materialization.
import { constants } from 'node:fs';
import { access, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { isGatewayTestProcess } from './isolated-test-path.js';
import { assertStorageVolumePresent } from './storage-volume.js';

/** Free space a heavy write leaves on its volume unless FARMSLOT_HEAVY_WRITE_FLOOR_GB says otherwise. */
export const HEAVY_WRITE_FLOOR_DEFAULT_GB = 50;

export class HeavyWriteRefusedError extends Error {}

/**
 * The floor in bytes. Gateway test processes default to none: CI runners and dev machines run the
 * suite with far less than 50 GB free.
 */
export function heavyWriteFloorBytes(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): number {
  const raw = env.FARMSLOT_HEAVY_WRITE_FLOOR_GB?.trim();
  const gb = raw ? Number(raw) : isGatewayTestProcess(env, argv) ? 0 : HEAVY_WRITE_FLOOR_DEFAULT_GB;
  return (Number.isFinite(gb) && gb >= 0 ? gb : HEAVY_WRITE_FLOOR_DEFAULT_GB) * 1e9;
}

/** Storage roots an operator configured. A missing one is never recreated somewhere else. */
function configuredRoots(env: NodeJS.ProcessEnv): Array<{ name: string; root: string }> {
  return [
    ...(env.FARMSLOT_RUNS_DIR?.trim()
      ? [{ name: 'FARMSLOT_RUNS_DIR', root: path.resolve(env.FARMSLOT_RUNS_DIR.trim()) }]
      : []),
    ...(env.FARMSLOT_HOME?.trim()
      ? [{ name: 'FARMSLOT_HOME', root: path.resolve(farmslotHome(env)) }]
      : []),
  ];
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

const isDirectory = async (dir: string) => (await stat(dir).catch(() => null))?.isDirectory();
const isWritableDirectory = async (dir: string) =>
  (await isDirectory(dir)) &&
  (await access(dir, constants.W_OK).then(
    () => true,
    () => false,
  ));

/** A separately configured heavy-data root follows the same missing-volume rule as the home. */
export async function assertHeavyWriteRootPresent(
  root: string,
  name = 'storage root',
): Promise<void> {
  try {
    assertStorageVolumePresent(root);
  } catch (error) {
    throw new HeavyWriteRefusedError((error as Error).message, { cause: error });
  }
  if (!(await isDirectory(root)) && !(await isWritableDirectory(path.dirname(root))))
    throw new HeavyWriteRefusedError(
      `Refusing to write ${root}: ${name} ${root} is missing and cannot be created in its parent (is its volume mounted?)`,
    );
}

/**
 * Refuses a write into `dir` when a configured root holding it cannot exist where it was
 * configured: the root is missing and its parent is missing or not writable. `mkdir -p` would
 * otherwise rebuild an unmounted volume's path on the internal disk; an unmounted volume's own
 * mount point sits in a root-owned directory such as /Volumes. A missing root inside an
 * existing, writable parent is created as usual.
 */
export async function assertConfiguredRootPresent(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertStorageVolumePresent(dir);
  const target = path.resolve(dir);
  for (const { name, root } of configuredRoots(env)) {
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    await assertHeavyWriteRootPresent(root, name);
  }
}

/**
 * Refuses a heavy write into `dir` when a configured root holding it cannot exist, or when its
 * volume has less free space than the floor.
 */
export async function assertHeavyWriteRoom(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  requiredBytes = 0,
): Promise<void> {
  await assertConfiguredRootPresent(dir, env);
  const target = path.resolve(dir);
  let probe = target;
  let free: number;
  for (;;) {
    try {
      const { bavail, bsize } = await statfs(probe);
      free = bavail * bsize;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(probe);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === probe) throw error;
      probe = parent;
    }
  }
  const floor = heavyWriteFloorBytes(env);
  if (free - requiredBytes < floor)
    throw new HeavyWriteRefusedError(
      `Refusing to write ${target}: its volume has ${gb(free)} GB free${requiredBytes ? ` before a ${gb(requiredBytes)} GB copy` : ''}, under the ${gb(floor)} GB floor (FARMSLOT_HEAVY_WRITE_FLOOR_GB)`,
    );
}
