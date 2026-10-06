// Live adapter scripts import a checkout's workspace packages as runtime values.
// Their package "exports" point at dist/, which an unbuilt checkout lacks and a
// built one may hold from an older source or build layout. A generated tsconfig
// paths map points tsx at each package's src instead, so a script always runs the
// checkout's current code, without building or modifying the checkout.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pnpNodeOptions } from './dependencies.js';

/** Package name → its directory, relative to the checkout root. */
export type WorkspacePackageMap = Readonly<Record<string, string>>;

/** A fixed map, or one read from the checkout (see {@link checkoutWorkspacePackages}). */
export type WorkspacePackages =
  | WorkspacePackageMap
  | ((projectRoot: string) => WorkspacePackageMap);

/** The tsconfig tsx loads through `TSX_TSCONFIG_PATH`. */
export interface WorkspaceTsconfig {
  compilerOptions: { baseUrl: string; paths: Record<string, string[]> };
}

/** Options for {@link workspaceTsconfigEnv}. */
export interface WorkspaceTsconfigEnvOptions {
  packages: WorkspacePackages;
  /** File name written under the temp dir. Default: `node-adapter.tsconfig.json`. */
  fileName?: string;
}

/**
 * Every package the checkout's root `package.json` declares in `workspaces` (an
 * array or `{ packages }`), by name. A monorepo that moves a dependency into its
 * workspace (core's `@metamask/utils`) needs no host change. Patterns are literal
 * directories or `<dir>/*`; any other pattern throws.
 */
export function checkoutWorkspacePackages(projectRoot: string): WorkspacePackageMap {
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  const dirs = patterns.flatMap((pattern) => {
    const parent = pattern.endsWith('/*') ? pattern.slice(0, -2) : undefined;
    if (/[*!?{[]/u.test(parent ?? pattern)) {
      throw new Error(
        `workspace pattern "${pattern}" is not supported; pass workspacePackages as a map.`,
      );
    }
    if (parent === undefined) return [pattern];
    const parentDir = path.join(projectRoot, parent);
    if (!existsSync(parentDir)) return [];
    return readdirSync(parentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.posix.join(parent, entry.name));
  });
  const packages: Record<string, string> = {};
  for (const dir of dirs) {
    const packageJson = path.join(projectRoot, dir, 'package.json');
    if (!existsSync(packageJson)) continue;
    const { name } = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string };
    if (name) packages[name] = dir;
  }
  return packages;
}

/**
 * Paths for every package that has `src/index.ts`, built or not; null when no
 * package has one.
 */
export function workspaceTsconfig(
  projectRoot: string,
  packages: WorkspacePackages,
): WorkspaceTsconfig | null {
  const map = typeof packages === 'function' ? packages(projectRoot) : packages;
  const paths: Record<string, string[]> = {};
  for (const [name, dir] of Object.entries(map)) {
    const srcDir = path.join(projectRoot, dir, 'src');
    if (!existsSync(path.join(srcDir, 'index.ts'))) continue;
    paths[name] = [path.join(srcDir, 'index.ts')];
    paths[`${name}/*`] = [path.join(srcDir, '*')];
  }
  if (Object.keys(paths).length === 0) return null;
  return { compilerOptions: { baseUrl: projectRoot, paths } };
}

/**
 * Write {@link workspaceTsconfig} under `tempDir` and return the environment tsx
 * runs with: `TSX_TSCONFIG_PATH`, and `NODE_OPTIONS` with the checkout's PnP
 * loader when it has one. Empty when no package needs mapping.
 */
export async function workspaceTsconfigEnv(
  projectRoot: string,
  tempDir: string,
  options: WorkspaceTsconfigEnvOptions,
): Promise<NodeJS.ProcessEnv> {
  const tsconfig = workspaceTsconfig(projectRoot, options.packages);
  if (!tsconfig) return {};
  const tsconfigPath = path.join(tempDir, options.fileName ?? 'node-adapter.tsconfig.json');
  await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  return {
    TSX_TSCONFIG_PATH: tsconfigPath,
    NODE_OPTIONS: pnpNodeOptions(projectRoot, process.env.NODE_OPTIONS),
  };
}
