import fs from 'node:fs';
import path from 'node:path';

import type { ResolvedProjectBinding } from './context-state.js';
import { harnessHost, hostEnvName, validateRelativeRecipePath } from './host.js';

// The checkout layout every host and shell leaf shares (`temp/recipe/runtime/<adapter>/`).
export const DEFAULT_RECIPE_RUNTIME_DIR = 'temp/recipe/runtime';
/** Where `prepare` keeps its running progress, under the artifacts dir. */
export const PREPARE_PROGRESS_ARTIFACT = 'prepare/progress.json';
export const DEFAULT_RECIPE_HARNESS_ROOT = 'temp/recipe/harness';

/** The checkout-relative runtime directory: `RECIPE_RUNTIME_DIR`, else the default. */
export function recipeRuntimeDir(): string {
  return validateRelativeRecipePath(
    'RECIPE_RUNTIME_DIR',
    process.env.RECIPE_RUNTIME_DIR || DEFAULT_RECIPE_RUNTIME_DIR,
  );
}

/** The checkout-relative overlay directory: `RECIPE_HARNESS_ROOT`, else the default. */
export function recipeHarnessRoot(): string {
  return validateRelativeRecipePath(
    'RECIPE_HARNESS_ROOT',
    process.env.RECIPE_HARNESS_ROOT || DEFAULT_RECIPE_HARNESS_ROOT,
  );
}

export function recipeRuntimePath(projectRoot: string, ...segments: string[]): string {
  return path.join(projectRoot, recipeRuntimeDir(), ...segments);
}

export function recipeHarnessPath(projectRoot: string, ...segments: string[]): string {
  return path.join(projectRoot, recipeHarnessRoot(), ...segments);
}

/**
 * The host executable serving this run. The host bin exports its own resolved
 * path as `<envPrefix>_EXECUTABLE`, so a command that re-enters the harness
 * reaches the install a task locked onto rather than whatever PATH resolves to.
 */
export function harnessExecutable(): string {
  const host = harnessHost();
  return path.resolve(
    process.env[hostEnvName('EXECUTABLE')] ?? path.join(host.packageRoot, host.bin),
  );
}

/** Runtime state and artifacts do not belong to the provider's implementation identity. */
export function recipeOutputRoots(
  target: string,
  binding: Pick<
    ResolvedProjectBinding,
    'checkoutRoot' | 'runtimeDir' | 'farmRuntimeDir' | 'artifactDir'
  >,
): string[] {
  return [
    path.join(binding.checkoutRoot, binding.artifactDir),
    path.join(binding.checkoutRoot, binding.farmRuntimeDir),
    path.join(target, binding.runtimeDir),
  ];
}

// Whether `inner` is `outer` or inside it, comparing real paths.
export function isPathWithin(outer: string, inner: string): boolean {
  try {
    const relative = path.relative(fs.realpathSync(outer), fs.realpathSync(inner));
    return !(
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  } catch {
    // A path that does not exist owns nothing.
    return false;
  }
}
