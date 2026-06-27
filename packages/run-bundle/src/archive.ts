import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function resolveTool(name: string, extraPaths: string[]): string {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(':').filter(Boolean)) {
    const candidate = path.join(dir, name);
    const probe = spawnSync(candidate, name === 'zstd' ? ['--version'] : ['--version'], {
      stdio: 'ignore',
    });
    if (probe.status === 0) return candidate;
  }
  for (const candidate of extraPaths.map((entry) => path.join(entry, name)).concat(name)) {
    const probe = spawnSync(candidate, name === 'zstd' ? ['--version'] : ['--version'], {
      stdio: 'ignore',
    });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    `${name} is required for farmrun bundles — install it (e.g. brew install zstd) and retry`,
  );
}

export function packFarmrunDirectory(sourceDir: string, outputPath: string): void {
  const zstd = resolveTool('zstd', ['/opt/homebrew/bin', '/usr/local/bin']);
  const tar = resolveTool('tar', ['/usr/bin']);
  const tmpTar = `${path.resolve(outputPath)}.tar.tmp`;
  mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const tarResult = spawnSync(tar, ['-cf', tmpTar, '-C', sourceDir, '.'], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (tarResult.status !== 0) {
    throw new Error(`tar pack failed: ${tarResult.stderr || tarResult.stdout || 'unknown error'}`);
  }
  const zstdResult = spawnSync(zstd, ['-T0', '-q', '-f', '-o', outputPath, tmpTar], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  rmSync(tmpTar, { force: true });
  if (zstdResult.status !== 0) {
    throw new Error(`zstd pack failed: ${zstdResult.stderr || zstdResult.stdout || 'unknown error'}`);
  }
}

export function unpackFarmrunArchive(bundlePath: string): string {
  const zstd = resolveTool('zstd', ['/opt/homebrew/bin', '/usr/local/bin']);
  const tar = resolveTool('tar', ['/usr/bin']);
  const resolved = path.resolve(bundlePath);
  if (!existsSync(resolved)) throw new Error(`Bundle not found: ${resolved}`);
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'farmrun-unpack-'));
  const tmpTar = path.join(tempRoot, 'archive.tar');
  const zstdResult = spawnSync(zstd, ['-d', '-q', '-f', '-o', tmpTar, resolved], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (zstdResult.status !== 0) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`zstd unpack failed: ${zstdResult.stderr || zstdResult.stdout || 'unknown error'}`);
  }
  const extractDir = path.join(tempRoot, 'root');
  mkdirSync(extractDir, { recursive: true });
  const tarResult = spawnSync(tar, ['-xf', tmpTar, '-C', extractDir], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  rmSync(tmpTar, { force: true });
  if (tarResult.status !== 0) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`tar unpack failed: ${tarResult.stderr || tarResult.stdout || 'unknown error'}`);
  }
  return extractDir;
}

export function readBundleManifestFromDir(bundleDir: string): string {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Invalid farmrun bundle: missing manifest.json`);
  return readFileSync(manifestPath, 'utf-8');
}

export function writeBundleManifest(bundleDir: string, manifestJson: string): void {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  writeFileSync(manifestPath, manifestJson, 'utf-8');
  chmodSync(manifestPath, 0o600);
}