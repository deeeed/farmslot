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
 * content on every write. The parent directory remains watched so atomic file
 * replacement does not detach the watcher from subsequent updates. Returns a
 * handle the caller stops when done.
 */
export function watchFile(filePath: string, onChange: (content: string) => void): FileWatchHandle {
  const targetPath = expandTilde(filePath);
  let watcher: FSWatcher | null = null;
  let stopped = false;
  let lastContent: string | null = null;

  const start = (): void => {
    if (stopped) return;
    // Watch the parent directory even when the file already exists. Checklist markers,
    // git, and many editors update files through atomic rename; watching the file inode
    // sees the first replacement and then silently follows the orphaned inode.
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      console.log(`[fs.watch] parent dir doesn't exist: ${dir} — skipping watch`);
      return;
    }
    const target = basename(targetPath);
    watcher = watch(dir, { persistent: false }, async (_, filename) => {
      if (filename != null && filename.toString() !== target) return;
      if (!existsSync(targetPath)) return;
      try {
        const content = await readFile(targetPath, 'utf-8');
        if (content === lastContent) return;
        lastContent = content;
        onChange(content);
      } catch (err) {
        // Atomic replacement can briefly remove the target between the directory
        // event and the read. The following event will read the replacement.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(`[fs.watch] read failed for ${targetPath}: ${(err as Error).message}`);
        }
      }
    });
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
