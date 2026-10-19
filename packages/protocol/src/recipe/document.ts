import {
  addFinding,
  createContext,
  finishResult,
  hasOwn,
  isNonEmptyString,
  isRecord,
  RECIPE_PROTOCOL_SCHEMA_URL,
  type RecipeValidationFinding,
  type RecipeValidationResult,
  validateOptionalStringField,
} from './common.js';
import { normalizeRecipeClaimId, validateRecipeClaimDeclarations } from './evidence.js';
import { RECIPE_INTENT_MAX_LENGTH, RECIPE_INTENT_WARN_LENGTH } from './hud-intent.js';
import {
  getRecipeActionManifestActionNames,
  validateRecipeActionManifestDocument,
} from './manifest.js';
import { validateRecipeParams, validateRecipeParamsSchema } from './params.js';
import { hasRecipeTemplate, replaceRecipeTemplates } from './template.js';
import {
  extractWorkflow,
  getRecipeActionParams,
  getRecipeWorkflowActionEntries,
  validateRecipeActionCases,
  validateRecipeCalls,
  validateWorkflowGraph,
} from './workflow.js';

const RECIPE_FIELDS = new Set([
  '$schema',
  'title',
  'description',
  'paramsSchema',
  'proofTargets',
  'workflow',
]);

export interface RecipeDocumentValidationOptions {
  /** Authoring lint only; retained v1 artifacts and execution remain compatible. */
  lintIntent?: boolean;
  externalRecipeIds?: ReadonlySet<string>;
  skipRecipeCallResolution?: boolean;
  adapter?: string;
}

export function validateResolvedRecipeActionNode(
  node: unknown,
  manifest: unknown,
  options?: Pick<RecipeDocumentValidationOptions, 'adapter'> & { allowTemplates?: boolean },
): RecipeValidationResult {
  const ctx = createContext();
  if (!isRecord(node) || !isNonEmptyString(node.action)) {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_action_node',
      'node',
      'Resolved action node is invalid.',
    );
    return finishResult(ctx);
  }
  if (node.action === 'call' || node.action === 'end') return finishResult(ctx);
  const contract = manifestActionContracts(manifest).get(node.action);
  if (!contract?.schema) {
    addFinding(
      ctx,
      'error',
      'recipe.action_schema_missing',
      'node.action',
      `Action ${node.action} must declare a parameter schema in the runner manifest.`,
    );
    return finishResult(ctx);
  }
  ctx.findings.push(
    ...validateRecipeParams(getRecipeActionParams(node), contract.schema, options).findings,
  );
  const adapter = options?.adapter;
  const adapterSchema = adapter ? contract.adapterSchemas?.[adapter] : undefined;
  if (adapterSchema) {
    const paramsResult = validateRecipeParams(getRecipeActionParams(node), adapterSchema, options);
    ctx.findings.push(
      ...paramsResult.findings.map((finding) => ({
        ...rebaseFinding(finding, 'node'),
        code: 'recipe.action_params_not_supported_by_adapter',
        message: `Adapter ${adapter} does not support recipe action ${node.action} with these parameters: ${finding.message} Next: adjust the parameters for ${adapter} or choose another supporting adapter.`,
      })),
    );
  }
  validateOfficialActionRelationships(ctx, node.action, node, 'node');
  return finishResult(ctx);
}

interface ManifestActionContract {
  schema?: Record<string, unknown>;
  adapters?: string[];
  adapterSchemas?: Record<string, Record<string, unknown>>;
  resultCases?: string[];
}

