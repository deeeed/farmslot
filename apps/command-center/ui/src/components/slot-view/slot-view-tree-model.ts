import type { FileEntry } from '../workspace/file-tree.js';

export function updateSlotViewTreeChildren(
  entries: FileEntry[],
  targetPath: string,
  children: FileEntry[],
): FileEntry[] {
  if (targetPath === '.') return children;
  return entries.map((entry) => {
    if (entry.path === targetPath) {
      return { ...entry, children };
    }
    if (entry.children && targetPath.startsWith(entry.path + '/')) {
      return {
        ...entry,
        children: updateSlotViewTreeChildren(entry.children, targetPath, children),
      };
    }
    return entry;
  });
}
