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

export function resolveRecipeValue(
  value: unknown,
  params: Record<string, unknown>,
  outputs?: ReadonlyMap<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{(params|outputs)\.([A-Za-z0-9_.-]+)\}\}$/u.exec(value);
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
  if (Array.isArray(value)) return value.map((entry) => resolveRecipeValue(entry, params, outputs));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveRecipeValue(entry, params, outputs)]),
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
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new RecipeResolutionError(
        'RECIPE_PARAMS_INVALID',
        `Recipe ${kind} ${path} is not defined.`,
        kind === 'parameter'
          ? `declare ${path} in paramsSchema or provide it before running the recipe`
          : `inspect the producing node output before referencing ${path}`,
      );
    }
    current = current[segment];
  }
  return current;
}
