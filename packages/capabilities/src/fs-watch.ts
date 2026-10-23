// Shared file-watch primitive (ADR-046). Native parent-directory `fs.watch`
// survives atomic file replacement and expands tilde paths. Used by the node
// (primary owner of machine-local monitoring) and by the gateway as a local
// fallback when a machine has no connected node — one implementation, two callers.

import { existsSync, type FSWatcher, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';

import type { FileWatchFailure, FileWatchUnavailable } from '@farmslot/protocol';

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

export interface FileWatchOptions {
  onUnavailable?: (observation: FileWatchUnavailable) => void;
}

/**
 * Watch a single file for content changes. `onChange` receives the file's UTF-8
 * content on every write. The parent directory remains watched so atomic file
 * replacement does not detach the watcher from subsequent updates. Returns a
 * handle the caller stops when done.
 */
export function watchFile(
  filePath: string,
  onChange: (content: string) => void,
  options: FileWatchOptions = {},
): FileWatchHandle {
  const targetPath = expandTilde(filePath);
  let watcher: FSWatcher | null = null;
  let stopped = false;
  let lastObservation: string | undefined;
  let generation = 0;

  const unavailable = (error: unknown): FileWatchUnavailable => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'deleted' };
    const failure: FileWatchFailure = {
      message: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' ? { code } : {}),
    };
    return { kind: 'error', error: failure };
  };

  const observe = async (): Promise<void> => {
    if (stopped) return;
    const current = ++generation;
    let observation: FileWatchUnavailable | { kind: 'updated'; content: string };
    try {
      observation = { kind: 'updated', content: await readFile(targetPath, 'utf-8') };
    } catch (error) {
      observation = unavailable(error);
    }
    if (stopped || current !== generation) return;
    const fingerprint = JSON.stringify(observation);
    if (fingerprint === lastObservation) return;
    lastObservation = fingerprint;
    if (observation.kind === 'updated') onChange(observation.content);
    else if (options.onUnavailable) options.onUnavailable(observation);
    else if (observation.kind === 'error') {
      // Content-only callers retain their last value; the parent watch stays armed
      // so a subsequent permission change or replacement can restore delivery.
      console.warn(`[fs.watch] read failed for ${targetPath}: ${observation.error.message}`);
    }
  };

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
    watcher = watch(dir, { persistent: false }, (_, filename) => {
      if (filename != null && filename.toString() !== target) return;
      void observe();
    });
  };

  start();

  return {
    stop(): void {
      stopped = true;
      generation++;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
