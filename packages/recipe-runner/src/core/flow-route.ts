import { isRecord, type RecipeInvocationNode, type RecipeInvocationTree } from '@farmslot/protocol';

const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export interface RecipeInvocationDecision {
  case: string | null;
  next: string | null;
}

/** Resolve a recorded local next through the prepared edges, not a guessed path prefix. */
export function recipeInvocationDecision(
  entry: unknown,
  node: RecipeInvocationNode | undefined,
  nodes: ReadonlyMap<string, RecipeInvocationNode>,
): RecipeInvocationDecision {
  if (!isRecord(entry)) return { case: null, next: null };
  const branch = typeof entry.case === 'string' ? entry.case : null;
  const edges = node
    ? [...new Set([node.next, node.default, ...Object.values(node.cases)].filter(identity))]
    : [];
  const recordedNext = typeof entry.next === 'string' ? entry.next : null;
  const matches =
    recordedNext === null
      ? []
      : edges.filter((id) => id === recordedNext || nodes.get(id)?.nodeId === recordedNext);
  const selected =
    branch !== null && node && Object.hasOwn(node.cases, branch) ? node.cases[branch] : undefined;
  return {
    case: branch,
    next: matches.length === 1 ? matches[0]! : recordedNext === null ? (selected ?? null) : null,
  };
}

export interface RecipeInvocationRouteIndex {
  record(entry: unknown): void;
  reachable(): ReadonlySet<string>;
}

/** Prepared edges with recorded decisions, shared by evidence and interval attribution. */
export function createRecipeInvocationRouteIndex(
  tree: RecipeInvocationTree,
): RecipeInvocationRouteIndex {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const choices = new Map<string, Set<string>>();
  const unresolved = new Set<string>();
  let cached: ReadonlySet<string> | undefined;
  return {
    record(entry) {
      if (!isRecord(entry) || typeof entry.nodeId !== 'string') return;
      const node = nodes.get(entry.nodeId);
      if (!node || !Object.keys(node.cases).length) return;
      const selected = recipeInvocationDecision(entry, node, nodes).next;
      if (selected === null) unresolved.add(node.id);
      else {
        const targets = choices.get(node.id) ?? new Set<string>();
        targets.add(selected);
        choices.set(node.id, targets);
      }
      cached = undefined;
    },
    reachable() {
      if (cached) return cached;
      const result = new Set<string>();
      const pending = [tree.rootId];
      while (pending.length) {
        const id = pending.pop()!;
        if (result.has(id)) continue;
        result.add(id);
        const node = nodes.get(id)!;
        const selected = !unresolved.has(id) ? choices.get(id) : undefined;
        for (const target of [
          node.entry,
          node.teardown,
          ...(selected ?? [node.next, node.default, ...Object.values(node.cases)]),
        ])
          if (target !== null) pending.push(target);
      }
      cached = result;
      return result;
    },
  };
}
