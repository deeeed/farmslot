import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CleanSourceIdentity {
  sourceSha: string;
  sourceTreeSha: string;
  trackedWorkingTreeClean: true;
}

export interface ModuleResolutionSpec {
  specifier: string;
  loader: 'cjs' | 'esm';
}

export interface ResolvedModuleProof {
  specifier: string;
  loader: 'cjs' | 'esm';
  resolvedPath: string;
}

export interface FrozenProofSession extends CleanSourceIdentity {
  isolatedCheckout: string;
  isolatedCheckoutVerifiedBeforeLaunch: true;
  isolatedModuleResolutionVerified: true;
  resolvedModules: ResolvedModuleProof[];
  verifyBeforeSeal: () => CleanSourceIdentity;
}

export interface ProofManifestEntry {
  file: string;
  bytes: number;
  sha256: string;
}

export interface CreateFrozenProofCheckoutOptions {
  /** Install dependencies with `--immutable` and build private workspaces inside the snapshot. Defaults to true. */
  installAndBuild?: boolean;
  /** Workspace package names to build inside the detached checkout. */
  buildWorkspaces?: readonly string[];
  /** Module specifiers verified via real subprocess CJS/ESM resolution inside the snapshot. */
  verifySpecifiers?: readonly ModuleResolutionSpec[];
}

export const FROZEN_PROOF_WORKSPACE_BUILD_TARGETS: readonly string[] = [
  '@farmslot/protocol',
  '@farmslot/agent-runtime',
  '@farmslot/recipe-runner',
  '@farmslot/adapter-rn',
  '@farmslot/review-dispatch',
];

export const DEFAULT_FROZEN_MODULE_SPECS: readonly ModuleResolutionSpec[] = [
  { specifier: '@farmslot/protocol', loader: 'cjs' },
  { specifier: '@farmslot/protocol', loader: 'esm' },
  { specifier: '@farmslot/agent-runtime/native', loader: 'esm' },
  { specifier: '@farmslot/slot-config', loader: 'esm' },
];

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
 * Verify in a real Node subprocess that workspace CommonJS `require` and ESM `import.meta.resolve`
 * (including package exports) resolve strictly to real paths inside `checkoutDir`, never escaping
 * into an originating checkout's `node_modules` or `packages` tree.
 */
export function verifyFrozenModuleResolution(
  checkoutDir: string,
  specs: readonly ModuleResolutionSpec[] = DEFAULT_FROZEN_MODULE_SPECS,
): ResolvedModuleProof[] {
  const checkoutRealRoot = fs.realpathSync(checkoutDir);
  const probeScript = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { createRequire } from 'node:module';
    import { fileURLToPath, pathToFileURL } from 'node:url';

    const checkoutRoot = fs.realpathSync(process.argv[1]);
    const specs = JSON.parse(process.argv[2]);
    const requireFromRoot = createRequire(path.join(checkoutRoot, 'package.json'));
    const parentUrl = pathToFileURL(path.join(checkoutRoot, 'package.json')).href;
    const results = [];
    for (const spec of specs) {
      let resolved;
      if (spec.loader === 'cjs') {
        resolved = requireFromRoot.resolve(spec.specifier);
      } else {
        const url = import.meta.resolve(spec.specifier, parentUrl);
        resolved = url.startsWith('file:') ? fileURLToPath(url) : url;
      }
      const real = fs.realpathSync(resolved);
      results.push({ specifier: spec.specifier, loader: spec.loader, resolvedPath: real });
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const proc = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', probeScript, checkoutRealRoot, JSON.stringify(specs)],
    {
      cwd: checkoutRealRoot,
      encoding: 'utf8',
    },
  );
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(
      `Frozen module resolution probe failed in ${checkoutRealRoot} (exit ${proc.status}):\n${proc.stderr || proc.stdout}`,
    );
  }
  const resolved = JSON.parse(proc.stdout.trim()) as ResolvedModuleProof[];
  const prefix = `${checkoutRealRoot}${path.sep}`;
  for (const entry of resolved) {
    if (!entry.resolvedPath.startsWith(prefix)) {
      throw new Error(
        `Frozen module resolution escaped detached checkout ${checkoutRealRoot}: ${entry.loader}:${entry.specifier} -> ${entry.resolvedPath}`,
      );
    }
  }
  return resolved;
}

/**
 * Remove a detached proof worktree and surface any `git worktree remove` failure instead of
 * silently leaving a stale worktree registration behind.
 */
