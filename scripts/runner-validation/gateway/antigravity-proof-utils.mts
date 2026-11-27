import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface CleanSourceIdentity {
  sourceSha: string;
  sourceTreeSha: string;
  trackedWorkingTreeClean: true;
}

export interface FrozenProofSession extends CleanSourceIdentity {
  isolatedCheckout: string;
  isolatedCheckoutVerifiedBeforeLaunch: true;
  verifyBeforeSeal: () => CleanSourceIdentity;
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

/**
 * Verify that `checkoutDir` is clean and matches the exact expected commit SHA and tree SHA.
 */
export function verifyFrozenProofCheckout(
  checkoutDir: string,
  expectedSha: string,
  expectedTreeSha: string,
): CleanSourceIdentity {
  const current = assertCleanTrackedSource(checkoutDir);
  if (current.sourceSha !== expectedSha) {
    throw new Error(
      `Frozen proof checkout HEAD mismatch: expected ${expectedSha}, got ${current.sourceSha}`,
    );
  }
  if (current.sourceTreeSha !== expectedTreeSha) {
    throw new Error(
      `Frozen proof checkout tree mismatch: expected ${expectedTreeSha}, got ${current.sourceTreeSha}`,
    );
  }
  return current;
}

/**
 * Prepare a detached git worktree at `sourceSha` with read-only node_modules symlink and copied
 * clean built package `dist/` artifacts so live proofs execute strictly against frozen committed
 * bytes isolated from any concurrent edits in the originating checkout.
 */
export function createFrozenProofCheckout(
  originRepoRoot: string,
  sourceSha: string,
  sourceTreeSha: string,
): { snapshotRoot: string; cleanup: () => void } {
  const snapshotRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir(), 'farmslot-frozen-proof-')),
  );
  let worktreeAdded = false;
  const cleanup = () => {
    if (worktreeAdded) {
      spawnSync('git', ['-C', originRepoRoot, 'worktree', 'remove', '--force', snapshotRoot], {
        stdio: 'ignore',
      });
    }
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  };
  try {
    execFileSync(
      'git',
      ['-C', originRepoRoot, 'worktree', 'add', '--detach', snapshotRoot, sourceSha],
      {
        stdio: 'pipe',
      },
    );
    worktreeAdded = true;
    const originNodeModules = path.join(originRepoRoot, 'node_modules');
    if (fs.existsSync(originNodeModules)) {
      fs.symlinkSync(originNodeModules, path.join(snapshotRoot, 'node_modules'), 'dir');
    }
    const packagesDir = path.join(originRepoRoot, 'packages');
    if (fs.existsSync(packagesDir)) {
      for (const pkg of fs.readdirSync(packagesDir)) {
        const distSrc = path.join(packagesDir, pkg, 'dist');
        if (fs.existsSync(distSrc)) {
          fs.cpSync(distSrc, path.join(snapshotRoot, 'packages', pkg, 'dist'), { recursive: true });
        }
      }
    }
    verifyFrozenProofCheckout(snapshotRoot, sourceSha, sourceTreeSha);
    return { snapshotRoot, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Ensure the proof runs inside an isolated detached checkout of the selected committed tree.
 * When invoked from a mutable checkout, prepares the detached worktree, re-executes the proof
 * inside it, cleans up the worktree on exit, and exits with the child's status.
 * Inside the detached checkout, verifies the tree identity before launch and returns a pre-seal
 * verifier that must succeed before writing `result.json`.
 */
export function ensureFrozenProofExecution(
  repoRoot: string,
  scriptRelPath: string,
  outputBaseArg: string | undefined,
): FrozenProofSession {
  const expectedSha = process.env.FARMSLOT_PROOF_FROZEN_SOURCE_SHA;
  const expectedTreeSha = process.env.FARMSLOT_PROOF_FROZEN_TREE_SHA;
  const expectedCheckout = process.env.FARMSLOT_PROOF_FROZEN_CHECKOUT;

  if (expectedSha && expectedTreeSha && expectedCheckout) {
    const actualRoot = fs.realpathSync(repoRoot);
    const frozenRoot = fs.realpathSync(expectedCheckout);
    if (actualRoot !== frozenRoot) {
      throw new Error(
        `Frozen proof must execute from its isolated checkout ${frozenRoot}, not ${actualRoot}`,
      );
    }
    const verified = verifyFrozenProofCheckout(actualRoot, expectedSha, expectedTreeSha);
    return {
      ...verified,
      isolatedCheckout: actualRoot,
      isolatedCheckoutVerifiedBeforeLaunch: true,
      verifyBeforeSeal: () => verifyFrozenProofCheckout(actualRoot, expectedSha, expectedTreeSha),
    };
  }

  const { sourceSha, sourceTreeSha } = assertCleanTrackedSource(repoRoot);
  const { snapshotRoot, cleanup } = createFrozenProofCheckout(repoRoot, sourceSha, sourceTreeSha);
  try {
    const childArgs = [
      '--import',
      'tsx',
      path.join(snapshotRoot, scriptRelPath),
      ...(outputBaseArg ? [path.resolve(outputBaseArg)] : []),
    ];
    const child = spawnSync(process.execPath, childArgs, {
      cwd: snapshotRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: path.join(snapshotRoot, 'services/gateway/tsconfig.json'),
        FARMSLOT_PROOF_FROZEN_SOURCE_SHA: sourceSha,
        FARMSLOT_PROOF_FROZEN_TREE_SHA: sourceTreeSha,
        FARMSLOT_PROOF_FROZEN_CHECKOUT: snapshotRoot,
      },
    });
    cleanup();
    if (child.error) throw child.error;
    process.exit(child.status ?? 1);
  } catch (error) {
    cleanup();
    throw error;
  }
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
