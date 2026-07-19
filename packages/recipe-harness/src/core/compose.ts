import { normalizeRecipeFlowRef, type RecipeSourceProvenance } from '@farmslot/protocol';

import { collectFlows, type InlineFlow } from './flows.js';
import { isRecord } from './json.js';
import {
  createEffectiveFlowCatalog,
  loadRecipeLibraries,
  type ResolvedLibraryFlow,
} from './library.js';
import type { RecipeLibrarySource, RecipeLogger } from './types.js';

/** Locate a flow definition's node map, tolerating both `{entry,nodes}` and `{workflow:{...}}`. */
function flowNodes(flow: unknown): Record<string, unknown> | undefined {
  if (!isRecord(flow)) return undefined;
  const workflow = isRecord(flow.workflow) ? flow.workflow : flow;
  return isRecord(workflow.nodes) ? (workflow.nodes as Record<string, unknown>) : undefined;
}

/**
 * Every `call.ref` on any node in a node map. This mirrors `validateFlowCalls`,
 * which checks all nodes of every inline flow (not just graph-reachable ones), so
 * the resolved recipe must inline every referenced flow to be self-contained.
 */
function callRefsInNodes(nodes: Record<string, unknown> | undefined): string[] {
  if (!nodes) return [];
  const refs: string[] = [];
  for (const node of Object.values(nodes)) {
    if (
      isRecord(node) &&
      node.action === 'call' &&
      typeof node.ref === 'string' &&
      node.ref.trim()
    ) {
      refs.push(normalizeRecipeFlowRef(node.ref));
    }
  }
  return refs;
}

/** Lifecycle arrays (setup/teardown) always execute, so every `call` in them counts. */
function callRefsInLifecycle(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const refs: string[] = [];
  for (const node of list) {
    if (
      isRecord(node) &&
      node.action === 'call' &&
      typeof node.ref === 'string' &&
      node.ref.trim()
    ) {
      refs.push(normalizeRecipeFlowRef(node.ref));
    }
  }
  return refs;
}

/**
 * Computes the flow ids the resolved recipe must inline: every flow referenced by
 * any node of the recipe's workflow, its setup/teardown lifecycle, or `startState`,
 * then transitively every flow referenced by any node of those flows. Matches
 * `validateFlowCalls`' all-nodes check, so the result is exactly the set required
 * for the resolved recipe to be self-contained — never the whole library, and never
 * an unreferenced authored inline flow.
 */
function collectRequiredFlowRefs(
  recipe: Record<string, unknown>,
  flowCatalog: ReadonlyMap<string, InlineFlow>,
): Set<string> {
  const seeds: string[] = [];
  const validate = isRecord(recipe.validate) ? recipe.validate : undefined;
  const workflow = validate && isRecord(validate.workflow) ? validate.workflow : undefined;
  if (workflow) {
    seeds.push(...callRefsInNodes(isRecord(workflow.nodes) ? workflow.nodes : undefined));
    seeds.push(...callRefsInLifecycle(workflow.setup));
    seeds.push(...callRefsInLifecycle(workflow.teardown));
  }
  if (
    isRecord(recipe.startState) &&
    recipe.startState.action === 'call' &&
    typeof recipe.startState.ref === 'string'
  ) {
    seeds.push(normalizeRecipeFlowRef(recipe.startState.ref));
  }

  const required = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const ref = queue.shift() as string;
    if (required.has(ref)) continue;
    required.add(ref);
    for (const child of callRefsInNodes(flowNodes(flowCatalog.get(ref)))) {
      if (!required.has(child)) queue.push(child);
    }
  }
  return required;
}

/**
 * Inlines the flows the recipe requires into `flows`, yielding a self-contained
 * recipe whose `call.ref`s resolve without the recipe library. Only referenced
 * flows are inlined (not the whole catalog, and not unreferenced authored inline
 * flows), and `uses` is dropped so `validateFlowCalls` verifies every ref is
 * present inline rather than short-circuiting on the external catalog. Returns the
 * recipe unchanged (same reference) when nothing external was composed — recipe.json
 * is already the full composition.
 */
export function buildResolvedRecipe(
  recipe: unknown,
  flowCatalog: ReadonlyMap<string, InlineFlow>,
): unknown {
  if (!isRecord(recipe) || flowCatalog.size === 0) return recipe;
  const refs = collectRequiredFlowRefs(recipe, flowCatalog);

  const flows: Record<string, unknown> = {};
  for (const ref of refs) {
    const flow = flowCatalog.get(ref);
    if (flow) flows[ref] = flow;
  }
  if (Object.keys(flows).length === 0) return recipe;

  // Emit only when `uses`/library composition contributed — either a reached flow
  // is not an authored inline flow, or the recipe declared `uses` (now inlined and
  // dropped). Otherwise recipe.json is already self-contained.
  const authoredFlowKeys = new Set(isRecord(recipe.flows) ? Object.keys(recipe.flows) : []);
  const hasUses = Array.isArray(recipe.uses) && recipe.uses.length > 0;
  const composedExternal = Object.keys(flows).some((ref) => !authoredFlowKeys.has(ref));
  if (!composedExternal && !hasUses) return recipe;

  const { uses: _uses, ...rest } = recipe;
  void _uses;
  return { ...rest, flows };
}

export interface ComposeRecipeOptions {
  projectRoot: string;
  recipeDir: string;
  /** Library sources whose flows count as resolvable, mirroring run resolution. */
  librarySources?: RecipeLibrarySource[];
  logger?: RecipeLogger;
  recipeSource?: RecipeSourceProvenance;
}

export interface ComposeRecipeResult {
  /** The self-contained recipe with every reachable flow inlined under `flows`. */
  resolved: unknown;
  /** Flows inlined into the resolved recipe; 0 means nothing external was composed. */
  flowCount: number;
}

/**
 * Resolves a recipe's full flow composition — inline `flows`, `uses` catalogs,
 * and configured library sources, transitively — and returns the fully-composed,
 * self-contained recipe. Shared by the runner (executed path) and the CLI/CI
 * static resolve-check so both derive the same `resolved-recipe.json`.
 */
export async function composeRecipe(
  recipe: unknown,
  options: ComposeRecipeOptions,
): Promise<ComposeRecipeResult> {
  const recipeLocalFlows = await collectFlows(recipe, {
    projectRoot: options.projectRoot,
    recipeDir: options.recipeDir,
    recipeSource: options.recipeSource,
  });
  const resolution =
    options.librarySources && options.librarySources.length > 0
      ? await loadRecipeLibraries(options.librarySources, options.logger)
      : undefined;
  const usedLibraryFlows = new Map<string, ResolvedLibraryFlow>();
  const { catalog } = createEffectiveFlowCatalog(
    recipeLocalFlows,
    resolution,
    usedLibraryFlows,
    options.logger,
  );
  const resolved = buildResolvedRecipe(recipe, catalog);
  const flowCount =
    resolved !== recipe && isRecord(resolved) && isRecord(resolved.flows)
      ? Object.keys(resolved.flows).length
      : 0;
  return { resolved, flowCount };
}
