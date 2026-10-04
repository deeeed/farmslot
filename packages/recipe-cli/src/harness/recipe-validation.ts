// Static recipe validation for `run` and `call`: the manifest, the declared
// parameters, the platform's input checks on every node, called library
// recipes, and behavioral proof bindings.
import fs from 'node:fs';
import path from 'node:path';

import {
  applyRecipeParamDefaults,
  digestRecipeDocument,
  getRecipeActionManifestActionNames,
  normalizeRecipeRef,
  type RecipeActionManifestDocument,
  type RecipeValidationFinding,
  type RecipeValidationResult,
  validateRecipeParams,
  validateRecipeWithManifest,
} from '@farmslot/protocol';
import {
  loadRecipeLibraries,
  type RecipeLibrarySource,
  RecipeResolutionError,
  resolveRecipeDependencies,
  validateRecipeDependencyParams,
} from '@farmslot/recipe-runner';

import { harnessAdapters } from './adapters.js';
import type { RecipeCatalog } from './catalog.js';
import { harnessHost } from './host.js';
import {
  actionManifestPathOption,
  type CliOptions,
  isRecord,
  optionFlag,
  optionString,
  optionStrings,
  shellQuoteArg,
  targetPath,
} from './parse-args.js';
import { resolveLibrarySources, resolveRunRecipeArg } from './recipe-library.js';
import { type ProofDocument, validateRuntimeProofPlan } from './runtime-proof.js';

/** `value` with every exact `{{params.<path>}}` string replaced by the parameter it names, when present. */
export function resolveRecipeParamValue(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{params\.([A-Za-z0-9_.-]+)\}\}$/u.exec(value);
    if (!exact) return value;
    let current: unknown = params;
    for (const segment of exact[1]!.split('.')) {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) return value;
      current = current[segment];
    }
    return current;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveRecipeParamValue(entry, params));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveRecipeParamValue(entry, params)]),
  );
}

/** The adapter's `actions.inputFindings` on every workflow node, with parameters resolved. */
export function validateActionInputs(
  recipe: unknown,
  adapter: string,
  params?: Record<string, unknown>,
): RecipeValidationFinding[] {
  if (!isRecord(recipe) || !isRecord(recipe.workflow)) return [];
  const nodes = isRecord(recipe.workflow.nodes) ? recipe.workflow.nodes : undefined;
  if (!nodes) return [];
  const registry = harnessAdapters();
  const actions = registry.has(adapter) ? registry.get(adapter).actions : undefined;
  const findings: RecipeValidationFinding[] = [];
  for (const [nodeId, rawNode] of Object.entries(nodes)) {
    const node = params ? resolveRecipeParamValue(rawNode, params) : rawNode;
    if (!isRecord(node)) continue;
    findings.push(...(actions?.inputFindings?.(nodeId, node) ?? []));
  }
  return findings;
}

