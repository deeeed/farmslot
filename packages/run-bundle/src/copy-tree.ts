import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { RunBundleEntryMeta } from '@farmslot/protocol';

import { sha256File } from './hashing.js';
import { assertSafeBundleRelativePath } from './safe-paths.js';

const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

export function copyDirectoryRecursive(sourceDir: string, destDir: string): void {
  if (!existsSync(sourceDir)) return;
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const sourcePath = path.join(sourceDir, entry);
    const destPath = path.join(destDir, entry);
    const stats = statSync(sourcePath);
    if (stats.isDirectory()) {
      copyDirectoryRecursive(sourcePath, destPath);
      continue;
    }
    if (!stats.isFile()) continue;
    mkdirSync(path.dirname(destPath), { recursive: true });
    cpSync(sourcePath, destPath);
  }
}

/** Register every file under a bundle subtree in manifest.entries for hash verification on import. */
export function registerDirectoryEntries(
  bundleDir: string,
  relativeDir: string,
  entries: Record<string, RunBundleEntryMeta>,
): void {
  const bundleRoot = path.resolve(bundleDir);
  const sourceRoot = path.join(bundleRoot, relativeDir);
  if (!existsSync(sourceRoot)) return;

  const walk = (currentDir: string): void => {
    for (const entry of readdirSync(currentDir)) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      const sourcePath = path.join(currentDir, entry);
      const stats = statSync(sourcePath);
      if (stats.isDirectory()) {
        walk(sourcePath);
        continue;
      }
      if (!stats.isFile()) continue;
      const relative = path.relative(bundleRoot, sourcePath).replace(/\\/g, '/');
      assertSafeBundleRelativePath(relative);
      entries[relative] = {
        sha256: sha256File(sourcePath),
        bytes: stats.size,
        path: relative,
      };
    }
  };
  walk(sourceRoot);
}
