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
 * dependencies or devDependencies. A predicate with no entries is left out.
 */
export function adapterDetectFromSpec(spec: AdapterDetectSpec): AdapterDetect {
  const remotes = spec.remote ?? [];
  const files = spec.files ?? [];
  const dependencies = spec.packageDependencies ?? [];
  const detect: AdapterDetect = {};
  if (remotes.length > 0) detect.remote = (url) => remotes.some((entry) => url.includes(entry));
  if (files.length > 0 || dependencies.length > 0) {
    detect.files = (target) =>
      files.every((file) => exists(target, file)) &&
      (dependencies.length === 0 ||
        dependencies.every((name) => packageDependencies(target).has(name)));
  }
  return detect;
}

function exists(target: string, file: string): boolean {
  try {
    const stat = fs.statSync(path.join(target, file));
    return !file.endsWith('/') || stat.isDirectory();
  } catch {
    // Missing, or unreadable: the checkout does not have it.
    return false;
  }
}

function packageDependencies(target: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const names = (value: unknown) =>
      value !== null && typeof value === 'object' ? Object.keys(value) : [];
    return new Set([...names(pkg.dependencies), ...names(pkg.devDependencies)]);
  } catch {
    // No package.json, or one that does not parse: no dependencies.
    return new Set();
  }
}
