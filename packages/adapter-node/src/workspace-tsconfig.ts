// Live adapter scripts import a checkout's workspace packages as runtime values.
// In an unbuilt monorepo those packages have no dist/, so their package "exports"
// (which point only at dist) cannot resolve. A generated tsconfig paths map points
// tsx at each package's src instead, without building or modifying the checkout.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pnpNodeOptions } from './dependencies.js';

/** Package name → its directory, relative to the checkout root. */
export type WorkspacePackageMap = Readonly<Record<string, string>>;

/** The tsconfig tsx loads through `TSX_TSCONFIG_PATH`. */
export interface WorkspaceTsconfig {
  compilerOptions: { baseUrl: string; paths: Record<string, string[]> };
}

/** Options for {@link workspaceTsconfigEnv}. */
export interface WorkspaceTsconfigEnvOptions {
  packages: WorkspacePackageMap;
  /** File name written under the temp dir. Default: `node-adapter.tsconfig.json`. */
  fileName?: string;
}

/**
 * Paths for every package that is unbuilt (no `dist/index.cjs`) and has
 * `src/index.ts`; null when no package needs one.
 */
export function workspaceTsconfig(
  projectRoot: string,
  packages: WorkspacePackageMap,
): WorkspaceTsconfig | null {
  const paths: Record<string, string[]> = {};
  for (const [name, dir] of Object.entries(packages)) {
    const packageDir = path.join(projectRoot, dir);
    // A built package resolves normally.
    if (existsSync(path.join(packageDir, 'dist/index.cjs'))) continue;
    const srcDir = path.join(packageDir, 'src');
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
