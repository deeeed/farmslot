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
      refs.push(node.ref);
    }
  }
  return refs;
}

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
      refs.push(node.ref);
    }
  }
  return refs;
}

/**
 * Walks the recipe's workflow (nodes, lifecycle, startState) and inline flows,
 * following `call.ref`s transitively through the catalog, and returns only the
 * flow ids actually reachable from the recipe — never the whole library.
 */
function collectReachableFlowRefs(
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
    seeds.push(recipe.startState.ref);
  }
  if (isRecord(recipe.flows)) {
    for (const flow of Object.values(recipe.flows)) seeds.push(...callRefsInNodes(flowNodes(flow)));
  }

  const reachable = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const ref = queue.shift() as string;
    if (reachable.has(ref)) continue;
    reachable.add(ref);
    for (const child of callRefsInNodes(flowNodes(flowCatalog.get(ref)))) {
      if (!reachable.has(child)) queue.push(child);
    }
  }
  return reachable;
}

/**
 * Inlines the flows reachable from the recipe into `flows`, yielding a
 * self-contained recipe whose `call.ref`s resolve without the recipe library.
 * Only reachable flows are inlined (not the whole catalog), and `uses` is
 * dropped so `validateFlowCalls` verifies every ref is present inline rather
 * than short-circuiting on the external catalog. Returns the recipe unchanged
 * (same reference) when there is nothing to inline.
 */
export function buildResolvedRecipe(
  recipe: unknown,
  flowCatalog: ReadonlyMap<string, InlineFlow>,
): unknown {
  if (!isRecord(recipe) || flowCatalog.size === 0) return recipe;
  const refs = collectReachableFlowRefs(recipe, flowCatalog);
  // Preserve authored inline flows even if unreferenced, so the resolved recipe
  // is a superset of the authored one; reachability only adds catalog flows.
  if (isRecord(recipe.flows)) for (const ref of Object.keys(recipe.flows)) refs.add(ref);

  const flows: Record<string, unknown> = {};
  for (const ref of refs) {
    const flow = flowCatalog.get(ref);
    if (flow) flows[ref] = flow;
  }
  if (Object.keys(flows).length === 0) return recipe;

  // No-op when nothing external was composed: no `uses` to drop and the inlined
  // set is exactly the authored inline flows. recipe.json is already the full
  // composition, so avoid emitting a duplicate resolved recipe.
  const authoredFlows = isRecord(recipe.flows) ? recipe.flows : {};
  const hasUses = Array.isArray(recipe.uses) && recipe.uses.length > 0;
  const sameAsAuthored =
    !hasUses &&
    Object.keys(flows).length === Object.keys(authoredFlows).length &&
    Object.keys(flows).every((ref) => ref in authoredFlows);
  if (sameAsAuthored) return recipe;

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