export function validateRecipeWithManifest(
  recipe: unknown,
  manifest: unknown,
  options?: RecipeDocumentValidationOptions,
): RecipeValidationResult {
  const ctx = createContext();
  ctx.findings.push(...validateRecipeDocument(recipe, options).findings);
  ctx.findings.push(...validateRecipeActionManifestDocument(manifest).findings);

  const declaredActions = new Set(getRecipeActionManifestActionNames(manifest));
  const contracts = manifestActionContracts(manifest);
  for (const { action, node, path } of getRecipeWorkflowActionEntries(recipe)) {
    if (action === 'end' || action === 'call') continue;
    const contract = contracts.get(action);
    const supportingAdapters = contract?.adapters ? [...contract.adapters].sort() : undefined;
    if (!declaredActions.has(action)) {
      addFinding(
        ctx,
        'error',
        'recipe.action_not_declared_by_manifest',
        `${path}.action`,
        `Recipe action ${action} is not declared by the runner action manifest.`,
      );
      continue;
    }
    if (options?.adapter && supportingAdapters && !supportingAdapters.includes(options.adapter)) {
      const supportMessage = supportingAdapters?.length
        ? ` Supporting adapters: ${supportingAdapters.join(', ')}. Next: farmslot recipe run --adapter ${supportingAdapters[0]} <recipe>`
        : '';
      addFinding(
        ctx,
        'error',
        'recipe.action_not_supported_by_adapter',
        `${path}.action`,
        `Adapter ${options.adapter} does not support recipe action ${action}.${supportMessage}`,
      );
      continue;
    }

    if (!contract?.schema) {
      addFinding(
        ctx,
        'error',
        'recipe.action_schema_missing',
        `${path}.action`,
        `Action ${action} must declare a parameter schema in the runner manifest.`,
      );
    } else {
      const paramsResult = validateRecipeParams(getRecipeActionParams(node), contract.schema, {
        allowTemplates: true,
      });
      ctx.findings.push(...paramsResult.findings.map((finding) => rebaseFinding(finding, path)));
    }

    const adapterSchema = options?.adapter
      ? contract?.adapterSchemas?.[options.adapter]
      : undefined;
    if (adapterSchema) {
      const paramsResult = validateRecipeParams(getRecipeActionParams(node), adapterSchema, {
        allowTemplates: true,
      });
      ctx.findings.push(
        ...paramsResult.findings.map((finding) => ({
          ...rebaseFinding(finding, path),
          code: 'recipe.action_params_not_supported_by_adapter',
          message: `Adapter ${options?.adapter} does not support recipe action ${action} with these parameters: ${finding.message} Next: adjust the parameters for ${options?.adapter} or choose another supporting adapter.`,
        })),
      );
    }

    validateOfficialActionRelationships(ctx, action, node, path);

    ctx.findings.push(
      ...validateRecipeActionCases(node, action, contract?.resultCases, path).findings,
    );
  }

  return finishResult(ctx);
}

function validateOfficialActionRelationships(
  ctx: ReturnType<typeof createContext>,
  action: string,
  node: Record<string, unknown>,
  path: string,
): void {
  if (action === 'ui.wait_for' && node.enabled !== undefined) {
    const deferred = (value: unknown) => typeof value === 'string' && hasRecipeTemplate(value);
    const issue = (field: string, message: string) =>
      addFinding(ctx, 'error', 'recipe.invalid_enabled_wait', `${path}.${field}`, message);
    if (!deferred(node.enabled) && typeof node.enabled !== 'boolean')
      issue('enabled', 'ui.wait_for.enabled must resolve to a boolean.');
    if (!deferred(node.expected) && node.expected !== 'present' && node.expected !== 'visible')
      issue('expected', 'Enabled waits require explicit expected=present or visible.');
    for (const alias of ['visible', 'hidden'])
      if (node[alias] !== undefined)
        issue(alias, 'Enabled waits do not accept visible or hidden aliases.');
    for (const field of ['text', 'label', 'text_contains'])
      if (node[field] !== undefined)
        issue(field, 'Enabled waits require an exact selector or test ID, not text targeting.');
    const hasSelector = node.selector !== undefined;
    const hasId = node.test_id !== undefined || node.testID !== undefined;
    if (hasSelector === hasId)
      issue('selector', 'Enabled waits require exactly one selector or test ID.');
    for (const field of ['selector', 'test_id', 'testID'])
      if (node[field] !== undefined && !isNonEmptyString(node[field]))
        issue(field, 'Enabled wait targets must be nonempty strings.');
    if (
      node.test_id !== undefined &&
      node.testID !== undefined &&
      !deferred(node.test_id) &&
      !deferred(node.testID) &&
      node.test_id !== node.testID
    )
      issue('testID', 'Enabled waits cannot use conflicting test ID aliases.');
    return;
  }
  if (action === 'watch_logs') {
    const timeout = node.timeout_ms;
    if (
      timeout !== undefined &&
      !(typeof timeout === 'string' && hasRecipeTemplate(timeout)) &&
      (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 0 || timeout > 60_000)
    ) {
      addFinding(
        ctx,
        'error',
        'recipe.invalid_log_window',
        `${path}.timeout_ms`,
        'watch_logs.timeout_ms must be an integer from 0 through 60000.',
      );
    }
    if (
      typeof timeout === 'number' &&
      timeout > 0 &&
      (typeof node.contains !== 'string' || node.contains.length === 0)
    ) {
      addFinding(
        ctx,
        'error',
        'recipe.missing_log_condition',
        `${path}.contains`,
        'A positive watch_logs.timeout_ms requires nonempty contains.',
      );
    }
    if (node.scope !== 'file' && typeof node.path === 'string') {
      let outputDependent = false;
      replaceRecipeTemplates(node.path, (reference, template) => {
        if (reference.source === 'outputs') outputDependent = true;
        return template;
      });
      if (outputDependent) {
        addFinding(
          ctx,
          'error',
          'recipe.unbound_run_log_path',
          `${path}.path`,
          'Output-derived watch_logs paths require explicit scope=file; run paths must resolve before producers execute.',
        );
      }
    }
    return;
  }
  if (action !== 'ui.pan' && action !== 'ui.drag') return;
  const hasPath = hasOwn(node, 'path');
  const hasDelta = hasOwn(node, 'delta');
  if (hasPath !== hasDelta) return;
  addFinding(
    ctx,
    'error',
    'recipe.invalid_gesture_motion',
    path,
    `${action} requires exactly one of path or delta.`,
  );
}

