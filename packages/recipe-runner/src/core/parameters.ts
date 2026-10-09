import {
  applyRecipeParamDefaults,
  findUnsupportedRecipeTemplates,
  parseRecipeTemplate,
  replaceRecipeTemplates,
  validateRecipeParams,
} from '@farmslot/protocol';

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
 * (the default) interpolates every reference and throws on a missing one or on
 * a template it cannot parse. `lenient` is the static view before a run: only
 * an exact reference to a parameter that exists resolves; anything else stays
 * as written.
 */
export function resolveRecipeValue(
  value: unknown,
  params: Record<string, unknown>,
  outputs?: ReadonlyMap<string, unknown>,
  options: { lenient?: boolean } = {},
): unknown {
  if (typeof value === 'string') {
    const exact = parseRecipeTemplate(value);
    if (options.lenient) {
      const found = exact?.source === 'params' ? nestedValue(params, exact.path) : undefined;
      return found ? found.value : value;
    }
    const [unsupported] = findUnsupportedRecipeTemplates(value);
    if (unsupported !== undefined) {
      throw new RecipeResolutionError(
        'RECIPE_PARAMS_INVALID',
        `Recipe value ${unsupported} is not a supported template.`,
        'use {{params.<name>}} or {{outputs.<node>.<path>}}, with [n] for an array index',
      );
    }
    if (exact) {
      if (exact.source === 'outputs' && !outputs) return value;
      return getRecipeReference(exact.source, exact.path, params, outputs);
    }
    return replaceRecipeTemplates(value, (reference, template) =>
      reference.source === 'outputs' && !outputs
        ? template
        : String(getRecipeReference(reference.source, reference.path, params, outputs)),
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
  return getNestedValue(outputs.get(nodeId), segments.join('.'), 'output', path);
}

function getNestedValue(
  value: unknown,
  path: string,
  kind: 'parameter' | 'output',
  reference = path,
): unknown {
  const found = nestedValue(value, path);
  if (!found) {
    throw new RecipeResolutionError(
      'RECIPE_PARAMS_INVALID',
      `Recipe ${kind} ${reference} is not defined.`,
      kind === 'parameter'
        ? `declare ${path} in paramsSchema or provide it before running the recipe`
        : `inspect the producing node output before referencing ${reference}`,
    );
  }
  return found.value;
}

// The value at a dotted path, or undefined when a segment is missing. A numeric
// segment indexes an array.
function nestedValue(value: unknown, path: string): { value: unknown } | undefined {
  let current: unknown = value;
  if (!path) return { value: current };
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : -1;
      if (index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return { value: current };
}
