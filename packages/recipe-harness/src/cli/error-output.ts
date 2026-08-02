import { RecipeResolutionError } from '../core/resolution-error.js';
import { RecipeTrustError } from '../core/trust-error.js';

export type RecipeCliError = RecipeResolutionError | RecipeTrustError;

export function isRecipeCliError(error: unknown): error is RecipeCliError {
  return error instanceof RecipeResolutionError || error instanceof RecipeTrustError;
}

export function reportRecipeCliError(error: RecipeCliError, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        error instanceof RecipeTrustError
          ? error.failure
          : { code: error.code, message: error.message, userAction: error.userAction },
        null,
        2,
      ),
    );
  } else {
    console.error(`Error [${error.code}]: ${error.message}`);
    console.error(`Next: ${error.userAction}`);
  }
  process.exitCode = 1;
}
