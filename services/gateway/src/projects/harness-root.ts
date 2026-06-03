/**
 * Configurable recipe-harness injection root, kept in sync with the skill's
 * path.sh resolver (RECIPE_HARNESS_ROOT, default `temp/agentic/recipe-harness`).
 *
 * Validation mirrors path.sh: relative, safe charset, no `.`/`..` components. A
 * hostile/typo'd value falls back to the default with a warning rather than
 * crashing the gateway.
 */

/** Single default harness injection root, under the gitignored temp/ dir. */
export const DEFAULT_HARNESS_ROOT = 'temp/agentic/recipe-harness';

export function harnessRoot(): string {
  // Validate the raw value (no trim) so leading/trailing whitespace is rejected,
  // matching the shell resolver's charset check.
  const root = process.env.RECIPE_HARNESS_ROOT;
  if (!root) {
    return DEFAULT_HARNESS_ROOT;
  }
  const safe =
    /^[A-Za-z0-9._/-]+$/.test(root) &&
    !root.startsWith('/') &&
    !root.split('/').some((part) => part === '.' || part === '..');
  if (!safe) {
    console.warn(`[harness-root] ignoring unsafe RECIPE_HARNESS_ROOT="${root}", using default`);
    return DEFAULT_HARNESS_ROOT;
  }
  return root;
}
