import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface CleanSourceIdentity {
  sourceSha: string;
  sourceTreeSha: string;
  trackedWorkingTreeClean: true;
}

export interface ProofManifestEntry {
  file: string;
  bytes: number;
  sha256: string;
}

/**
 * Refuse to bind a proof receipt to a committed SHA when tracked files have uncommitted edits.
 * Untracked scratch/output files do not invalidate tracked source identity.
 */
export function assertCleanTrackedSource(repoRoot: string): CleanSourceIdentity {
  const dirty = execFileSync(
    'git',
    ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no'],
    {
      encoding: 'utf8',
    },
  ).trim();
  if (dirty) {
    throw new Error(`Refusing to run exact-head proof with dirty tracked working tree:\n${dirty}`);
  }
  const sourceSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const sourceTreeSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8',
  }).trim();
  return { sourceSha, sourceTreeSha, trackedWorkingTreeClean: true };
}

/** Create a unique per-attempt output directory under `baseDir` so runs never mix files. */
export async function createAttemptOutputDir(
  baseDir: string,
  sourceSha: string,
): Promise<{ attemptId: string; outputDir: string }> {
  const attemptId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sourceSha.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const outputDir = path.join(baseDir, `attempt-${attemptId}`);
  await mkdir(outputDir, { recursive: true });
  return { attemptId, outputDir };
}

/** Build a sorted sha256 manifest of every file written into `outputDir` (excluding `result.json`). */
export async function buildProofManifest(
  outputDir: string,
  excludeFiles: readonly string[] = ['result.json'],
): Promise<ProofManifestEntry[]> {
  const excluded = new Set(excludeFiles);
  return Promise.all(
    (await readdir(outputDir))
      .filter((name) => !excluded.has(name))
      .sort()
      .map(async (file) => {
        const full = path.join(outputDir, file);
        const bytes = await readFile(full);
        const info = await stat(full);
        return {
          file,
          bytes: info.size,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        };
      }),
  );
}
