// AdapterDetect from data: the predicates a recipe library declares for its
// adapter plugin in recipe-library.json, which a host matches before it loads
// the plugin. A built-in adapter may use it too.
import fs from 'node:fs';
import path from 'node:path';

import type { RecipeLibraryAdapterDetect } from '@farmslot/recipe-runner';

import type { AdapterDetect } from './types.js';

/** `detect` in a recipe-library.json `adapters` entry. */
export type AdapterDetectSpec = Readonly<RecipeLibraryAdapterDetect>;

/**
 * The predicates a spec describes. `remote` matches when the origin URL contains
 * any entry. `files` matches when every path exists (a trailing `/` requires a
 * directory) and package.json lists every `packageDependencies` entry in
 * dependencies or devDependencies. A path counts only when its real path stays
 * inside the checkout, so a symlink out of it matches nothing. A predicate with
 * no entries is left out.
 */
export function adapterDetectFromSpec(spec: AdapterDetectSpec): AdapterDetect {
  const remotes = spec.remote ?? [];
  const files = spec.files ?? [];
  const dependencies = spec.packageDependencies ?? [];
  const detect: AdapterDetect = {};
  if (remotes.length > 0) detect.remote = (url) => remotes.some((entry) => url.includes(entry));
  if (files.length > 0 || dependencies.length > 0) {
    detect.files = (target) => {
      if (!files.every((file) => exists(target, file))) return false;
      if (dependencies.length === 0) return true;
      const listed = packageDependencies(target);
      return dependencies.every((name) => listed.has(name));
    };
  }
  return detect;
}

// The real path of `file` in the checkout, or undefined when it is missing or
// resolves outside the checkout.
function inCheckout(target: string, file: string): string | undefined {
  try {
    const root = fs.realpathSync(target);
    const real = fs.realpathSync(path.join(target, file));
    const relative = path.relative(root, real);
    const outside =
      relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    return outside ? undefined : real;
  } catch {
    // Missing, or unreadable: the checkout does not have it.
    return undefined;
  }
}

function exists(target: string, file: string): boolean {
  const real = inCheckout(target, file);
  if (real === undefined) return false;
  try {
    return !file.endsWith('/') || fs.statSync(real).isDirectory();
  } catch {
    // Removed since: the checkout does not have it.
    return false;
  }
}

function packageDependencies(target: string): Set<string> {
  const manifest = inCheckout(target, 'package.json');
  if (manifest === undefined) return new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    const names = (value: unknown) =>
      value !== null && typeof value === 'object' ? Object.keys(value) : [];
    return new Set([...names(pkg.dependencies), ...names(pkg.devDependencies)]);
  } catch {
    // No package.json, or one that does not parse: no dependencies.
    return new Set();
  }
}
