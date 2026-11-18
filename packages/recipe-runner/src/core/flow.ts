import {
  isRecord,
  normalizeRecipeClaimId,
  normalizeRecipeRef,
  type RecipeFlowUpdate,
  type RecipeInvocationNode,
  type RecipeInvocationTree,
} from '@farmslot/protocol';

import { extractWorkflowGraph, reachableNodes } from './graph.js';
import type { ResolvedLibraryRecipe } from './library.js';

export interface BuildRecipeInvocationTreeInput {
  rootRef: string;
  root: Record<string, unknown>;
  /** The existing resolver's checked static dependency closure. */
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>;
  claimProjections?: ReadonlyMap<string, { proves?: readonly string[] }>;
}

/** Called once after the existing recipe/dependency/evidence resolution. */
export function buildRecipeInvocationTree(
  input: BuildRecipeInvocationTreeInput,
): RecipeInvocationTree {
  const rootId = '$root'; // Authored node IDs contain only letters, digits, underscore and hyphen.
  const nodes: RecipeInvocationNode[] = [];
  const visit = (
    document: Record<string, unknown>,
    ref: string,
    container: RecipeInvocationNode,
    prefix: string,
  ): void => {
    const graph = extractWorkflowGraph(document);
    const nodeIds = new Set([
      ...graph.mainNodeIds,
      ...(graph.teardownEntry ? reachableNodes(graph.nodes, graph.teardownEntry) : []),
    ]);
    container.entry = prefix + graph.entry;
    container.teardown = graph.teardownEntry ? prefix + graph.teardownEntry : null;
    container.children = [...nodeIds].map((id) => prefix + id);
    for (const nodeId of nodeIds) {
      const raw = graph.nodes[nodeId]!;
      const id = prefix + nodeId;
      const declared = input.claimProjections?.get(id)?.proves ?? raw.proves;
      const node: RecipeInvocationNode = {
        id,
        parentId: container.id,
        recipeRef: ref,
        nodeId,
        action: String(raw.action),
        label: typeof raw.intent === 'string' ? raw.intent : nodeId,
        children: [],
        entry: null,
        teardown: null,
        next: typeof raw.next === 'string' ? prefix + raw.next : null,
        cases: Object.fromEntries(
          isRecord(raw.cases)
            ? Object.entries(raw.cases)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                .map(([name, target]) => [name, prefix + target])
            : [],
        ),
        default: typeof raw.default === 'string' ? prefix + raw.default : null,
        claimIds: Array.isArray(declared)
          ? [
              ...new Set(
                declared
                  .filter((claim): claim is string => typeof claim === 'string')
                  .map(normalizeRecipeClaimId),
              ),
            ]
          : [],
      };
      nodes.push(node);
      if (node.action === 'call' && typeof raw.ref === 'string') {
        const childRef = normalizeRecipeRef(raw.ref);
        const child = input.recipes.get(childRef);
        if (!child) throw new Error(`Resolved recipe ${childRef} is missing`);
        visit(child.document, childRef, node, id + '/');
      }
    }
  };
  const root: RecipeInvocationNode = {
    id: rootId,
    parentId: null,
    recipeRef: input.rootRef,
    nodeId: null,
    action: 'call',
    label: typeof input.root.title === 'string' ? input.root.title : input.rootRef,
    children: [],
    entry: null,
    teardown: null,
    next: null,
    cases: {},
    default: null,
    claimIds: [],
  };
  nodes.push(root);
  visit(input.root, input.rootRef, root, '');
  return { version: 1, rootId, nodes };
}

export interface RecipeFlowProjection {
  /** A non-pass graph outcome makes subsequent cleanup totals unknown. */
  invalidate(): RecipeFlowUpdate;
  start(id: string, phase?: 'main' | 'teardown'): RecipeFlowUpdate;
  complete(id: string, ok: boolean, next?: string): RecipeFlowUpdate;
  finish(status: 'pass' | 'fail' | 'unknown', partial?: boolean): RecipeFlowUpdate;
  snapshot(): RecipeFlowUpdate;
}

/** Prepared route lengths plus bounded call ancestry; never reads execution history. */
export function createRecipeFlowProjection(
  tree: RecipeInvocationTree,
  recipeRunId: string,
  declaredPartial = false,
): RecipeFlowProjection {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const lengths = new Map<string, number | null>();
  const phases = new Map<string, 'main' | 'teardown'>();
  const pending = new Set<string>();
  const add = (...values: (number | null)[]): number | null => {
    let total = 0;
    for (const value of values) {
      if (value === null) return null;
      total += value;
    }
    return total;
  };
  const length = (id: string | null): number | null => {
    if (id === null) return 0;
    if (lengths.has(id)) return lengths.get(id)!;
    const node = nodes.get(id)!;
    const count =
      node.action === 'end'
        ? 0
        : Object.keys(node.cases).length
          ? null
          : add(
              node.action === 'call' ? add(length(node.entry), length(node.teardown)) : 1,
              length(node.next ?? node.default),
            );
    lengths.set(id, count);
    return count;
  };
  for (const node of tree.nodes) length(node.id);
  const outside = (node: RecipeInvocationNode): number | null => {
    if (!node.parentId) return 0;
    const parent = nodes.get(node.parentId)!;
    return add(
      phases.get(node.id) === 'teardown' ? 0 : length(parent.teardown),
      parent.parentId ? add(length(parent.next ?? parent.default), outside(parent)) : 0,
    );
  };
  const executable = (node: RecipeInvocationNode) =>
    node.action !== 'call' && node.action !== 'end';
  let completed = 0;
  let current = 0;
  let activeId: string | null = null;
  let interrupted = declaredPartial;
  let total = declaredPartial ? null : length(tree.rootId);
  const snapshot = (): RecipeFlowUpdate => ({
    version: 1,
    recipeRunId,
    rootId: tree.rootId,
    activeId,
    progress: {
      current,
      completed,
      total,
      remaining: total === null ? null : Math.max(0, total - completed),
      qualification: total === null ? 'unknown' : 'exact',
    },
  });
  return {
    invalidate() {
      interrupted = true;
      total = null;
      return snapshot();
    },
    start(id, phase = 'main') {
      const node = nodes.get(id)!;
      phases.set(id, phase);
      pending.add(id);
      activeId = id;
      current = completed + (executable(node) ? 1 : 0);
      total = interrupted ? null : add(completed, length(id), outside(node));
      return snapshot();
    },
    complete(id, ok, next) {
      const node = nodes.get(id)!;
      if (pending.delete(id) && executable(node)) completed += 1;
      current = completed;
      activeId = id;
      interrupted ||= !ok;
      total = interrupted ? null : add(completed, length(next ?? null), outside(node));
      return snapshot();
    },
    finish(status, partial = false) {
      activeId = null;
      current = completed;
      total = status === 'pass' && !partial && !declaredPartial ? completed : null;
      return snapshot();
    },
    snapshot,
  };
}
