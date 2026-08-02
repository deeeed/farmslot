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
import {
  getRecipeActionManifestActionNames,
  validateRecipeActionManifestDocument,
} from './manifest.js';
import { validateRecipeParams, validateRecipeParamsSchema } from './params.js';
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
  externalRecipeIds?: ReadonlySet<string>;
  skipRecipeCallResolution?: boolean;
  adapter?: string;
  adapterManifests?: ReadonlyArray<{ adapter: string; manifest: unknown }>;
}

export function validateResolvedRecipeActionNode(
  node: unknown,
  manifest: unknown,
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
  ctx.findings.push(...validateRecipeParams(getRecipeActionParams(node), contract.schema).findings);
  validateOfficialActionRelationships(ctx, node.action, node, 'node');
  return finishResult(ctx);
}

interface ManifestActionContract {
  schema?: Record<string, unknown>;
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
    if (!declaredActions.has(action)) {
      const supportingAdapters = options?.adapterManifests
        ?.filter(({ manifest: candidate }) =>
          getRecipeActionManifestActionNames(candidate).includes(action),
        )
        .map(({ adapter }) => adapter)
        .sort();
      const adapterMessage = options?.adapter
        ? `Adapter ${options.adapter} does not support recipe action ${action}.`
        : `Recipe action ${action} is not declared by the runner action manifest.`;
      const supportMessage = supportingAdapters?.length
        ? ` Supporting adapters: ${supportingAdapters.join(', ')}. Next: farmslot recipe run --adapter ${supportingAdapters[0]} <recipe>`
        : '';
      addFinding(
        ctx,
        'error',
        options?.adapter
          ? 'recipe.action_not_supported_by_adapter'
          : 'recipe.action_not_declared_by_manifest',
        `${path}.action`,
        `${adapterMessage}${supportMessage}`,
      );
      continue;
    }

    const contract = contracts.get(action);
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
    validateRecipeCalls(ctx, workflow, {
      ...(options?.externalRecipeIds ? { externalRecipeIds: options.externalRecipeIds } : {}),
      skipResolution: options?.skipRecipeCallResolution === true,
    });
    validateProofLinks(ctx, workflow.nodes, proofTargetIds);
  }

  return finishResult(ctx);
}

function validateProofTargets(ctx: ReturnType<typeof createContext>, value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_proof_targets',
      'proofTargets',
      'proofTargets must be an array.',
    );
    return ids;
  }
  value.forEach((target, index) => {
    const path = `proofTargets[${index}]`;
    if (!isRecord(target)) {
      addFinding(ctx, 'error', 'recipe.invalid_proof_target', path, `${path} must be an object.`);
      return;
    }
    for (const field of Object.keys(target)) {
      if (field !== 'id' && field !== 'claim') {
        addFinding(
          ctx,
          'error',
          'recipe.unsupported_proof_target_field',
          `${path}.${field}`,
          `Proof targets do not support ${field}.`,
        );
      }
    }
    if (!isNonEmptyString(target.id)) {
      addFinding(
        ctx,
        'error',
        'recipe.invalid_proof_target_id',
        `${path}.id`,
        'Proof target id must be a non-empty string.',
      );
    } else if (ids.has(target.id)) {
      addFinding(
        ctx,
        'error',
        'recipe.duplicate_proof_target',
        `${path}.id`,
        `Proof target ${target.id} is duplicated.`,
      );
    } else {
      ids.add(target.id);
    }
    if (!isNonEmptyString(target.claim)) {
      addFinding(
        ctx,
        'error',
        'recipe.invalid_proof_target_claim',
        `${path}.claim`,
        'Proof target claim must be a non-empty string.',
      );
    }
  });
  return ids;
}

function validateProofLinks(
  ctx: ReturnType<typeof createContext>,
  nodes: Record<string, Record<string, unknown>>,
  declared: Set<string>,
): void {
  const covered = new Set<string>();
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!Array.isArray(node.proves)) continue;
    node.proves.forEach((target, index) => {
      if (!isNonEmptyString(target)) return;
      if (!declared.has(target)) {
        addFinding(
          ctx,
          'error',
          'recipe.undeclared_proof_target',
          `workflow.nodes.${nodeId}.proves[${index}]`,
          `Proof target ${target} is not declared by recipe.proofTargets.`,
        );
      }
      covered.add(target);
    });
  }
  for (const target of declared) {
    if (!covered.has(target)) {
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