/** Shared input relationships for direct transports and resolved recipe nodes. */
export function validateRecipeActionRelationships(node: unknown): RecipeValidationResult {
  const ctx = createContext();
  if (!isRecord(node) || !isNonEmptyString(node.action)) {
    addFinding(ctx, 'error', 'recipe.invalid_action_node', 'node', 'Action node is invalid.');
  } else {
    validateOfficialActionRelationships(ctx, node.action, node, 'node');
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

  for (const field of Object.keys(recipe)) {
    if (!RECIPE_FIELDS.has(field)) {
      addFinding(
        ctx,
        'error',
        'recipe.unsupported_field',
        field,
        `Recipe Protocol v1 does not support top-level field ${field}.`,
      );
    }
  }

  if (!hasOwn(recipe, '$schema')) {
    addFinding(
      ctx,
      'error',
      'recipe.missing_schema_ref',
      '$schema',
      `Recipe must set $schema to ${RECIPE_PROTOCOL_SCHEMA_URL}.`,
    );
  } else if (recipe.$schema !== RECIPE_PROTOCOL_SCHEMA_URL) {
    addFinding(
      ctx,
      'error',
      'recipe.unsupported_schema_ref',
      '$schema',
      `Recipe $schema must equal ${RECIPE_PROTOCOL_SCHEMA_URL}.`,
    );
  }

  validateOptionalStringField(ctx, recipe, 'description', 'description');
  validateOptionalStringField(ctx, recipe, 'title', 'title');
  if (hasOwn(recipe, 'paramsSchema')) {
    ctx.findings.push(...validateRecipeParamsSchema(recipe.paramsSchema).findings);
  }

  const proofTargetIds = hasOwn(recipe, 'proofTargets')
    ? validateProofTargets(ctx, recipe.proofTargets)
    : new Set<string>();
  const workflow = extractWorkflow(ctx, recipe);
  if (workflow) {
    validateWorkflowGraph(ctx, workflow);
    if (options?.lintIntent) {
      for (const [id, node] of Object.entries(workflow.nodes)) {
        if (typeof node.intent !== 'string') continue;
        const length = Array.from(node.intent.trim()).length;
        if (length > RECIPE_INTENT_WARN_LENGTH) {
          addFinding(
            ctx,
            length > RECIPE_INTENT_MAX_LENGTH ? 'error' : 'warning',
            'workflow.intent_too_long',
            `workflow.nodes.${id}.intent`,
            `Intent has ${length} characters. Use one plain sentence, preferably at most ${RECIPE_INTENT_WARN_LENGTH} characters, never more than ${RECIPE_INTENT_MAX_LENGTH}.`,
          );
        }
      }
    }
    validateRecipeCalls(ctx, workflow, {
      ...(options?.externalRecipeIds ? { externalRecipeIds: options.externalRecipeIds } : {}),
      skipResolution: options?.skipRecipeCallResolution === true,
    });
    const parentIds = new Set(
      Array.isArray(recipe.proofTargets)
        ? recipe.proofTargets
            .filter(isRecord)
            .filter((target) => isNonEmptyString(target.parentId))
            .map((target) => normalizeRecipeClaimId(String(target.parentId)))
        : [],
    );
    // The code review checks a `review` claim, so no node covers it (ADR-062 Amendment 18).
    const reviewIds = Array.isArray(recipe.proofTargets)
      ? recipe.proofTargets
          .filter(isRecord)
          .filter((target) => target.proofMode === 'review' && isNonEmptyString(target.id))
          .map((target) => normalizeRecipeClaimId(String(target.id)))
      : [];
    validateProofLinks(ctx, workflow.nodes, proofTargetIds, new Set([...parentIds, ...reviewIds]));
  }

  return finishResult(ctx);
}

function validateProofTargets(ctx: ReturnType<typeof createContext>, value: unknown): Set<string> {
  ctx.findings.push(...validateRecipeClaimDeclarations(value).findings);
  return new Set(
    Array.isArray(value)
      ? value
          .filter(isRecord)
          .filter((target) => isNonEmptyString(target.id))
          .map((target) => normalizeRecipeClaimId(String(target.id)))
      : [],
  );
}

function validateProofLinks(
  ctx: ReturnType<typeof createContext>,
  nodes: Record<string, Record<string, unknown>>,
  declared: Set<string>,
  uncovered: ReadonlySet<string>,
): void {
  const covered = new Set<string>();
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.action === 'call' && isRecord(node.claimBindings)) {
      for (const target of Object.values(node.claimBindings)) {
        if (isNonEmptyString(target) && declared.has(normalizeRecipeClaimId(target)))
          covered.add(normalizeRecipeClaimId(target));
        else
          addFinding(
            ctx,
            'error',
            'recipe.undeclared_proof_target',
            `workflow.nodes.${nodeId}.claimBindings`,
            'Claim binding must name a registered parent claim.',
          );
      }
    }
    if (!Array.isArray(node.proves)) continue;
    node.proves.forEach((target, index) => {
      if (!isNonEmptyString(target)) return;
      if (!declared.has(normalizeRecipeClaimId(target))) {
        addFinding(
          ctx,
          'error',
          'recipe.undeclared_proof_target',
          `workflow.nodes.${nodeId}.proves[${index}]`,
          `Proof target ${target} is not declared by recipe.proofTargets.`,
        );
      }
      covered.add(normalizeRecipeClaimId(target));
    });
  }
  for (const target of declared) {
    if (!covered.has(target) && !uncovered.has(target)) {
      addFinding(
        ctx,
        'error',
        'recipe.uncovered_proof_target',
        'proofTargets',
        `Proof target ${target} is not covered by any workflow node.`,
      );
    }
  }
}

