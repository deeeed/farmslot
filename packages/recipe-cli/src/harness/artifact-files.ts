import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ArtifactManifestEntry {
  category?: string;
  label: string;
  path: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export async function writeContainedArtifact(
  artifactsDir: string,
  relativePath: string,
  value: string | Uint8Array,
  label: string,
): Promise<void> {
  const file = resolveContainedArtifact(artifactsDir, relativePath, label);
  await mkdir(path.dirname(file), { recursive: true });
  await assertContainedParent(artifactsDir, file, label);
  await assertNotSymlink(file, label);
  const handle = await open(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(value);
  } finally {
    await handle.close();
  }
}

export async function readContainedJsonArtifact<T>(
  artifactsDir: string,
  relativePath: string,
  maxBytes: number,
  label: string,
): Promise<T> {
  const file = resolveContainedArtifact(artifactsDir, relativePath, label);
  await assertContainedParent(artifactsDir, file, label);
  await assertNotSymlink(file, label);
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error(`${label} is not a bounded regular file.`);
    }
    return JSON.parse(await handle.readFile('utf8')) as T;
  } finally {
    await handle.close();
  }
}

export async function indexArtifactManifest(
  manifestPath: string,
  entries: readonly ArtifactManifestEntry[],
): Promise<void> {
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const manifest = asRecord(parsed);
  const replacementPaths = new Set(entries.map((entry) => entry.path));
  const current = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.filter(
        (artifact) => !replacementPaths.has(String(asRecord(artifact).path ?? '')),
      )
    : [];
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, artifacts: [...current, ...entries] }, null, 2)}\n`,
  );
}

function resolveContainedArtifact(
  artifactsDir: string,
  relativePath: string,
  label: string,
): string {
  const root = path.resolve(artifactsDir);
  const file = path.resolve(root, relativePath);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} path must stay inside artifactsDir.`);
  }
  return file;
}

async function assertContainedParent(
  artifactsDir: string,
  file: string,
  label: string,
): Promise<void> {
  const root = await realpath(artifactsDir);
  const parent = await realpath(path.dirname(file));
  const relative = path.relative(root, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} parent must stay inside artifactsDir.`);
  }
}

async function assertNotSymlink(file: string, label: string): Promise<void> {
  try {
    if ((await lstat(file)).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