export async function validateRecipeAdapterAware(
  adapter: string,
  recipe: unknown,
  manifest: RecipeActionManifestDocument,
  librarySources?: RecipeLibrarySource[],
  rootRef?: string,
  params?: Record<string, unknown>,
  proof = false,
): Promise<RecipeValidationResult> {
  let externalRecipeIds: ReadonlySet<string> | undefined;
  let libraryResolution: Awaited<ReturnType<typeof loadRecipeLibraries>> | undefined;
  if (librarySources && librarySources.length > 0) {
    libraryResolution = await loadRecipeLibraries(librarySources, {
      adapter,
    });
    externalRecipeIds = new Set(libraryResolution.recipes.keys());
  }
  const validationOptions = externalRecipeIds !== undefined ? { externalRecipeIds } : undefined;
  const withManifest = validateRecipeWithManifest(recipe, manifest, validationOptions);
  const findings = [
    ...withManifest.findings,
    ...(withManifest.status === 'valid' && params
      ? validateRecipeWithManifest(
          resolveRecipeParamValue(recipe, params),
          manifest,
          validationOptions,
        ).findings
      : []),
    ...validateActionInputs(recipe, adapter, params),
  ];
  if (withManifest.status === 'valid' && isRecord(recipe) && libraryResolution) {
    try {
      const digest = digestRecipeDocument(recipe);
      const dependencies = resolveRecipeDependencies({
        rootRef: rootRef ?? `$root:${digest}`,
        root: recipe,
        rootSource: {
          kind: 'recipe-file',
          trust: 'unknown',
          name: rootRef ?? 'recipe file',
          digest,
        },
        recipes: libraryResolution.recipes,
      });
      if (params) {
        validateRecipeDependencyParams({
          root: recipe,
          params,
          recipes: dependencies.recipes,
        });
      }
      for (const dependency of dependencies.recipes.values()) {
        findings.push(
          ...validateRecipeWithManifest(dependency.document, manifest, validationOptions).findings,
        );
      }
      const validateDependencyInstances = (
        document: unknown,
        parentParams: Record<string, unknown>,
      ): void => {
        if (
          !isRecord(document) ||
          !isRecord(document.workflow) ||
          !isRecord(document.workflow.nodes)
        )
          return;
        for (const rawNode of Object.values(document.workflow.nodes)) {
          const node = resolveRecipeParamValue(rawNode, parentParams);
          if (!isRecord(node) || node.action !== 'call' || typeof node.ref !== 'string') continue;
          const dependency = dependencies.recipes.get(normalizeRecipeRef(node.ref));
          if (!dependency) continue;
          const supplied = isRecord(node.params) ? node.params : {};
          const childParams = applyRecipeParamDefaults(
            supplied,
            isRecord(dependency.document) ? dependency.document.paramsSchema : undefined,
          );
          findings.push(
            ...validateRecipeWithManifest(
              resolveRecipeParamValue(dependency.document, childParams),
              manifest,
              validationOptions,
            ).findings,
          );
          findings.push(...validateActionInputs(dependency.document, adapter, childParams));
          validateDependencyInstances(dependency.document, childParams);
        }
      };
      validateDependencyInstances(recipe, params ?? {});
      if (proof && !findings.some((finding) => finding.severity === 'error')) {
        findings.push(
          ...validateRuntimeProofPlan(
            recipe as unknown as ProofDocument,
            new Map(
              [...dependencies.recipes].map(([ref, dependency]) => [
                ref,
                dependency.document as unknown as ProofDocument,
              ]),
            ),
          ),
        );
      }
    } catch (error) {
      if (!(error instanceof RecipeResolutionError)) throw error;
      findings.push({
        severity: 'error',
        code: error.code,
        path: 'workflow',
        message: `${error.message} Next: ${error.userAction}`,
      });
    }
  }
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.length - errors;
  return {
    status: errors > 0 ? 'invalid' : 'valid',
    findings,
    summary: { errors, warnings },
  };
}

export interface RunRecipeStaticValidation {
  recipe: unknown;
  recipeFile: string;
  findings: RecipeValidationFinding[];
  errorCount: number;
  manifestOk: boolean;
  schemaValid: boolean;
  effectiveParams: Record<string, unknown>;
  /** The library sources this validation resolved — returned so callers (run's
   * runtime options) reuse them instead of re-resolving. */
  librarySources?: RecipeLibrarySource[];
  usageError?: { code: string; message: string };
}

