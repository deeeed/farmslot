import {
  applyRecipeParamDefaults,
  findUnsupportedRecipeTemplates,
  parseRecipeTemplate,
  type RecipeTemplateReference,
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
 * a template it cannot parse; `nodeId` names the node in those errors.
 * `lenient` is the static view before a run: only an exact reference to a
 * parameter that exists resolves; anything else stays as written.
 */
export function resolveRecipeValue(
  value: unknown,
  params: Record<string, unknown>,
  outputs?: ReadonlyMap<string, unknown>,
  options: { lenient?: boolean; nodeId?: string } = {},
): unknown {
  if (typeof value === 'string') {
    const exact = parseRecipeTemplate(value);
    if (options.lenient) {
      const found = exact?.source === 'params' ? nestedValue(params, exact.path) : undefined;
      return found && 'value' in found ? found.value : value;
    }
    const where = options.nodeId ? ` in node ${options.nodeId}` : '';
    const [unsupported] = findUnsupportedRecipeTemplates(value);
    if (unsupported !== undefined) {
      throw new RecipeResolutionError(
        'RECIPE_PARAMS_INVALID',
        `Recipe value ${unsupported}${where} is not a supported template.`,
        'use {{params.<name>}} or {{outputs.<node>.<path>}}, with [n] for an array index',
      );
    }
    if (exact) {
      if (exact.source === 'outputs' && !outputs) return value;
      return getRecipeReference(exact, value, params, outputs, where);
    }
    return replaceRecipeTemplates(value, (reference, template) =>
      reference.source === 'outputs' && !outputs
        ? template
        : String(getRecipeReference(reference, template, params, outputs, where)),
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

// Errors quote the template as authored (`positions[1]`), not its normalized path.
function getRecipeReference(
  reference: RecipeTemplateReference,
  template: string,
  params: Record<string, unknown>,
  outputs: ReadonlyMap<string, unknown> | undefined,
  where: string,
): unknown {
  if (reference.source === 'params') {
    return getNestedValue(params, reference.path, 'parameter', template, where);
  }
  const [nodeId, ...segments] = reference.path.split('.');
  if (!nodeId || !outputs?.has(nodeId)) {
    throw new RecipeResolutionError(
      'RECIPE_PARAMS_INVALID',
      `Recipe output ${template}${where} is not defined.`,
      `run node ${nodeId} before referencing ${template}`,
    );
  }
  return getNestedValue(outputs.get(nodeId), segments.join('.'), 'output', template, where);
}

function getNestedValue(
  value: unknown,
  path: string,
  kind: 'parameter' | 'output',
  template: string,
  where: string,
): unknown {
  const found = nestedValue(value, path);
  if ('value' in found) return found.value;
  if (found.arrayLength !== undefined) {
    throw new RecipeResolutionError(
      'RECIPE_PARAMS_INVALID',
      `Recipe ${kind} ${template}${where}: index ${found.missing} is out of range for an array of ${found.arrayLength}.`,
      `use an index below ${found.arrayLength}, or check the ${kind} holds the entry before referencing it`,
    );
  }
  throw new RecipeResolutionError(
    'RECIPE_PARAMS_INVALID',
    `Recipe ${kind} ${template}${where} is not defined.`,
    kind === 'parameter'
      ? 'declare the parameter in paramsSchema or provide it before running the recipe'
      : 'inspect the producing node output before referencing it',
  );
}

type NestedLookup = { value: unknown } | { missing: string; arrayLength?: number };

// The value at a dotted path, or the segment where it stops. A numeric segment
// indexes an array; on an object it reads that key.
function nestedValue(value: unknown, path: string): NestedLookup {
  let current: unknown = value;
  if (!path) return { value: current };
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return { missing: segment };
      const index = Number(segment);
      if (index >= current.length) return { missing: segment, arrayLength: current.length };
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { missing: segment };
    current = current[segment];
  }
  return { value: current };
}
