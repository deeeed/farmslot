import { isRecord } from './json.js';
import type { ActionResult } from './types.js';

export interface WorkflowGraph {
  entry: string;
  nodes: Record<string, Record<string, unknown>>;
  teardownEntry?: string;
  mainNodeCount: number;
  teardownNodeCount: number;
}

export function extractWorkflowGraph(recipe: unknown): WorkflowGraph {
  if (!isRecord(recipe) || !isRecord(recipe.workflow)) {
    throw new Error('Recipe must include workflow.');
  }
  const workflow = recipe.workflow;
  if (typeof workflow.entry !== 'string' || !workflow.entry || !isRecord(workflow.nodes)) {
    throw new Error('Recipe workflow must include entry and nodes.');
  }
  const nodes = Object.fromEntries(
    Object.entries(workflow.nodes).filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1]),
    ),
  );
  const teardownEntry = typeof workflow.teardown === 'string' ? workflow.teardown : undefined;
  const mainNodes = reachableNodes(nodes, workflow.entry);
  const teardownNodes = teardownEntry ? reachableNodes(nodes, teardownEntry) : new Set<string>();
  return {
    entry: workflow.entry,
    nodes,
    ...(teardownEntry ? { teardownEntry } : {}),
    mainNodeCount: mainNodes.size,
    teardownNodeCount: teardownNodes.size,
  };
}

export function resolveNextNode(
  node: Record<string, unknown>,
  result: Pick<ActionResult, 'case'>,
): string | undefined {
  if (result.case != null) {
    if (!isRecord(node.cases)) {
      throw new Error(
        `Action returned case ${result.case}, but the recipe node declares no cases.`,
      );
    }
    const target = node.cases[result.case];
    if (typeof target !== 'string') {
      throw new Error(`Action returned unmapped case ${result.case}.`);
    }
    return target;
  }
  if (isRecord(node.cases)) {
    if (typeof node.default !== 'string') throw new Error('Branch node has no default target.');
    return node.default;
  }
  return typeof node.next === 'string' ? node.next : undefined;
}

function reachableNodes(
  nodes: Record<string, Record<string, unknown>>,
  entry: string,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const nodeId = queue.shift();
    if (!nodeId || reachable.has(nodeId)) continue;
    const node = nodes[nodeId];
    if (!node) continue;
    reachable.add(nodeId);
    if (typeof node.next === 'string') queue.push(node.next);
    if (typeof node.default === 'string') queue.push(node.default);
    if (isRecord(node.cases)) {
      for (const target of Object.values(node.cases)) {
        if (typeof target === 'string') queue.push(target);
      }
    }
  }
  return reachable;
}