export function removeFrozenProofCheckout(originRepoRoot: string, snapshotRoot: string): void {
  const removed = spawnSync(
    'git',
    ['-C', originRepoRoot, 'worktree', 'remove', '--force', snapshotRoot],
    {
      encoding: 'utf8',
    },
  );
  if (removed.error || removed.status !== 0) {
    const detail =
      removed.error?.message ||
      [removed.stderr, removed.stdout].filter(Boolean).join('\n').trim() ||
      `exit ${removed.status ?? removed.signal}`;
    throw new Error(
      `Failed to remove detached proof worktree ${snapshotRoot} from ${originRepoRoot}: ${detail}`,
    );
  }
  if (fs.existsSync(snapshotRoot)) {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

/**
 * Prepare a detached git worktree at `sourceSha` with its own frozen-lock dependency install
 * (`yarn install --immutable`) and locally built workspace outputs so live proofs execute strictly
 * against frozen committed bytes and never resolve workspace modules or built `dist/` files from
 * the originating checkout.
 */
export function createFrozenProofCheckout(
  originRepoRoot: string,
  sourceSha: string,
  sourceTreeSha: string,
  options: CreateFrozenProofCheckoutOptions = {},
): { snapshotRoot: string; resolvedModules: ResolvedModuleProof[]; cleanup: () => void } {
  const snapshotRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir(), 'farmslot-frozen-proof-')),
  );
  let worktreeAdded = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (worktreeAdded) {
      removeFrozenProofCheckout(originRepoRoot, snapshotRoot);
      return;
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

    let resolvedModules: ResolvedModuleProof[] = [];
    if (options.installAndBuild !== false) {
      execFileSync('yarn', ['install', '--immutable'], {
        cwd: snapshotRoot,
        stdio: 'inherit',
      });
      const workspaces = options.buildWorkspaces ?? FROZEN_PROOF_WORKSPACE_BUILD_TARGETS;
      for (const workspace of workspaces) {
        execFileSync('yarn', ['workspace', workspace, 'build'], {
          cwd: snapshotRoot,
          stdio: 'inherit',
        });
      }
      resolvedModules = verifyFrozenModuleResolution(
        snapshotRoot,
        options.verifySpecifiers ?? DEFAULT_FROZEN_MODULE_SPECS,
      );
    } else if (options.verifySpecifiers?.length) {
      resolvedModules = verifyFrozenModuleResolution(snapshotRoot, options.verifySpecifiers);
    }

    verifyFrozenProofCheckout(snapshotRoot, sourceSha, sourceTreeSha);
    return { snapshotRoot, resolvedModules, cleanup };
  } catch (error) {
    try {
      cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Frozen proof setup failed and worktree cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

/**
 * Ensure the proof runs inside an isolated detached checkout of the selected committed tree.
 * When `FARMSLOT_PROOF_FROZEN_*` env vars are already set (for example when sharing one prepared
 * detached checkout across Worker, Command Center, and Companion proofs), verifies the checkout's
 * HEAD, tree SHA, and module resolution before launch and returns a pre-seal verifier.
 * Otherwise prepares a fresh detached checkout on demand, re-executes the proof inside it, cleans
 * up on completion or signal, and reports any cleanup failure.
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
    const resolvedModules = verifyFrozenModuleResolution(actualRoot);
    return {
      ...verified,
      isolatedCheckout: actualRoot,
      isolatedCheckoutVerifiedBeforeLaunch: true,
      isolatedModuleResolutionVerified: true,
      resolvedModules,
      verifyBeforeSeal: () => verifyFrozenProofCheckout(actualRoot, expectedSha, expectedTreeSha),
    };
  }

  const { sourceSha, sourceTreeSha } = assertCleanTrackedSource(repoRoot);
  const { snapshotRoot, cleanup } = createFrozenProofCheckout(repoRoot, sourceSha, sourceTreeSha);
  const onSignal = (signal: NodeJS.Signals) => {
    try {
      cleanup();
    } finally {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
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
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    cleanup();
    if (child.error) throw child.error;
    process.exit(child.status ?? 1);
  } catch (error) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    try {
      cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Frozen proof execution failed and worktree cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, originArg, targetArg] = process.argv.slice(2);
  if (command === 'prepare') {
    const originRoot = path.resolve(originArg ?? process.cwd());
    const { sourceSha, sourceTreeSha } = assertCleanTrackedSource(originRoot);
    const prepared = createFrozenProofCheckout(originRoot, sourceSha, sourceTreeSha);
    process.stdout.write(
      `${JSON.stringify(
        {
          originRepoRoot: originRoot,
          snapshotRoot: prepared.snapshotRoot,
          sourceSha,
          sourceTreeSha,
          resolvedModules: prepared.resolvedModules,
        },
        null,
        2,
      )}\n`,
    );
  } else if (command === 'verify') {
    const checkoutRoot = path.resolve(originArg ?? process.cwd());
    const expectedSha = process.env.FARMSLOT_PROOF_FROZEN_SOURCE_SHA;
    const expectedTreeSha = process.env.FARMSLOT_PROOF_FROZEN_TREE_SHA;
    if (!expectedSha || !expectedTreeSha) {
      throw new Error(
        'FARMSLOT_PROOF_FROZEN_SOURCE_SHA and FARMSLOT_PROOF_FROZEN_TREE_SHA are required for verify',
      );
    }
    const verified = verifyFrozenProofCheckout(checkoutRoot, expectedSha, expectedTreeSha);
    const resolvedModules = verifyFrozenModuleResolution(checkoutRoot);
    process.stdout.write(
      `${JSON.stringify(
        {
          ...verified,
          isolatedCheckout: fs.realpathSync(checkoutRoot),
          isolatedModuleResolutionVerified: true,
          resolvedModules,
        },
        null,
        2,
      )}\n`,
    );
  } else if (command === 'cleanup') {
    if (!originArg || !targetArg) {
      throw new Error('Usage: antigravity-proof-utils.mts cleanup <originRepoRoot> <snapshotRoot>');
    }
    removeFrozenProofCheckout(path.resolve(originArg), path.resolve(targetArg));
    process.stdout.write(`${JSON.stringify({ removed: path.resolve(targetArg) })}\n`);
  } else {
    throw new Error('Usage: antigravity-proof-utils.mts <prepare|verify|cleanup> ...');
  }
}
