import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

export interface FileIdentity {
  kind: 'file' | 'directory' | 'link';
  mode: number;
  bytes: number;
  digest: string;
}
export type Inventory = Record<string, FileIdentity>;
export async function inventory(root: string): Promise<Inventory> {
  const result: Inventory = {};
  async function visit(file: string): Promise<void> {
    const value = await lstat(file);
    const key = path.relative(root, file);
    const mode = value.mode & 0o777;
    if (value.isSymbolicLink())
      result[key] = { kind: 'link', mode, bytes: 0, digest: await readlink(file) };
    else if (value.isDirectory()) {
      result[key] = { kind: 'directory', mode, bytes: 0, digest: '' };
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name));
    } else if (value.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      result[key] = { kind: 'file', mode, bytes: value.size, digest: hash.digest('hex') };
    } else throw new Error(`Cannot fingerprint special file: ${file}`);
  }
  await visit(root);
  return result;
}
