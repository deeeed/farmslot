import type { WorkEdge, WorkGraphProjection, WorkNode } from '@farmslot/protocol';

export const WORK_GRAPH_NODE_WIDTH = 238;
export const WORK_GRAPH_NODE_HEIGHT = 118;
export const WORK_GRAPH_COLUMN_GAP = 88;
export const WORK_GRAPH_ROW_GAP = 28;
export const WORK_GRAPH_PAD_X = 32;
export const WORK_GRAPH_PAD_Y = 58;

export interface WorkGraphLayoutNode {
  id: string;
  node: WorkNode;
  stage: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WorkGraphLayoutEdge {
  edge: WorkEdge;
  d: string;
  labelX: number;
  labelY: number;
}

export interface WorkGraphStage {
  index: number;
  label: string;
  x: number;
  width: number;
}

export interface WorkGraphLayout {
  nodes: WorkGraphLayoutNode[];
  edges: WorkGraphLayoutEdge[];
  stages: WorkGraphStage[];
  width: number;
  height: number;
}

const STATUS_RANKS: Record<string, number> = {
  'needs-attention': 0,
  failed: 1,
  waiting: 2,
  gated: 3,
  running: 4,
  queued: 5,
  ready: 6,
  planned: 7,
  skipped: 8,
  succeeded: 9,
};

function statusRank(node: WorkNode): number {
  return STATUS_RANKS[node.status] ?? 10;
}

function edgePath(from: WorkGraphLayoutNode, to: WorkGraphLayoutNode): WorkGraphLayoutEdge['d'] {
  const sx = from.x + from.w;
  const sy = from.y + from.h / 2;
  const tx = to.x;
  const ty = to.y + to.h / 2;
  const mx = (sx + tx) / 2;

  if (Math.abs(sy - ty) < 8) return `M ${sx} ${sy} L ${tx} ${ty}`;
  return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
}

function stageLabel(index: number): string {
  if (index === 0) return 'No prerequisites';
  return `Depends on depth ${index}`;
}

export function computeWorkGraphLayout(graph: WorkGraphProjection): WorkGraphLayout {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const inbound = new Map(graph.nodes.map((node) => [node.id, [] as WorkEdge[]]));
  for (const edge of graph.edges) {
    if (
      edge.blocks !== 'completion' &&
      nodeMap.has(edge.fromNodeId) &&
      nodeMap.has(edge.toNodeId)
    ) {
      inbound.get(edge.toNodeId)?.push(edge);
    }
  }

  const memo = new Map<string, number>();
  const depthFor = (nodeId: string, path = new Set<string>()): number => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) return cached;
    if (path.has(nodeId)) return 0;

    path.add(nodeId);
    const parents = inbound.get(nodeId) ?? [];
    const depth = parents.length
      ? 1 + Math.max(...parents.map((edge) => depthFor(edge.fromNodeId, path)))
      : 0;
    path.delete(nodeId);
    memo.set(nodeId, depth);
    return depth;
  };

  const columns = new Map<number, WorkNode[]>();
  for (const node of graph.nodes) {
    const depth = depthFor(node.id);
    const list = columns.get(depth) ?? [];
    list.push(node);
    columns.set(depth, list);
  }

  const nodes: WorkGraphLayoutNode[] = [];
  for (const [stage, column] of [...columns.entries()].sort(([a], [b]) => a - b)) {
    [...column]
      .sort((a, b) => statusRank(a) - statusRank(b) || a.id.localeCompare(b.id))
      .forEach((node, row) => {
        nodes.push({
          id: node.id,
          node,
          stage,
          row,
          x: WORK_GRAPH_PAD_X + stage * (WORK_GRAPH_NODE_WIDTH + WORK_GRAPH_COLUMN_GAP),
          y: WORK_GRAPH_PAD_Y + row * (WORK_GRAPH_NODE_HEIGHT + WORK_GRAPH_ROW_GAP),
          w: WORK_GRAPH_NODE_WIDTH,
          h: WORK_GRAPH_NODE_HEIGHT,
        });
      });
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: WorkGraphLayoutEdge[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.fromNodeId);
    const to = byId.get(edge.toNodeId);
    if (!from || !to) continue;
    const sx = from.x + from.w;
    const sy = from.y + from.h / 2;
    const tx = to.x;
    const ty = to.y + to.h / 2;
    edges.push({ edge, d: edgePath(from, to), labelX: (sx + tx) / 2, labelY: (sy + ty) / 2 - 8 });
  }

  const stageIndexes = [...columns.keys()].sort((a, b) => a - b);
  const maxStage = Math.max(0, ...stageIndexes);
  const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
  const width =
    WORK_GRAPH_PAD_X * 2 +
    (maxStage + 1) * WORK_GRAPH_NODE_WIDTH +
    maxStage * WORK_GRAPH_COLUMN_GAP;
  const height =
    WORK_GRAPH_PAD_Y * 2 + maxRows * WORK_GRAPH_NODE_HEIGHT + (maxRows - 1) * WORK_GRAPH_ROW_GAP;
  const stages = stageIndexes.map((index) => ({
    index,
    label: stageLabel(index),
    x: WORK_GRAPH_PAD_X + index * (WORK_GRAPH_NODE_WIDTH + WORK_GRAPH_COLUMN_GAP),
    width: WORK_GRAPH_NODE_WIDTH,
  }));

  return { nodes, edges, stages, width, height };
}
