export type RecipeResolutionErrorCode =
  | 'RECIPE_CALL_CYCLE'
  | 'RECIPE_CALL_DEPTH_EXCEEDED'
  | 'RECIPE_LIBRARY_ADAPTER_DECLARATION_CONFLICT'
  | 'RECIPE_LIBRARY_DUPLICATE_RECIPE'
  | 'RECIPE_LIBRARY_DUPLICATE_SOURCE'
  | 'RECIPE_LIBRARY_RECIPE_INVALID'
  | 'RECIPE_PARAMS_INVALID'
  | 'RECIPE_PRECONDITION_NOT_FOUND'
  | 'RECIPE_REFERENCE_NOT_FOUND'
  | 'RECIPE_RESOLUTION_DIGEST_MISSING';

export class RecipeResolutionError extends Error {
  readonly code: RecipeResolutionErrorCode;
  readonly userAction: string;

  constructor(code: RecipeResolutionErrorCode, message: string, userAction: string) {
    super(message);
    this.name = 'RecipeResolutionError';
    this.code = code;
    this.userAction = userAction;
  }
}
