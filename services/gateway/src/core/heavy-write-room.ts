// core/heavy-write-room.ts — refuse heavy gateway writes that would fill the disk or land in the
// wrong place. Heavy writes are the slot-to-gateway copies (artifact mirror, session archives,
// scaffolding, review workspaces) and run-bundle materialization.
import { stat, statfs } from 'node:fs/promises';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { isGatewayTestProcess } from './isolated-test-path.js';

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

/**
 * Refuses a write into `dir` when a configured root holding it cannot exist where it was
 * configured: the root is missing and so is its parent. `mkdir -p` would otherwise rebuild an
 * unmounted volume's path on the internal disk. A missing root inside an existing parent is
 * created as usual.
 */
export async function assertConfiguredRootPresent(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const target = path.resolve(dir);
  for (const { name, root } of configuredRoots(env)) {
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    if (!(await isDirectory(root)) && !(await isDirectory(path.dirname(root))))
      throw new HeavyWriteRefusedError(
        `Refusing to write ${target}: ${name} ${root} is missing and so is its parent (is its volume mounted?)`,
      );
  }
}

/**
 * Refuses a heavy write into `dir` when a configured root holding it cannot exist, or when its
 * volume has less free space than the floor.
 */
export async function assertHeavyWriteRoom(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
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
  if (free < floor)
    throw new HeavyWriteRefusedError(
      `Refusing to write ${target}: its volume has ${gb(free)} GB free, under the ${gb(floor)} GB floor (FARMSLOT_HEAVY_WRITE_FLOOR_GB)`,
    );
}
