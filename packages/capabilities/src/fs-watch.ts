// Shared file-watch primitive (ADR-046). Native `fs.watch` with the parent-dir
// "watch until the file appears" fallback and tilde expansion. Used by the node
// (primary owner of machine-local monitoring) and by the gateway as a local
// fallback when a machine has no connected node — one implementation, two callers.

import { existsSync, type FSWatcher, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';

// Pool configs can declare repos as `~/...`. `~` is a shell token, not a
// filesystem prefix — node:fs treats it literally. Expand to $HOME first.
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}/${p.slice(2)}`;
  return p;
}

export interface FileWatchHandle {
  stop(): void;
}

/**
 * Watch a single file for content changes. `onChange` receives the file's UTF-8
 * content on every write. If the file does not exist yet, its parent directory is
 * watched until the file appears, then the watch switches to the file directly.
 * Returns a handle the caller stops when done.
 */
export function watchFile(filePath: string, onChange: (content: string) => void): FileWatchHandle {
  const targetPath = expandTilde(filePath);
  let watcher: FSWatcher | null = null;
  let stopped = false;

  const start = (): void => {
    if (stopped) return;
    if (existsSync(targetPath)) {
      // File exists — watch it directly.
      watcher = watch(targetPath, { persistent: false }, async () => {
        try {
          const content = await readFile(targetPath, 'utf-8');
          onChange(content);
        } catch {
          /* file may be mid-write */
        }
      });
    } else {
      // File doesn't exist yet — watch the parent directory for its creation.
      const dir = dirname(targetPath);
      if (!existsSync(dir)) {
        console.log(`[fs.watch] parent dir doesn't exist: ${dir} — skipping watch`);
        return;
      }
      const target = basename(targetPath);
      watcher = watch(dir, { persistent: false }, async (_, filename) => {
        if (filename !== target) return;
        if (!existsSync(targetPath)) return;
        // File appeared — read, notify, then switch to watching it directly.
        try {
          const content = await readFile(targetPath, 'utf-8');
          onChange(content);
        } catch {
          /* file may be mid-write */
        }
        if (watcher) watcher.close();
        watcher = null;
        start();
      });
    }
  };

  start();

  return {
    stop(): void {
      stopped = true;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
