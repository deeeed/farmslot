// recipe-graph-data.ts — Maps Recipe Protocol v1 workflow JSON to FlowGraph types.
// Reuses FlowGraph/FlowGraphNode/FlowGraphEdge types from flow-graph-data.ts.
//
// Annotation encoding:
//   step node:    "action"
//   terminal end: "PASS", "FAIL", or "UNKNOWN"
//   terminal entry: "ENTRY"

import type {
  FlowGraph,
  FlowGraphEdge,
  FlowGraphNode,
  NodeKind,
} from '../flow-graph/flow-graph-data.js';

// ─── Recipe format types ───

interface RecipeNode {
  action: string;
  intent?: string;
  next?: string;
  cases?: Record<string, string>;
  default?: string;
  status?: string;
  ref?: string;
  target?: string;
  selector?: string;
  duration?: number;
  [key: string]: unknown;
}

interface RecipeWorkflow {
  entry: string;
  nodes: Record<string, RecipeNode>;
  teardown?: string;
}

// ─── Internal helpers ───

function normalizeRecipeInput(recipe: unknown): RecipeWorkflow | null {
  if (!recipe || typeof recipe !== 'object') return null;
  const r = recipe as Record<string, unknown>;

  // Recipe Protocol v1 document: { workflow: { entry, nodes } }
  if (r.workflow && typeof r.workflow === 'object') {
    const w = r.workflow as Record<string, unknown>;
    if (
      typeof w.entry === 'string' &&
      w.nodes &&
      typeof w.nodes === 'object' &&
      !Array.isArray(w.nodes)
    ) {
      return {
        entry: w.entry,
        nodes: w.nodes as Record<string, RecipeNode>,
        ...(typeof w.teardown === 'string' ? { teardown: w.teardown } : {}),
      };
    }
  }

  return null;
}

function getNodeTargets(node: RecipeNode): string[] {
  if (node.cases) {
    const targets: string[] = [];
    for (const target of Object.values(node.cases)) targets.push(target);
    if (node.default) targets.push(node.default);
    return targets;
  }
  if (node.action === 'end') return [];
  return node.next ? [node.next] : [];
}

function inferRecipeLane(
  nodeId: string,
  node: RecipeNode,
  teardownNodes: Set<string>,
): 'worker' | 'post' {
  if (node.action === 'end') return 'post';
  if (teardownNodes.has(nodeId)) return 'post';
  return 'worker';
}

function buildAnnotation(action: string, node: RecipeNode): string | undefined {
  if (action === 'end') return String(node.status ?? 'unknown').toUpperCase();
  return action || undefined;
}

function buildDescription(node: RecipeNode): string {
  const parts: string[] = [];
  if (node.intent) parts.push(node.intent);
  if (node.ref) parts.push(`ref: ${node.ref}`);
  if (node.target) parts.push(`target: ${node.target}`);
  if (node.selector) parts.push(`selector: ${node.selector}`);
  if (node.duration !== undefined) parts.push(`duration: ${node.duration}ms`);
  if (node.status) parts.push(`status: ${node.status}`);
  return parts.join(' | ');
}

/** BFS from entry — returns node IDs in visitation order, unreachable nodes appended last. */
function bfsOrder(
  entry: string,
  nodes: Record<string, RecipeNode>,
  appendUnreachable = true,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || !nodes[id]) continue;
    seen.add(id);
    order.push(id);
    for (const tgt of getNodeTargets(nodes[id])) {
      if (!seen.has(tgt)) queue.push(tgt);
    }
  }
  if (appendUnreachable) {
    // Invalid recipes remain inspectable instead of silently hiding nodes.
    for (const id of Object.keys(nodes)) {
      if (!seen.has(id)) order.push(id);
    }
  }
  return order;
}

// ─── Public API ───

/**
 * Convert a Recipe Protocol v1 document to a FlowGraph for `<recipe-graph>` rendering.
 */
export function recipeToFlowGraph(recipe: unknown): FlowGraph {
  let parsed = recipe;
  if (typeof recipe === 'string') {
    try {
      parsed = JSON.parse(recipe);
    } catch {
      /* fall through */
    }
  }

  const workflow = normalizeRecipeInput(parsed);
  if (!workflow) {
    return {
      nodes: [
        {
          id: 'error',
          kind: 'terminal',
          label: 'Invalid Recipe',
          lane: 'worker',
          annotation: 'FAIL',
        },
      ],
      edges: [],
    };
  }

  const { entry, nodes: recipeNodes } = workflow;
  const teardownNodes = workflow.teardown
    ? new Set(bfsOrder(workflow.teardown, recipeNodes, false))
    : new Set<string>();
  const orderedIds = bfsOrder(entry, recipeNodes);

  const nodes: FlowGraphNode[] = [];
  const edges: FlowGraphEdge[] = [];

  // ENTRY marker node
  nodes.push({
    id: '__entry__',
    kind: 'terminal',
    label: 'ENTRY',
    lane: 'orch',
    annotation: 'ENTRY',
  });
  if (recipeNodes[entry]) {
    edges.push({ from: '__entry__', to: entry, style: 'normal' });
  }

  for (const nodeId of orderedIds) {
    const node = recipeNodes[nodeId];
    const action = node.action || '';
    const kind: NodeKind = node.cases ? 'decision' : action === 'end' ? 'terminal' : 'step';

    const label = nodeId.length > 18 ? `${nodeId.slice(0, 16)}..` : nodeId;

    nodes.push({
      id: nodeId,
      kind,
      label,
      lane: inferRecipeLane(nodeId, node, teardownNodes),
      description: buildDescription(node),
      annotation: buildAnnotation(action, node),
    });

    // Generate edges from this node
    if (node.cases) {
      Object.entries(node.cases).forEach(([caseName, target]) => {
        edges.push({
          from: nodeId,
          to: target,
          label: caseName,
          style: 'conditional',
        });
      });
      if (node.default) {
        edges.push({
          from: nodeId,
          to: node.default,
          label: 'default',
          style: 'conditional',
        });
      }
    } else if (action !== 'end' && node.next) {
      edges.push({
        from: nodeId,
        to: node.next,
        style: 'normal',
      });
    }
  }

  return { nodes, edges };
}
