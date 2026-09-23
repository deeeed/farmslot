import type { RecipeFailureCause } from '@farmslot/protocol';

const RECIPE_EXECUTION_ERROR_BRAND = Symbol.for('@farmslot/recipe-harness/RecipeExecutionError');
const FAILURE_CAUSES = new Set<RecipeFailureCause>([
  'subject',
  'harness',
  'environment',
  'unknown',
]);

export interface RecipeExecutionErrorOptions extends ErrorOptions {
  /** Stable machine-readable failure code recorded as trace error_code. */
  code?: string;
  /** Observation at the moment of failure, recorded as trace error_details. */
  details?: unknown;
}

export class RecipeExecutionError extends Error {
  readonly [RECIPE_EXECUTION_ERROR_BRAND] = true;
  readonly causeClass: RecipeFailureCause;
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    causeClass: RecipeFailureCause,
    message: string,
    options?: RecipeExecutionErrorOptions,
  ) {
    super(message, options);
    this.name = 'RecipeExecutionError';
    this.causeClass = causeClass;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.details !== undefined) this.details = options.details;
  }
}

function isRecipeExecutionError(error: unknown): error is RecipeExecutionError {
  return Boolean(
    error &&
    typeof error === 'object' &&
    RECIPE_EXECUTION_ERROR_BRAND in error &&
    error[RECIPE_EXECUTION_ERROR_BRAND] === true,
  );
}

/** Trace fields for a coded execution failure; empty for uncoded errors. */
export function recipeFailureTraceFields(error: unknown): {
  error_code?: string;
  error_details?: unknown;
} {
  if (!isRecipeExecutionError(error)) return {};
  return {
    ...(typeof error.code === 'string' ? { error_code: error.code } : {}),
    ...(error.details !== undefined ? { error_details: error.details } : {}),
  };
}

export function recipeFailureCause(
  error: unknown,
  fallback: RecipeFailureCause = 'unknown',
): RecipeFailureCause {
  if (isRecipeExecutionError(error) && FAILURE_CAUSES.has(error.causeClass)) {
    return error.causeClass;
  }
  return fallback;
}
