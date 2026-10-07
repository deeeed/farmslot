// The checkout layout the web-dapp leaves share (`temp/recipe/runtime/<adapter>/`).
// Local copies of the recipe-cli harness path helpers: adapter-web does not
// depend on @farmslot/recipe-cli. The environment names and defaults match.

import path from 'node:path';

export const DEFAULT_RECIPE_RUNTIME_DIR = 'temp/recipe/runtime';
export const DEFAULT_RECIPE_HARNESS_ROOT = 'temp/recipe/harness';

export function validateRelativeRecipePath(name, value) {
  if (!value || path.isAbsolute(value)) {
    throw new Error(`${name} must be a non-empty relative path: ${value}`);
  }
  if (!/^[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error(`${name} contains unsupported characters: ${value}`);
  }
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`${name} contains unsafe path component: ${value}`);
    }
  }
  return value;
}

/** The checkout-relative runtime directory: `RECIPE_RUNTIME_DIR`, else the default. */
export function recipeRuntimeDir() {
  return validateRelativeRecipePath(
    'RECIPE_RUNTIME_DIR',
    process.env.RECIPE_RUNTIME_DIR || DEFAULT_RECIPE_RUNTIME_DIR,
  );
}

/** The checkout-relative overlay directory: `RECIPE_HARNESS_ROOT`, else the default. */
export function recipeHarnessRoot() {
  return validateRelativeRecipePath(
    'RECIPE_HARNESS_ROOT',
    process.env.RECIPE_HARNESS_ROOT || DEFAULT_RECIPE_HARNESS_ROOT,
  );
}

export function recipeRuntimePath(projectRoot, ...segments) {
  return path.join(projectRoot, recipeRuntimeDir(), ...segments);
}

export function recipeHarnessPath(projectRoot, ...segments) {
  return path.join(projectRoot, recipeHarnessRoot(), ...segments);
}

export function walletFixturePath(projectRoot) {
  return recipeRuntimePath(projectRoot, 'wallet-fixture.json');
}

export function shellQuote(value) {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
