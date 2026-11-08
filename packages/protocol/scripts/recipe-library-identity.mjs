export const BUILT_IN_RECIPE_PLATFORMS = ['core', 'extension', 'mobile'];
const SUFFIX = '.recipe.json';

/** Resolver identity without filesystem access. Diagnostics keep caller-owned errors. */
export function recipeFileIdentity(relativeFile, adapter, platforms = []) {
  const portable = relativeFile.replaceAll('\\', '/');
  if (!portable.endsWith(SUFFIX)) return undefined;
  const base = portable.slice(0, -SUFFIX.length);
  const first = base.includes('/') ? base.slice(0, base.indexOf('/')) : undefined;
  const adapters = new Set([
    ...BUILT_IN_RECIPE_PLATFORMS,
    ...platforms,
    ...(adapter ? [adapter] : []),
  ]);
  const directoryAdapter = adapters.has(first) ? first : undefined;
  const scope = first === 'shared' ? first : directoryAdapter;
  const suffix = base.slice(base.lastIndexOf('.') + 1);
  const filenameAdapter = BUILT_IN_RECIPE_PLATFORMS.includes(suffix) ? suffix : undefined;
  if (scope && filenameAdapter)
    return {
      error: {
        code: 'RECIPE_LIBRARY_ADAPTER_DECLARATION_CONFLICT',
        message: `Library recipe recipes/${portable} declares ${scope} scope in its directory and ${filenameAdapter} adapter in its filename.`,
        recovery:
          'declare the adapter once using recipes/<adapter>/.../*.recipe.json, or use recipes/shared/.../*.recipe.json without an adapter suffix',
      },
    };
  const declaredAdapter = directoryAdapter ?? filenameAdapter;
  const idPath = scope
    ? base.slice(scope.length + 1)
    : filenameAdapter
      ? base.slice(0, -(filenameAdapter.length + 1))
      : base;
  if ((scope || declaredAdapter) && !idPath.trim())
    return {
      error: {
        code: 'RECIPE_LIBRARY_RECIPE_INVALID',
        message: `Library recipe recipes/${portable} declares ${declaredAdapter ? `adapter ${declaredAdapter}` : 'shared scope'} but has no recipe id.`,
        recovery: `move it to recipes/${scope ?? declaredAdapter}/<name>.recipe.json`,
      },
    };
  if (declaredAdapter && declaredAdapter !== adapter) return undefined;
  const ref = idPath.replaceAll('/', '.').trim();
  return ref ? { ref, ...(declaredAdapter ? { adapter: declaredAdapter } : {}) } : undefined;
}
