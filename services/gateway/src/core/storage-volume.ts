import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { expandTilde } from '@farmslot/capabilities/fs-watch';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import { resolveRunsDir } from '@farmslot/run-bundle';
import { farmslotRoot } from '@farmslot/slot-config';

/** Resolve existing ancestors and dangling links without creating a replacement store. */
function storagePath(target: string, links = 0): string {
  if (links > 40) throw new Error(`Too many storage symlinks: ${target}`);
  try {
    return realpathSync(target);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink())
      return storagePath(path.resolve(path.dirname(target), readlinkSync(target)), links + 1);
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(storagePath(parent, links), path.basename(target));
  }
}

/** macOS mounts external volumes under /Volumes. A leftover directory is not a mounted disk. */
export function storageVolumeError(
  target: string,
  volumesRoot = process.platform === 'darwin' ? '/Volumes' : undefined,
): string | undefined {
  if (!volumesRoot) return undefined;
  try {
    const volumeRoot = realpathSync(volumesRoot);
    const resolved = storagePath(path.resolve(expandTilde(target)));
    const relative = path.relative(volumeRoot, resolved);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !relative
    )
      return undefined;
    const volume = path.join(volumeRoot, relative.split(path.sep)[0]);
    const mounted = statSync(volume, { throwIfNoEntry: false });
    if (mounted?.isDirectory() && mounted.dev !== statSync(volumeRoot).dev) return undefined;
    return `Storage unavailable: ${volume} is not mounted. Reconnect the volume before using ${target}.`;
  } catch (error) {
    return `Storage unavailable: ${target}: ${error instanceof Error ? error.message : String(error)}. Reconnect or repair its volume.`;
  }
}

export function assertStorageVolumePresent(target: string, volumesRoot?: string): void {
  const error = storageVolumeError(target, volumesRoot);
  if (error) throw new Error(error);
}

/** The existing gateway store owners use these same configured roots. */
export function gatewayStorageVolumeErrors(): string[] {
  const home = farmslotHome();
  return [
    home,
    path.join(home, 'run-bundles'),
    resolveRunsDir(farmslotRoot),
    process.env.FARMSLOT_RUN_ARCHIVE_ROOT ?? path.join(home, 'run-archive'),
  ].flatMap((root) => {
    const error = storageVolumeError(root);
    return error ? [error] : [];
  });
}
