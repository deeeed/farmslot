import { execFile as execFileCallback } from 'node:child_process';
import { type FSWatcher, watch } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { expandTilde } from './fs-watch.js';
interface GitDiscovery {
  code: number;
  stdout: string;
  stderr: string;
}
function discoverGit(cwd: string): Promise<GitDiscovery> {
  return new Promise((resolve, reject) =>
    execFileCallback(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      {
        cwd,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
      },
      (error, stdout, stderr) => {
        // Numeric exit is Git-domain status. Spawn, timeout and signal failures are not plain directories.
        if (error && (typeof error.code !== 'number' || error.killed || error.signal))
          reject(error);
        else resolve({ code: (error?.code as number) ?? 0, stdout, stderr });
      },
    ),
  );
}

/** Arm all workspace bytes, names, index and refs. No periodic rereads or following symlinks. */
export async function armLocalWorkspace(
  root: string,
  changed: () => void,
  failed: (error: Error) => void,
): Promise<() => void> {
  const watchers: FSWatcher[] = [];
  let stopped = false;
  const close = () => {
    stopped = true;
    for (const watcher of watchers) watcher.close();
  };
  const fail = (error: Error) => {
    if (!stopped) {
      close();
      failed(error);
    }
  };
  const actualRoot = await realpath(expandTilde(root));
  // Root watch is armed before discovering git metadata so a concurrent checkout is fenced.
  const add = async (target: string) => {
    const initial = await lstat(target);
    const watcher = watch(target, { recursive: true, persistent: false }, (_, filename) => {
      if (stopped) return;
      if (target === actualRoot && filename?.toString() === '.git') {
        fail(new Error('Workspace git binding changed; retry to rearm'));
        return;
      }
      changed();
    });
    watcher.on('error', fail);
    watchers.push(watcher);
    // Roots and linked metadata can be atomically removed/replaced. Watching an old inode is insufficient.
    const parent = watch(path.dirname(target), { persistent: false }, async (_, filename) => {
      if (filename != null && filename.toString() !== path.basename(target)) return;
      try {
        const current = await lstat(target);
        if (current.ino !== initial.ino || current.dev !== initial.dev)
          fail(new Error('Workspace source root replaced'));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    parent.on('error', fail);
    watchers.push(parent);
  };
  try {
    await add(actualRoot);
    const discovery = await discoverGit(actualRoot);
    if (discovery.code === 0) {
      for (const metadata of new Set(discovery.stdout.trim().split('\n'))) {
        const target = await realpath(metadata);
        const relative = path.relative(actualRoot, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) await add(target);
      }
    } else if (discovery.code !== 128 || !discovery.stderr.includes('not a git repository')) {
      throw new Error(`Git metadata discovery failed (${discovery.code}): ${discovery.stderr}`);
    }
    // Exit 128 with Git's specific diagnostic admits a plain directory, never runner state.
    if (stopped) throw new Error('Workspace source failed while arming');
    return close;
  } catch (error) {
    close();
    throw error;
  }
}
