import { digestRecipeDocument, isRecord } from '@farmslot/protocol';

const SENSITIVE_KEY =
  /(?:api[-_]?key|auth|credential|mnemonic|pass(?:word)?|private[-_]?key|secret|seed|srp|token|vault)/iu;
const PUBLIC_KEY_INDEX = /^(?:api_key_index|apiKeyIndex)$/u;

export interface RecipeInvocationDocument {
  version: 1;
  recipeDigest: string;
  startedAt: string;
  params: Record<string, unknown>;
  redactedPaths: string[];
}

/** Retain typed public inputs without recording credential-bearing fields. */
export function redactRecipeParams(
  params: Record<string, unknown>,
  schema: unknown,
): Pick<RecipeInvocationDocument, 'params' | 'redactedPaths'> {
  const redactedPaths: string[] = [];
  function visit(value: unknown, definition: unknown, pointer: string): unknown {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        visit(entry, isRecord(definition) ? definition.items : undefined, `${pointer}/${index}`),
      );
    }
    if (isRecord(value)) {
      const properties =
        isRecord(definition) && isRecord(definition.properties) ? definition.properties : {};
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          const child = properties[key];
          const childPath = `${pointer}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
          const publicIndex =
            PUBLIC_KEY_INDEX.test(key) &&
            isRecord(child) &&
            child.type === 'integer' &&
            Number.isSafeInteger(entry) &&
            Number(entry) >= 0;
          if (SENSITIVE_KEY.test(key) && !publicIndex) {
            redactedPaths.push(childPath);
            return [key, '<redacted>'];
          }
          return [key, visit(entry, child, childPath)];
        }),
      );
    }
    if (typeof value === 'string') {
      const redacted = value
        .replace(/(\w+:\/\/)[^/@\s:]+:[^/@\s]+@/gu, '$1<redacted>@')
        .replace(
          /((?:api[-_]?key|auth|credential|mnemonic|pass(?:word)?|private[-_]?key|secret|seed|srp|token|vault)=)[^\s]+/giu,
          '$1<redacted>',
        );
      if (redacted !== value) redactedPaths.push(pointer);
      return redacted;
    }
    return value;
  }
  return { params: visit(params, schema, '') as Record<string, unknown>, redactedPaths };
}

export function createRecipeInvocation(
  recipe: unknown,
  params: Record<string, unknown>,
  startedAt: string,
): RecipeInvocationDocument {
  return {
    version: 1,
    recipeDigest: digestRecipeDocument(recipe),
    startedAt,
    ...redactRecipeParams(params, isRecord(recipe) ? recipe.paramsSchema : undefined),
  };
}

/** Reject mismatched or redacted inputs instead of validating a different execution. */
export function recordedRecipeParams(
  recipe: unknown,
  invocation: unknown,
  summary: unknown,
): Record<string, unknown> {
  if (
    !isRecord(invocation) ||
    invocation.version !== 1 ||
    !isRecord(invocation.params) ||
    !Array.isArray(invocation.redactedPaths) ||
    !invocation.redactedPaths.every((entry) => typeof entry === 'string') ||
    !isRecord(summary) ||
    typeof invocation.startedAt !== 'string' ||
    invocation.startedAt !== summary.startedAt ||
    invocation.recipeDigest !== digestRecipeDocument(recipe) ||
    summary.invocationDigest !== digestRecipeDocument(invocation)
  ) {
    throw new Error('Recipe invocation does not match the recorded recipe and execution summary.');
  }
  const safe = redactRecipeParams(
    invocation.params,
    isRecord(recipe) ? recipe.paramsSchema : undefined,
  );
  if (invocation.redactedPaths.length || safe.redactedPaths.length) {
    throw new Error(
      'Recipe invocation contains redacted parameters; use fixture references instead of credentials in recipe inputs.',
    );
  }
  return invocation.params;
}
