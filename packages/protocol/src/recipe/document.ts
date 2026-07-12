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
  for (const entry of collectObservationPolicies(recipe)) {
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

interface ObservationPolicyEntry {
  path: string;
  policy: unknown;
  field: 'observe' | 'expect_observations';
  node: Record<string, unknown>;
}

function collectObservationPolicies(recipe: unknown): ObservationPolicyEntry[] {
  if (!isRecord(recipe)) return [];
  const entries = collectNodeObservationPolicies(recipe.startState, 'startState');
  const validate = isRecord(recipe.validate) ? recipe.validate : undefined;
  entries.push(...collectWorkflowObservationPolicies(validate?.workflow, 'validate.workflow'));
  if (isRecord(recipe.flows)) {
    for (const [ref, flow] of Object.entries(recipe.flows)) {
      if (!isRecord(flow)) continue;
      entries.push(
        ...collectWorkflowObservationPolicies(
          isRecord(flow.workflow) ? flow.workflow : flow,
          `flows.${ref}${isRecord(flow.workflow) ? '.workflow' : ''}`,
        ),
      );
    }
  }
  return entries;
}

function collectWorkflowObservationPolicies(
  value: unknown,
  path: string,
): ObservationPolicyEntry[] {
  if (!isRecord(value)) return [];
  const entries: ObservationPolicyEntry[] = [];
  if (isRecord(value.nodes)) {
    for (const [nodeId, node] of Object.entries(value.nodes)) {
      entries.push(...collectNodeObservationPolicies(node, `${path}.nodes.${nodeId}`));
    }
  }
  for (const lifecycle of ['setup', 'teardown'] as const) {
    if (!Array.isArray(value[lifecycle])) continue;
    value[lifecycle].forEach((node, index) => {
      entries.push(...collectNodeObservationPolicies(node, `${path}.${lifecycle}[${index}]`));
    });
  }
  return entries;
}

function collectNodeObservationPolicies(value: unknown, path: string): ObservationPolicyEntry[] {
  if (!isRecord(value) || typeof value.action !== 'string') return [];
  const entries: ObservationPolicyEntry[] = [];
  for (const field of ['observe', 'expect_observations'] as const) {
    if (hasOwn(value, field))
      entries.push({ path: `${path}.${field}`, policy: value[field], field, node: value });
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
  for (const entry of collectObservationPolicies(recipe)) {
    const valid =
      entry.field === 'observe'
        ? typeof entry.policy === 'boolean' || validObserverRefArray(entry.policy)
        : validObserverRefArray(entry.policy);
    if (!valid) {
      addFinding(
        ctx,
        'error',
        entry.field === 'observe'
          ? 'recipe.invalid_observe_policy'
          : 'recipe.invalid_observation_expectation',
        entry.path,
        entry.field === 'observe'
          ? 'observe must be a boolean or an array of unique non-empty observer refs.'
          : 'expect_observations must be an array of unique non-empty observer refs.',
      );
    }
    if (
      entry.field === 'expect_observations' &&
      Array.isArray(entry.policy) &&
      entry.policy.length > 0 &&
      entry.node.observe === false
    ) {
      addFinding(
        ctx,
        'error',
        'recipe.contradictory_observation_expectation',
        entry.path,
        'expect_observations must be empty when observe is false; the node can never record observations.',
      );
    }
  }

  return finishResult(ctx);
}

function validObserverRefArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((ref) => typeof ref === 'string' && ref.trim() !== '') &&
    new Set(value).size === value.length
  );
}
