import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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
