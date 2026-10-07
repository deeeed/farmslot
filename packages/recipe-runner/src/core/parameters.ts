import { applyRecipeParamDefaults, validateRecipeParams } from '@farmslot/protocol';

import { isRecord } from './json.js';
import { RecipeResolutionError } from './resolution-error.js';

export function resolveRecipeParams(
  ref: string,
  recipe: Record<string, unknown>,
  input: Record<string, unknown>,
  options?: { allowTemplates?: boolean },
): Record<string, unknown> {
  const params = applyRecipeParamDefaults(input, recipe.paramsSchema);
  const validation = validateRecipeParams(params, recipe.paramsSchema, options);
  if (validation.status === 'invalid') {
    throw new RecipeResolutionError(
      'RECIPE_PARAMS_INVALID',
      `Recipe ${ref} parameters are invalid: ${validation.findings
        .map((finding) => `${finding.code} ${finding.path}: ${finding.message}`)
        .join('; ')}`,
      `inspect ${ref} with run --describe, then provide the required key=value parameters`,
    );
  }
  return params;
}

/**
 * `value` with its `{{params.*}}`/`{{outputs.*}}` references resolved. Strict
 * (the default) interpolates every reference and throws on a missing one.
 * `lenient` is the static view before a run: only an exact reference to a
 * parameter that exists resolves; anything else stays as written.
 */
export function resolveRecipeValue(
  value: unknown,
  params: Record<string, unknown>,
  outputs?: ReadonlyMap<string, unknown>,
  options: { lenient?: boolean } = {},
): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{(params|outputs)\.([A-Za-z0-9_.-]+)\}\}$/u.exec(value);
    if (options.lenient) {
      const found = exact?.[1] === 'params' ? nestedValue(params, exact[2]!) : undefined;
      return found ? found.value : value;
    }
    if (exact) {
      if (exact[1] === 'outputs' && !outputs) return value;
      return getRecipeReference(exact[1]!, exact[2]!, params, outputs);
    }
    return value.replace(
      /\{\{(params|outputs)\.([A-Za-z0-9_.-]+)\}\}/gu,
      (_match, source: string, key: string) =>
        source === 'outputs' && !outputs
          ? _match
          : String(getRecipeReference(source, key, params, outputs)),
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveRecipeValue(entry, params, outputs, options));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveRecipeValue(entry, params, outputs, options),
    ]),
  );
}

function getRecipeReference(
  source: string,
  path: string,
  params: Record<string, unknown>,
  outputs?: ReadonlyMap<string, unknown>,
): unknown {
  if (source === 'params') return getNestedValue(params, path, 'parameter');
  if (!outputs) return `{{outputs.${path}}}`;
  const [nodeId, ...segments] = path.split('.');
  if (!nodeId || !outputs.has(nodeId)) {
    throw new RecipeResolutionError(
      'RECIPE_PARAMS_INVALID',
      `Recipe output ${path} is not defined.`,
      `run the producing node before referencing outputs.${path}`,
    );
  }
  return getNestedValue(outputs.get(nodeId), segments.join('.'), 'output');
}

function getNestedValue(value: unknown, path: string, kind: 'parameter' | 'output'): unknown {
  const found = nestedValue(value, path);
  if (!found) {
    throw new RecipeResolutionError(
      'RECIPE_PARAMS_INVALID',
      `Recipe ${kind} ${path} is not defined.`,
      kind === 'parameter'
        ? `declare ${path} in paramsSchema or provide it before running the recipe`
        : `inspect the producing node output before referencing ${path}`,
    );
  }
  return found.value;
}

// The value at a dotted path, or undefined when a segment is missing.
function nestedValue(value: unknown, path: string): { value: unknown } | undefined {
  let current: unknown = value;
  if (!path) return { value: current };
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return { value: current };
}