export async function validateRunRecipeStatic(
  catalog: RecipeCatalog,
  recipeArg: string,
  adapter: string,
  options: CliOptions,
  params: Record<string, unknown> = {},
): Promise<RunRecipeStaticValidation> {
  // Resolve library sources first so resolveRunRecipeArg can probe personal and team
  // recipe dirs with correct precedence before the canonical packaged library.
  let librarySources = await resolveLibrarySources(catalog, optionStrings(options, 'library'));
  const resolved = await resolveRunRecipeArg(catalog, recipeArg, adapter, librarySources);
  const recipeFile = 'recipeFile' in resolved ? resolved.recipeFile : path.resolve(recipeArg);
  if ('recipeFile' in resolved && !resolved.ref) {
    librarySources = await resolveLibrarySources(
      catalog,
      optionStrings(options, 'library'),
      recipeFile,
    );
  }
  const empty = {
    recipe: undefined,
    recipeFile,
    findings: [],
    errorCount: 0,
    manifestOk: false,
    schemaValid: false,
    effectiveParams: params,
    librarySources,
  };
  if ('notFound' in resolved) {
    return {
      ...empty,
      usageError: {
        code: 'RECIPE_NOT_FOUND',
        message:
          resolved.notFound +
          (await actionInsteadOfRecipeHint(catalog, recipeArg, adapter, options)),
      },
    };
  }
  let recipe: unknown;
  try {
    recipe = JSON.parse(fs.readFileSync(recipeFile, 'utf8'));
  } catch (error) {
    return {
      ...empty,
      usageError: {
        code: 'RECIPE_UNPARSEABLE',
        message: `recipe is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const findings: RecipeValidationFinding[] = [];
  const { manifest } = await catalog.resolveActionManifest(
    adapter,
    optionString(options, 'actionManifest'),
    librarySources,
  );
  let manifestOk = true;
  try {
    await catalog.validateManifest(manifest);
  } catch (error) {
    manifestOk = false;
    findings.push({
      severity: 'error',
      code: 'manifest.invalid',
      path: actionManifestPathOption(options, adapter),
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let effectiveParams = params;
  if (isRecord(recipe)) {
    effectiveParams = applyRecipeParamDefaults(params, recipe.paramsSchema);
    findings.push(...validateRecipeParams(effectiveParams, recipe.paramsSchema).findings);
  }
  // Reuse librarySources already resolved above — no second resolution needed.
  const validation = manifestOk
    ? await validateRecipeAdapterAware(
        adapter,
        recipe,
        manifest,
        librarySources,
        resolved.ref,
        effectiveParams,
        optionFlag(options, 'proof'),
      )
    : {
        status: 'invalid' as const,
        findings: [],
        summary: { errors: 1, warnings: 0 },
      };
  findings.push(...validation.findings);

  const errorCount = findings.filter((finding) => finding.severity === 'error').length;
  return {
    recipe,
    recipeFile,
    findings,
    errorCount,
    manifestOk,
    schemaValid: validation.status === 'valid' && errorCount === 0,
    effectiveParams,
    librarySources,
  };
}

// A bare name that is one action, not a recipe: the `call` that runs it.
async function actionInsteadOfRecipeHint(
  catalog: RecipeCatalog,
  recipeArg: string,
  adapter: string,
  options: CliOptions,
): Promise<string> {
  if (recipeArg.includes('/') || recipeArg.includes(path.sep)) return '';
  try {
    const librarySources = await resolveLibrarySources(catalog, optionStrings(options, 'library'));
    const { manifest } = await catalog.resolveActionManifest(
      adapter,
      optionString(options, 'actionManifest'),
      librarySources,
    );
    const actions = getRecipeActionManifestActionNames(manifest);
    const matches = actions.includes(recipeArg)
      ? [recipeArg]
      : actions.filter((name) => name.split('.').pop() === recipeArg);
    if (matches.length !== 1) return '';
    const device = optionString(options, 'device');
    const actionManifest = optionString(options, 'actionManifest');
    const parts = [harnessHost().name, 'call', matches[0]!];
    parts.push('--adapter', adapter, '--target', shellQuoteArg(targetPath(options)));
    if (device) parts.push('--device', shellQuoteArg(device));
    if (actionManifest) parts.push('--action-manifest', shellQuoteArg(actionManifest));
    return ` This is an action, not a recipe. Use: ${parts.join(' ')}.`;
  } catch {
    return '';
  }
}
