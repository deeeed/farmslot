import {
  addFinding,
  BUILT_IN_UI_OBSERVER_SET,
  createContext,
  finishResult,
  isNonEmptyString,
  isRecord,
  type MutableValidationContext,
  OFFICIAL_ACTION_SET,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeValidationResult,
} from './common.js';
import { validateRecipeParams, validateRecipeParamsSchema } from './params.js';
import { RECIPE_EXECUTION_CAPABILITIES } from './trust.js';
import {
  getRecipeActionParams,
  isDynamicRecipeRef,
  validateRecipeActionCases,
  validateRecipeWorkflowNode,
} from './workflow.js';

const recipeExecutionCapabilitySet = new Set<string>(RECIPE_EXECUTION_CAPABILITIES);
const ACTION_MANIFEST_FIELDS = new Set(['$schema', 'actions', 'observers']);
const ACTION_ENTRY_FIELDS = new Set([
  'description',
  'schema',
  'adapters',
  'result_cases',
  'examples',
  'execution_capabilities',
]);
const OBSERVER_FIELDS = new Set(['ref', 'default_for']);

export function getRecipeActionManifestActionNames(manifest: unknown): string[] {
  if (!isRecord(manifest) || !isRecord(manifest.actions)) return [];
  return Object.keys(manifest.actions).sort();
}

function rejectUnknownFields(
  ctx: MutableValidationContext,
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  code: string,
): void {
  for (const field of Object.keys(value)) {
    if (allowed.has(field)) continue;
    addFinding(ctx, 'error', code, `${path}.${field}`, `${path} does not support ${field}.`);
  }
}

function validateActionCatalogEntry(
  ctx: MutableValidationContext,
  action: string,
  entry: unknown,
  path: string,
): void {
  if (!isRecord(entry)) {
    addFinding(ctx, 'error', 'action_manifest.invalid_action', path, `${path} must be an object.`);
    return;
  }
  rejectUnknownFields(
    ctx,
    entry,
    ACTION_ENTRY_FIELDS,
    path,
    'action_manifest.unsupported_action_field',
  );

  if (!isNonEmptyString(entry.description)) {
    addFinding(
      ctx,
      'error',
      'action_manifest.missing_description',
      `${path}.description`,
      `${path}.description must be a non-empty string.`,
    );
  }

  const schemaRequired = action !== 'call' && action !== 'end';
  if (!Object.hasOwn(entry, 'schema')) {
    if (schemaRequired) {
      addFinding(
        ctx,
        'error',
        'action_manifest.missing_schema',
        `${path}.schema`,
        `${path}.schema is required so action parameters can be validated before execution.`,
      );
    }
  } else if (!isRecord(entry.schema)) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_schema',
      `${path}.schema`,
      `${path}.schema must be a JSON Schema object when present.`,
    );
  } else {
    const schemaResult = validateRecipeParamsSchema(entry.schema);
    ctx.findings.push(
      ...schemaResult.findings.map((finding) => ({
        ...finding,
        path: `${path}.schema${finding.path === 'paramsSchema' ? '' : finding.path.replace(/^paramsSchema/u, '')}`,
      })),
    );
  }

  if (Object.hasOwn(entry, 'adapters')) {
    if (
      !Array.isArray(entry.adapters) ||
      entry.adapters.length === 0 ||
      entry.adapters.some((adapter) => !isNonEmptyString(adapter)) ||
      new Set(entry.adapters).size !== entry.adapters.length
    ) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_adapters',
        `${path}.adapters`,
        `${path}.adapters must be a non-empty array of unique adapter names.`,
      );
    }
  }

  if (Object.hasOwn(entry, 'result_cases')) {
    if (
      !Array.isArray(entry.result_cases) ||
      entry.result_cases.length === 0 ||
      entry.result_cases.some((value) => !isNonEmptyString(value)) ||
      new Set(entry.result_cases).size !== entry.result_cases.length
    ) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_result_cases',
        `${path}.result_cases`,
        `${path}.result_cases must be a non-empty array of unique case names.`,
      );
    }
  }

  if (Object.hasOwn(entry, 'execution_capabilities')) {
    if (
      !Array.isArray(entry.execution_capabilities) ||
      new Set(entry.execution_capabilities).size !== entry.execution_capabilities.length
    ) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_execution_capabilities',
        `${path}.execution_capabilities`,
        `${path}.execution_capabilities must be an array of unique capabilities.`,
      );
    } else {
      entry.execution_capabilities.forEach((capability, index) => {
        if (!isNonEmptyString(capability) || !recipeExecutionCapabilitySet.has(capability)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.unknown_execution_capability',
            `${path}.execution_capabilities[${index}]`,
            `${String(capability)} is not a Recipe Protocol execution capability.`,
          );
        }
      });
    }
  }

  if (!Array.isArray(entry.examples) || entry.examples.length === 0) {
    addFinding(
      ctx,
      'error',
      'action_manifest.missing_examples',
      `${path}.examples`,
      `${path}.examples must contain at least one copyable recipe node.`,
    );
    return;
  }
  entry.examples.forEach((example, index) => {
    const examplePath = `${path}.examples[${index}]`;
    if (!isRecord(example)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_example',
        examplePath,
        `${examplePath} must be a recipe node object.`,
      );
      return;
    }
    if (example.action !== action) {
      addFinding(
        ctx,
        'error',
        'action_manifest.example_action_mismatch',
        `${examplePath}.action`,
        `${examplePath}.action must equal ${action}.`,
      );
    }
    const nodeResult = validateRecipeWorkflowNode('example', example);
    ctx.findings.push(
      ...nodeResult.findings.map((finding) => ({
        ...finding,
        path: finding.path.replace(/^workflow\.nodes\.example/u, examplePath),
      })),
    );
    if (action === 'call' && isNonEmptyString(example.ref) && isDynamicRecipeRef(example.ref)) {
      addFinding(
        ctx,
        'error',
        'workflow.dynamic_call_ref',
        `${examplePath}.ref`,
        'call.ref must be static so dependencies can be resolved and trusted before execution.',
      );
    }
    const resultCases = Array.isArray(entry.result_cases)
      ? entry.result_cases.filter(isNonEmptyString)
      : undefined;
    const casesResult = validateRecipeActionCases(example, action, resultCases, examplePath);
    ctx.findings.push(...casesResult.findings);
    if (isRecord(entry.schema)) {
      const paramsResult = validateRecipeParams(getRecipeActionParams(example), entry.schema, {
        allowTemplates: true,
      });
      ctx.findings.push(
        ...paramsResult.findings.map((finding) => ({
          ...finding,
          path: `${examplePath}${finding.path === 'params' ? '' : finding.path.replace(/^params/u, '')}`,
        })),
      );
    }
  });
}

