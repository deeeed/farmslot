import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface NodeSupportFile {
  relativePath: string;
  contentBase64: string;
  sha256: string;
  mode: number;
  size: number;
}

/**
 * Read a support tree as plain files. A symlink inside it is materialized as
 * its target's content (a linked directory is walked like a directory), so the
 * copy runs the same as the checkout as long as the link and its target share a
 * directory (recipe libraries link `x.mjs -> x.ts`). A link that dangles,
 * escapes the tree's real root, or loops back onto its own ancestor is refused.
 */
export async function collectSupportFiles(
  sourcePath: string,
  relativeDest: string,
): Promise<NodeSupportFile[]> {
  if ((await lstat(sourcePath)).isSymbolicLink()) {
    throw new Error(`Node support refuses symlinked path ${sourcePath}`);
  }
  const rootRealPath = await realpath(sourcePath);
  return collectEntry(sourcePath, relativeDest, rootRealPath, []);
}

async function collectEntry(
  sourcePath: string,
  relativeDest: string,
  rootRealPath: string,
  /** Real paths of the directories above sourcePath, outermost first. */
  ancestors: string[],
): Promise<NodeSupportFile[]> {
  let st = await lstat(sourcePath);
  let realPath = ancestors.length
    ? path.join(ancestors.at(-1)!, path.basename(sourcePath))
    : rootRealPath;
  if (st.isSymbolicLink()) {
    try {
      realPath = await realpath(sourcePath);
    } catch (error) {
      throw new Error(
        `Node support refuses symlink ${sourcePath}: its target does not resolve (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
      );
    }
    const relative = path.relative(rootRealPath, realPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(
        `Node support refuses symlink ${sourcePath}: it resolves to ${realPath}, outside ${rootRealPath}`,
      );
    }
    st = await stat(realPath);
  }

  if (st.isDirectory()) {
    if (ancestors.includes(realPath)) {
      throw new Error(`Node support refuses symlink ${sourcePath}: it loops back to ${realPath}`);
    }
    const files: NodeSupportFile[] = [];
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      files.push(
        ...(await collectEntry(
          path.join(sourcePath, entry.name),
          path.join(relativeDest, entry.name),
          rootRealPath,
          [...ancestors, realPath],
        )),
      );
    }
    return files;
  }

  if (!st.isFile()) return [];
  const content = await readFile(sourcePath);
  return [
    {
      relativePath: relativeDest,
      contentBase64: content.toString('base64'),
      sha256: createHash('sha256').update(content).digest('hex'),
      mode: st.mode & 0o777,
      size: content.length,
    },
  ];
}

export function supportHash(
  files: Array<Pick<NodeSupportFile, 'relativePath' | 'contentBase64' | 'mode'>>,
): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.mode.toString(8));
    hash.update('\0');
    hash.update(Buffer.from(file.contentBase64, 'base64'));
    hash.update('\0');
  }
  return hash.digest('hex');
}
