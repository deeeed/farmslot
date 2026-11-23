import type { RecipeInvocationAncestry, RecipeInvocationTree } from '@farmslot/protocol';

/** One ancestry index over the prepared tree, independent of execution history. */
export function buildRecipeInvocationAncestry(
  tree: RecipeInvocationTree,
): ReadonlyMap<string, RecipeInvocationAncestry> {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const index = new Map<string, RecipeInvocationAncestry>();
  const visit = (id: string): RecipeInvocationAncestry => {
    const cached = index.get(id);
    if (cached) return cached;
    const node = nodes.get(id)!;
    const parent = node.parentId === null ? null : visit(node.parentId);
    const value: RecipeInvocationAncestry = {
      parentId: node.parentId,
      depth: parent === null ? 0 : parent.depth + 1,
      breadcrumbs: [...(parent?.breadcrumbs ?? []), { id, label: node.label }],
    };
    index.set(id, value);
    return value;
  };
  for (const node of tree.nodes) visit(node.id);
  return index;
}