function manifestActionContracts(manifest: unknown): Map<string, ManifestActionContract> {
  const contracts = new Map<string, ManifestActionContract>();
  if (!isRecord(manifest) || !isRecord(manifest.actions)) return contracts;
  for (const [name, entry] of Object.entries(manifest.actions)) {
    if (!isRecord(entry)) continue;
    contracts.set(name, actionContract(entry));
  }
  return contracts;
}

function actionContract(entry: Record<string, unknown>): ManifestActionContract {
  return {
    ...(isRecord(entry.schema) ? { schema: entry.schema } : {}),
    ...(Array.isArray(entry.adapters) ? { adapters: entry.adapters.filter(isNonEmptyString) } : {}),
    ...(isRecord(entry.adapter_schemas)
      ? {
          adapterSchemas: Object.fromEntries(
            Object.entries(entry.adapter_schemas).filter(
              (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
            ),
          ),
        }
      : {}),
    ...(Array.isArray(entry.result_cases)
      ? { resultCases: entry.result_cases.filter(isNonEmptyString) }
      : {}),
  };
}

function rebaseFinding(
  finding: RecipeValidationFinding,
  nodePath: string,
): RecipeValidationFinding {
  const suffix = finding.path === 'params' ? '' : finding.path.replace(/^params\.?/u, '.');
  return { ...finding, path: `${nodePath}${suffix}` };
}
