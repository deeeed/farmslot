import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { lstatSync, readlinkSync, realpathSync, statSync, unwatchFile, watchFile } from 'node:fs';
import path from 'node:path';

import { expandTilde } from '@farmslot/capabilities/fs-watch';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import { resolveRunsDir, runBundleRetentionSettings } from '@farmslot/run-bundle';
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

function storageVolumeRoot(
  target: string,
  volumesRoot = process.platform === 'darwin' ? '/Volumes' : undefined,
): string | undefined {
  if (!volumesRoot) return undefined;
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
  return path.join(volumeRoot, relative.split(path.sep)[0]);
}

/** macOS mounts external volumes under /Volumes. A leftover directory is not a mounted disk. */
export function storageVolumeError(target: string, volumesRoot?: string): string | undefined {
  try {
    const volume = storageVolumeRoot(target, volumesRoot);
    if (!volume) return undefined;
    const mounted = statSync(volume, { throwIfNoEntry: false });
    if (mounted?.isDirectory() && mounted.dev !== statSync(path.dirname(volume)).dev)
      return undefined;
    return `Storage unavailable: ${volume} is not mounted. Reconnect the volume before using ${target}.`;
  } catch (error) {
    return `Storage unavailable: ${target}: ${error instanceof Error ? error.message : String(error)}. Reconnect or repair its volume.`;
  }
}

export interface StorageVolumeWatch {
  refresh(targets: Iterable<string>): void;
  close(): void;
}

/** FSEvents omits some mount changes. One metadata watcher per volume survives unmount/replug. */
export function watchStorageVolumes(
  targets: Iterable<string>,
  changed: () => void,
): StorageVolumeWatch {
  const listeners = new Map<string, () => void>();
  const refresh = (targets: Iterable<string>): void => {
    const roots = new Set(
      [...targets].flatMap((target) => {
        const root = storageVolumeRoot(target);
        return root ? [root] : [];
      }),
    );
    for (const [root, listener] of listeners)
      if (!roots.has(root)) {
        unwatchFile(root, listener);
        listeners.delete(root);
      }
    for (const root of roots)
      if (!listeners.has(root)) {
        const listener = () => changed();
        watchFile(root, { interval: 1000, persistent: false }, listener);
        listeners.set(root, listener);
      }
  };
  refresh(targets);
  return {
    refresh,
    close() {
      for (const [root, listener] of listeners) unwatchFile(root, listener);
      listeners.clear();
    },
  };
}

export function assertStorageVolumePresent(target: string, volumesRoot?: string): void {
  const error = storageVolumeError(target, volumesRoot);
  if (error) throw new Error(error);
}

/** The existing gateway store owners use these same configured roots. */
export function gatewayStorageRoots(): string[] {
  const home = farmslotHome();
  return [
    home,
    runBundleRetentionSettings(home).storeRoot ?? currentFarmPaths('gateway').data.runBundles,
    resolveRunsDir(farmslotRoot),
    currentFarmPaths('gateway').data.runArchive,
  ];
}

export function gatewayStorageVolumeErrors(): string[] {
  return gatewayStorageRoots().flatMap((root) => {
    const error = storageVolumeError(root);
    return error ? [error] : [];
  });
}
