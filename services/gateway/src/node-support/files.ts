import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface NodeSupportFile {
  relativePath: string;
  contentBase64: string;
  sha256: string;
  mode: number;
  size: number;
}

export async function collectSupportFiles(
  sourcePath: string,
  relativeDest: string,
): Promise<NodeSupportFile[]> {
  const st = await lstat(sourcePath);
  if (st.isSymbolicLink()) {
    throw new Error(`Node support refuses symlinked path ${sourcePath}`);
  }

  if (st.isDirectory()) {
    const files: NodeSupportFile[] = [];
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      files.push(
        ...(await collectSupportFiles(
          path.join(sourcePath, entry.name),
          path.join(relativeDest, entry.name),
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