function validateObserver(
  ctx: MutableValidationContext,
  observer: unknown,
  index: number,
  declaredActions: ReadonlySet<string>,
  declaredObservers: Set<string>,
): void {
  const path = `observers[${index}]`;
  if (!isRecord(observer)) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_observer',
      path,
      `${path} must be an object.`,
    );
    return;
  }
  rejectUnknownFields(
    ctx,
    observer,
    OBSERVER_FIELDS,
    path,
    'action_manifest.unsupported_observer_field',
  );
  if (!isNonEmptyString(observer.ref)) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_observer_ref',
      `${path}.ref`,
      `${path}.ref must be a non-empty string.`,
    );
  } else {
    if (!BUILT_IN_UI_OBSERVER_SET.has(observer.ref) && !observer.ref.includes('.')) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_observer_ref',
        `${path}.ref`,
        `${observer.ref} must be a built-in UI observer ref or a namespaced custom ref.`,
      );
    }
    if (declaredObservers.has(observer.ref)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.duplicate_observer',
        `${path}.ref`,
        `${observer.ref} is declared more than once.`,
      );
    }
    declaredObservers.add(observer.ref);
  }
  if (
    !Array.isArray(observer.default_for) ||
    observer.default_for.length === 0 ||
    new Set(observer.default_for).size !== observer.default_for.length
  ) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_observer_default_for',
      `${path}.default_for`,
      `${path}.default_for must be a non-empty array of unique declared actions.`,
    );
    return;
  }
  observer.default_for.forEach((action, actionIndex) => {
    if (
      !isNonEmptyString(action) ||
      !declaredActions.has(action) ||
      action === 'call' ||
      action === 'end'
    ) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_observer_default_for',
        `${path}.default_for[${actionIndex}]`,
        `${path}.default_for[${actionIndex}] must reference a declared executable action.`,
      );
    }
  });
}

export function validateRecipeActionManifestDocument(manifest: unknown): RecipeValidationResult {
  const ctx = createContext();
  if (!isRecord(manifest)) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_document',
      '$',
      'Recipe action manifest must be a JSON object.',
    );
    return finishResult(ctx);
  }
  rejectUnknownFields(
    ctx,
    manifest,
    ACTION_MANIFEST_FIELDS,
    '$',
    'action_manifest.unsupported_field',
  );
  if (manifest.$schema !== RECIPE_ACTION_MANIFEST_SCHEMA_URL) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_schema_ref',
      '$schema',
      `$schema must equal ${RECIPE_ACTION_MANIFEST_SCHEMA_URL}.`,
    );
  }
  if (!isRecord(manifest.actions) || Object.keys(manifest.actions).length === 0) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_actions',
      'actions',
      'actions must be a non-empty object keyed by action name.',
    );
    return finishResult(ctx);
  }

  const declaredActions = new Set<string>();
  for (const [action, entry] of Object.entries(manifest.actions)) {
    const path = `actions.${action}`;
    if (!OFFICIAL_ACTION_SET.has(action) && !/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/u.test(action)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.custom_action_not_namespaced',
        path,
        `${action} must be an official action or a lowercase namespaced custom action.`,
      );
    }
    declaredActions.add(action);
    validateActionCatalogEntry(ctx, action, entry, path);
    if (
      !OFFICIAL_ACTION_SET.has(action) &&
      (!isRecord(entry) || !Object.hasOwn(entry, 'execution_capabilities'))
    ) {
      addFinding(
        ctx,
        'error',
        'action_manifest.missing_execution_capabilities',
        `${path}.execution_capabilities`,
        'Custom actions must explicitly declare execution_capabilities, including an empty array for read-only actions.',
      );
    }
  }

  if (Object.hasOwn(manifest, 'observers')) {
    if (!Array.isArray(manifest.observers)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_observers',
        'observers',
        'observers must be an array when present.',
      );
    } else {
      const declaredObservers = new Set<string>();
      manifest.observers.forEach((observer, index) =>
        validateObserver(ctx, observer, index, declaredActions, declaredObservers),
      );
    }
  }
  return finishResult(ctx);
}
