import {
  addFinding,
  createContext,
  finishResult,
  hasOwn,
  isRecord,
  RECIPE_PROTOCOL_SCHEMA_VERSION,
  type RecipeValidationResult,
  validateOptionalStringField,
} from './common.js';
import {
  getRecipeActionManifestActionNames,
  getRecipeActionManifestPreconditionIds,
  validateRecipeActionManifestDocument,
} from './manifest.js';
import {
  extractWorkflow,
  getRecipeWorkflowActionEntries,
  getRecipeWorkflowPreconditionEntries,
  validateFlowCalls,
  validateInlineFlows,
  validateWorkflowGraph,
  validateWorkflowPreconditions,
} from './workflow.js';

export interface RecipeDocumentValidationOptions {
  /**
   * Flow ids resolvable outside the recipe document (e.g. from configured
   * recipe library sources). `call.ref` values found here are not reported as
   * unresolved even when the recipe has no `uses` catalogs or inline flows.
   */
  externalFlowIds?: ReadonlySet<string>;
}

export function validateRecipeWithManifest(
  recipe: unknown,
  manifest: unknown,
  options?: RecipeDocumentValidationOptions,
): RecipeValidationResult {
  const ctx = createContext();
  const recipeResult = validateRecipeDocument(recipe, options);
  const manifestResult = validateRecipeActionManifestDocument(manifest);
  ctx.findings.push(...recipeResult.findings, ...manifestResult.findings);

  const declaredActions = new Set(getRecipeActionManifestActionNames(manifest));
  if (declaredActions.size > 0) {
    const actions = getRecipeWorkflowActionEntries(recipe);
    actions.forEach(({ action, path }) => {
      if (!declaredActions.has(action)) {
        addFinding(
          ctx,
          'error',
          'recipe.action_not_declared_by_manifest',
          path,
          `Recipe action ${action} is not declared by the runner action manifest.`,
        );
      }
    });
  }

  const declaredPreconditions = new Set(getRecipeActionManifestPreconditionIds(manifest));
  for (const gate of getRecipeWorkflowPreconditionEntries(recipe)) {
    if (!declaredPreconditions.has(gate.id)) {
      addFinding(
        ctx,
        'error',
        'recipe.precondition_not_declared_by_manifest',
        gate.path,
        `Recipe precondition ${gate.id} is not declared by the runner action manifest.`,
      );
    }
  }

  return finishResult(ctx);
}

export function validateRecipeDocument(
  recipe: unknown,
  options?: RecipeDocumentValidationOptions,
): RecipeValidationResult {
  const ctx = createContext();
  if (!isRecord(recipe)) {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_document',
      '$',
      'Recipe document must be a JSON object.',
    );
    return finishResult(ctx);
  }

  const schemaVersion = recipe.schema_version;
  const schemaVersionIsV1 = schemaVersion === RECIPE_PROTOCOL_SCHEMA_VERSION;
  if (!hasOwn(recipe, 'schema_version')) {
    addFinding(
      ctx,
      'error',
      'recipe.missing_schema_version',
      'schema_version',
      `Recipe must set schema_version: ${RECIPE_PROTOCOL_SCHEMA_VERSION}.`,
    );
  } else if (!schemaVersionIsV1) {
    addFinding(
      ctx,
      'error',
      'recipe.unsupported_schema_version',
      'schema_version',
      `Unsupported schema_version ${JSON.stringify(schemaVersion)}; supported value is ${RECIPE_PROTOCOL_SCHEMA_VERSION}.`,
    );
  }

  validateOptionalStringField(ctx, recipe, 'title', 'title');
  validateOptionalStringField(ctx, recipe, 'description', 'description');

  const validate = recipe.validate;
  const rawWorkflow = isRecord(validate) && isRecord(validate.workflow) ? validate.workflow : null;
  const workflow = extractWorkflow(ctx, recipe);
  if (workflow && rawWorkflow) {
    validateWorkflowPreconditions(ctx, rawWorkflow);
    validateWorkflowGraph(ctx, workflow, rawWorkflow);
    validateFlowCalls(ctx, recipe, workflow, options);
  }
  validateInlineFlows(ctx, recipe);

  return finishResult(ctx);
}
