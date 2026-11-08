export const BUILT_IN_RECIPE_PLATFORMS: readonly string[];
export interface RecipeFileIdentity {
  ref: string;
  adapter?: string;
}
export interface RecipeFileIdentityError {
  error: {
    code: 'RECIPE_LIBRARY_ADAPTER_DECLARATION_CONFLICT' | 'RECIPE_LIBRARY_RECIPE_INVALID';
    message: string;
    recovery: string;
  };
}
export function recipeFileIdentity(
  relativeFile: string,
  adapter?: string,
  platforms?: readonly string[],
): RecipeFileIdentity | RecipeFileIdentityError | undefined;
