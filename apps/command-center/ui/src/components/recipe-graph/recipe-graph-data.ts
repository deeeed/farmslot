// recipe-graph-data.ts — Maps validate.workflow recipe JSON to FlowGraph types.
// Reuses FlowGraph/FlowGraphNode/FlowGraphEdge types from flow-graph-data.ts.
// FlowGraphNode is unchanged — annotation encodes recipe-specific display info.
//
// Annotation encoding:
//   step node:    "action" or "action → save_as"
//   terminal end: "PASS" or "FAIL"
//   terminal entry: "ENTRY"
//   decision (switch): undefined
//
// recipe-graph.ts parses "action → save_as" to render the save_as as an output badge.

import type {
  FlowGraph,
  FlowGraphEdge,
  FlowGraphNode,
  NodeKind,
} from '../flow-graph/flow-graph-data.js';

// ─── Recipe format types ───

interface RecipeNode {
  action: string;
  next?: string;
  save_as?: string;
  when?: unknown;
  unless?: unknown;
  cases?: Array<{ label?: string; next?: string; when?: unknown; index?: number }>;
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
}

// ─── Internal helpers ───

function normalizeRecipeInput(recipe: unknown): RecipeWorkflow | null {
  if (!recipe || typeof recipe !== 'object') return null;
  const r = recipe as Record<string, unknown>;

  // Validate-wrapped format: { validate: { workflow: { entry, nodes } } }
  if (r.validate && typeof r.validate === 'object') {
    const v = r.validate as Record<string, unknown>;
    if (v.workflow && typeof v.workflow === 'object') {
      const w = v.workflow as Record<string, unknown>;
      if (
        typeof w.entry === 'string' &&
        w.nodes &&
        typeof w.nodes === 'object' &&
        !Array.isArray(w.nodes)
      ) {
        return { entry: w.entry, nodes: w.nodes as Record<string, RecipeNode> };
      }
    }
  }

  // Full document format: { workflow: { entry, nodes } }
  if (r.workflow && typeof r.workflow === 'object') {
    const w = r.workflow as Record<string, unknown>;
    if (
      typeof w.entry === 'string' &&
      w.nodes &&
      typeof w.nodes === 'object' &&
      !Array.isArray(w.nodes)
    ) {
      return { entry: w.entry, nodes: w.nodes as Record<string, RecipeNode> };
    }
  }

  // Direct format: { entry, nodes }
  if (
    typeof r.entry === 'string' &&
    r.nodes &&
    typeof r.nodes === 'object' &&
    !Array.isArray(r.nodes)
  ) {
    return { entry: r.entry, nodes: r.nodes as Record<string, RecipeNode> };
  }

  return null;
}

function getNodeTargets(node: RecipeNode): string[] {
  if (node.action === 'switch') {
    const targets: string[] = [];
    (node.cases || []).forEach((c) => {
      if (c.next) targets.push(c.next);
    });
    if (node.default) targets.push(node.default);
    return targets;
  }
  if (node.action === 'end') return [];
  return node.next ? [node.next] : [];
}

/** DFS to find back edges — used to apply 'loop' edge style for retry cycles. */
function findBackEdges(entry: string, nodes: Record<string, RecipeNode>): Set<string> {
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const backEdges = new Set<string>();

  function dfs(id: string) {
    if (!nodes[id] || visited.has(id)) return;
    visited.add(id);
    onStack.add(id);
    for (const tgt of getNodeTargets(nodes[id])) {
      if (onStack.has(tgt)) {
        backEdges.add(`${id}::${tgt}`);
      } else {
        dfs(tgt);
      }
    }
    onStack.delete(id);
  }

  dfs(entry);
  return backEdges;
}

