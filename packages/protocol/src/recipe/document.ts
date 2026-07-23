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
  requireStringField,
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
  /** Retained for callers; Recipe v1 always requires the canonical schema ref. */
  requireSchemaRef?: boolean;
  skipRecipeCallResolution?: boolean;
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
      addFinding(
        ctx,
        'error',
        'recipe.action_not_declared_by_manifest',
        `${path}.action`,
        `Recipe action ${action} is not declared by the runner action manifest.`,
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

    if (isRecord(node.cases)) {
      if (!contract?.resultCases?.length) {
        addFinding(
          ctx,
          'error',
          'recipe.action_cases_not_declared',
          `${path}.cases`,
          `Action ${action} uses result cases but its manifest declares none.`,
        );
      } else {
        const allowed = new Set(contract.resultCases);
        for (const caseName of Object.keys(node.cases)) {
          if (!allowed.has(caseName)) {
            addFinding(
              ctx,
              'error',
              'recipe.action_case_not_declared',
              `${path}.cases.${caseName}`,
              `Case ${caseName} is not declared by action ${action}.`,
            );
          }
        }
      }
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

  requireStringField(ctx, recipe, 'description', 'description');
  validateOptionalStringField(ctx, recipe, 'title', 'title');
  if (hasOwn(recipe, 'paramsSchema')) {
    ctx.findings.push(...validateRecipeParamsSchema(recipe.paramsSchema).findings);
  }

  const proofTargetIds = validateProofTargets(ctx, recipe.proofTargets);
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
  if (value == null) return ids;
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
  if (!isRecord(manifest)) return contracts;
  if (isRecord(manifest.action_metadata)) {
    for (const [name, entry] of Object.entries(manifest.action_metadata)) {
      if (!isRecord(entry)) continue;
      contracts.set(name, actionContract(entry));
    }
  }
  if (Array.isArray(manifest.custom_actions)) {
    for (const entry of manifest.custom_actions) {
      if (isRecord(entry) && isNonEmptyString(entry.name)) {
        contracts.set(entry.name, actionContract(entry));
      }
    }
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
