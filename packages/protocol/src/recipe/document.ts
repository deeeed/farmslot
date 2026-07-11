import {
  addFinding,
  createContext,
  finishResult,
  hasOwn,
  isRecord,
  RECIPE_PROTOCOL_SCHEMA_URL,
  RECIPE_PROTOCOL_SCHEMA_VERSION,
  recipeProtocolSchemaUrlForVersion,
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
  /** Require the canonical published JSON Schema URL at recipe.$schema. */
  requireSchemaRef?: boolean;
  /**
   * Skip `call.ref` resolution (unresolved_call_ref) against inline flows / uses
   * catalogs / external library flows. Call-shape checks (invalid ref/params) still
   * run. Set when a produced resolved-recipe.json already proves resolution.
   */
  skipFlowCallResolution?: boolean;
  /**
   * Whether a declared `uses` catalog counts as resolving `call.ref`s. Defaults to
   * true (authoring/run time, where catalogs are loaded). Set false at
   * artifact-package validation, where the catalogs are not in the package, so a
   * `uses`-only recipe is not self-contained.
   */
  externalCatalogsResolvable?: boolean;
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

  const declaredObservers = new Set<string>();
  if (isRecord(manifest) && Array.isArray(manifest.observers)) {
    for (const observer of manifest.observers) {
      if (isRecord(observer) && typeof observer.ref === 'string') {
        declaredObservers.add(observer.ref);
      }
    }
  }
  for (const entry of collectObservePolicies(recipe)) {
    if (!Array.isArray(entry.policy)) continue;
    entry.policy.forEach((ref, index) => {
      if (typeof ref === 'string' && !declaredObservers.has(ref)) {
        addFinding(
          ctx,
          'error',
          'recipe.observer_not_declared_by_manifest',
          `${entry.path}[${index}]`,
          `Recipe observer ${ref} is not declared by the runner action manifest.`,
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

function collectObservePolicies(
  value: unknown,
  path = '$',
): Array<{ path: string; policy: unknown }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectObservePolicies(entry, `${path}[${index}]`));
  }
  if (!isRecord(value)) return [];
  const entries =
    typeof value.action === 'string' && hasOwn(value, 'observe')
      ? [{ path: `${path}.observe`, policy: value.observe }]
      : [];
  for (const [key, entry] of Object.entries(value)) {
    entries.push(...collectObservePolicies(entry, `${path}.${key}`));
  }
  return entries;
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
  const expectedSchemaRef =
    recipeProtocolSchemaUrlForVersion(schemaVersion) ?? RECIPE_PROTOCOL_SCHEMA_URL;
  const schemaRef = recipe.$schema;
  if (options?.requireSchemaRef === true && schemaRef == null) {
    addFinding(
      ctx,
      'error',
      'recipe.missing_schema_ref',
      '$schema',
      `Recipe must set $schema to ${expectedSchemaRef}.`,
    );
  } else if (schemaRef != null && schemaRef !== expectedSchemaRef) {
    addFinding(
      ctx,
      'error',
      'recipe.unsupported_schema_ref',
      '$schema',
      `Unsupported $schema ${JSON.stringify(schemaRef)} for schema_version ${JSON.stringify(schemaVersion)}; expected ${expectedSchemaRef}.`,
    );
  }

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
    // Always run flow-call validation for call-shape checks; skipResolution gates
    // only unresolved_call_ref (proven elsewhere), and externalCatalogsResolvable
    // controls whether a declared `uses` catalog counts as resolving refs.
    validateFlowCalls(ctx, recipe, workflow, {
      ...(options?.externalFlowIds ? { externalFlowIds: options.externalFlowIds } : {}),
      skipResolution: options?.skipFlowCallResolution === true,
      externalCatalogsResolvable: options?.externalCatalogsResolvable !== false,
    });
  }
  validateInlineFlows(ctx, recipe);

  return finishResult(ctx);
}
