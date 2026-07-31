import type { RecipeFailureCause } from '@farmslot/protocol';

const RECIPE_EXECUTION_ERROR_BRAND = Symbol.for('@farmslot/recipe-harness/RecipeExecutionError');
const FAILURE_CAUSES = new Set<RecipeFailureCause>([
  'subject',
  'harness',
  'environment',
  'unknown',
]);

export class RecipeExecutionError extends Error {
  readonly [RECIPE_EXECUTION_ERROR_BRAND] = true;
  readonly causeClass: RecipeFailureCause;

  constructor(causeClass: RecipeFailureCause, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecipeExecutionError';
    this.causeClass = causeClass;
  }
}

export function recipeFailureCause(
  error: unknown,
  fallback: RecipeFailureCause = 'unknown',
): RecipeFailureCause {
  if (
    error &&
    typeof error === 'object' &&
    RECIPE_EXECUTION_ERROR_BRAND in error &&
    error[RECIPE_EXECUTION_ERROR_BRAND] === true &&
    'causeClass' in error &&
    FAILURE_CAUSES.has(error.causeClass as RecipeFailureCause)
  ) {
    return error.causeClass as RecipeFailureCause;
  }
  return fallback;
}
