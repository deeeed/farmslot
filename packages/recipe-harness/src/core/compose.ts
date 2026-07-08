import { collectFlows, type InlineFlow } from './flows.js';
import { isRecord } from './json.js';
import {
  createEffectiveFlowCatalog,
  loadRecipeLibraries,
  type ResolvedLibraryFlow,
} from './library.js';
import type { RecipeLibrarySource, RecipeLogger } from './types.js';

/** Locate a flow definition's node map, tolerating both `{entry,nodes}` and `{workflow:{...}}`. */
function flowGraph(flow: unknown): { entry?: string; nodes?: Record<string, unknown> } {
  if (!isRecord(flow)) return {};
  const workflow = isRecord(flow.workflow) ? flow.workflow : flow;
  return {
    entry: typeof workflow.entry === 'string' ? workflow.entry : undefined,
    nodes: isRecord(workflow.nodes) ? (workflow.nodes as Record<string, unknown>) : undefined,
  };
}

/** Successor node ids of a graph node: `next` plus every `cases[].next`/`cases.<name>`. */
function nodeSuccessors(node: Record<string, unknown>): string[] {
  const targets: string[] = [];
  if (typeof node.next === 'string' && node.next.trim()) targets.push(node.next);
  const cases = node.cases;
  if (Array.isArray(cases)) {
    for (const entry of cases) {
      if (isRecord(entry) && typeof entry.next === 'string' && entry.next.trim()) {
        targets.push(entry.next);
      }
    }
  } else if (isRecord(cases)) {
    for (const target of Object.values(cases)) {
      if (typeof target === 'string' && target.trim()) targets.push(target);
    }
  }
  return targets;
}

/** Collect `call.ref`s on nodes reachable from `entry` (following next/cases), into `out`. */
function collectCallRefsFrom(
  entry: string | undefined,
  nodes: Record<string, unknown> | undefined,
  out: string[],
): void {
  if (!nodes || typeof entry !== 'string') return;
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes[id];
    if (!isRecord(node)) continue;
    if (node.action === 'call' && typeof node.ref === 'string' && node.ref.trim())
      out.push(node.ref);
    for (const successor of nodeSuccessors(node)) {
      if (!visited.has(successor)) queue.push(successor);
    }
  }
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
      refs.push(node.ref);
    }
  }
  return refs;
}

/**
 * Follows `call.ref`s transitively from the recipe's executed graph — the nodes
 * reachable from `validate.workflow.entry`, the setup/teardown lifecycle, and
 * `startState` — through the flow catalog, returning only the flow ids the
 * recipe actually reaches. Never the whole library, and never flows pulled in by
 * unreachable workflow nodes or unreferenced inline flows.
 */
function collectReachableFlowRefs(
  recipe: Record<string, unknown>,
  flowCatalog: ReadonlyMap<string, InlineFlow>,
): Set<string> {
  const seeds: string[] = [];
  const validate = isRecord(recipe.validate) ? recipe.validate : undefined;
  const workflow = validate && isRecord(validate.workflow) ? validate.workflow : undefined;
  if (workflow) {
    collectCallRefsFrom(
      typeof workflow.entry === 'string' ? workflow.entry : undefined,
      isRecord(workflow.nodes) ? workflow.nodes : undefined,
      seeds,
    );
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

  const reachable = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const ref = queue.shift() as string;
    if (reachable.has(ref)) continue;
    reachable.add(ref);
    const { entry, nodes } = flowGraph(flowCatalog.get(ref));
    const childRefs: string[] = [];
    collectCallRefsFrom(entry, nodes, childRefs);
    for (const child of childRefs) if (!reachable.has(child)) queue.push(child);
  }
  return reachable;
}

/**
 * Inlines the flows the recipe transitively reaches into `flows`, yielding a
 * self-contained recipe whose `call.ref`s resolve without the recipe library.
 * Only reachable flows are inlined (not the whole catalog, and not unreachable
 * authored inline flows), and `uses` is dropped so `validateFlowCalls` verifies
 * every ref is present inline rather than short-circuiting on the external
 * catalog. Returns the recipe unchanged (same reference) when nothing external
 * was composed — recipe.json is already the full composition.
 */
export function buildResolvedRecipe(
  recipe: unknown,
  flowCatalog: ReadonlyMap<string, InlineFlow>,
): unknown {
  if (!isRecord(recipe) || flowCatalog.size === 0) return recipe;
  const refs = collectReachableFlowRefs(recipe, flowCatalog);

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