/** Mirrors workflow.js summarizeAssert — produces short human-readable edge labels. */
function summarizeAssert(spec: unknown): string {
  if (!spec || typeof spec !== 'object') return '';
  const s = spec as Record<string, unknown>;
  if (Array.isArray(s.all))
    return (s.all as unknown[]).map(summarizeAssert).filter(Boolean).join(' & ');
  if (Array.isArray(s.any))
    return (s.any as unknown[]).map(summarizeAssert).filter(Boolean).join(' | ');
  if (Array.isArray(s.none))
    return `not(${(s.none as unknown[]).map(summarizeAssert).filter(Boolean).join(' | ')})`;
  const op = String(s.operator || '');
  const field = String(s.field || '$');
  if ('value' in s) return `${field} ${op} ${JSON.stringify(s.value)}`;
  if ('values' in s) return `${field} ${op} [...]`;
  if ('pattern' in s) return `${field} ~/${String(s.pattern)}/`;
  return op || field;
}

function inferRecipeLane(nodeId: string, node: RecipeNode): 'orch' | 'worker' | 'post' {
  if (node.action === 'end') return 'post';
  if (/^(teardown|cleanup|finalize|done|after)-/i.test(nodeId)) return 'post';
  if (/^(setup|precondition|pre-condition|ensure|prime|gate|init)-/i.test(nodeId)) return 'orch';
  return 'worker';
}

function buildAnnotation(action: string, node: RecipeNode): string | undefined {
  if (action === 'switch') return undefined;
  if (action === 'end') return node.status === 'fail' ? 'FAIL' : 'PASS';
  return node.save_as ? `${action} → ${node.save_as}` : action || undefined;
}

function buildDescription(node: RecipeNode): string {
  const parts: string[] = [];
  if (node.ref) parts.push(`ref: ${node.ref}`);
  if (node.target) parts.push(`target: ${node.target}`);
  if (node.selector) parts.push(`selector: ${node.selector}`);
  if (node.duration !== undefined) parts.push(`duration: ${node.duration}ms`);
  if (node.save_as) parts.push(`save_as: ${node.save_as}`);
  if (node.status) parts.push(`status: ${node.status}`);
  return parts.join(' | ');
}

/** BFS from entry — returns node IDs in visitation order, unreachable nodes appended last. */
function bfsOrder(entry: string, nodes: Record<string, RecipeNode>): string[] {
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
  // Append any nodes not reachable from entry (shouldn't happen in valid recipes)
  for (const id of Object.keys(nodes)) {
    if (!seen.has(id)) order.push(id);
  }
  return order;
}

// ─── Public API ───

/**
 * Convert a validate.workflow recipe document to a FlowGraph for `<recipe-graph>` rendering.
 * Accepts JSON string or parsed object. Handles both document ({ workflow: {...} }) and
 * direct ({ entry, nodes }) formats.
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
  const backEdges = findBackEdges(entry, recipeNodes);
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
    const kind: NodeKind =
      action === 'switch' ? 'decision' : action === 'end' ? 'terminal' : 'step';

    const label = nodeId.length > 18 ? `${nodeId.slice(0, 16)}..` : nodeId;

    nodes.push({
      id: nodeId,
      kind,
      label,
      lane: inferRecipeLane(nodeId, node),
      description: buildDescription(node),
      annotation: buildAnnotation(action, node),
    });

    // Generate edges from this node
    if (action === 'switch') {
      (node.cases || []).forEach((c, i) => {
        if (!c.next) return;
        const lbl = c.label || summarizeAssert(c.when) || `case ${i + 1}`;
        const isBack = backEdges.has(`${nodeId}::${c.next}`);
        edges.push({
          from: nodeId,
          to: c.next,
          label: lbl,
          style: isBack ? 'loop' : 'conditional',
        });
      });
      if (node.default) {
        const isBack = backEdges.has(`${nodeId}::${node.default}`);
        edges.push({
          from: nodeId,
          to: node.default,
          label: 'default',
          style: isBack ? 'loop' : 'conditional',
        });
      }
    } else if (action !== 'end' && node.next) {
      const edgeLabel = node.when
        ? `when ${summarizeAssert(node.when)}`
        : node.unless
          ? `unless ${summarizeAssert(node.unless)}`
          : undefined;
      const isBack = backEdges.has(`${nodeId}::${node.next}`);
      const isCond = !!node.when || !!node.unless;
      edges.push({
        from: nodeId,
        to: node.next,
        label: edgeLabel,
        style: isBack ? 'loop' : isCond ? 'conditional' : 'normal',
      });
    }
  }

  return { nodes, edges };
}
