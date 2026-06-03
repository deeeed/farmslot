import { colors } from '../../styles/theme-tokens.js';

import type {
  Executor,
  FlowGraph,
  FlowGraphEdge,
  FlowGraphNode,
  GraphLane,
} from './flow-graph-data.js';

// ─── Layout constants (reuse run-pipeline vocabulary) ───

export const NODE_W = 110;
export const NODE_H = 36;
export const DECISION_SIZE = 16;
export const COL_GAP = 60;
export const ROW_GAP = 56;
export const LANE_LABEL_W = 55;
export const PAD_X = 16;
export const PAD_Y = 20;

export const LANE_COLORS: Record<GraphLane, string> = {
  orch: '#6366f1',
  worker: '#3b82f6',
  post: '#00ff88',
};

export const LANE_LABELS: Record<GraphLane, string> = {
  orch: 'ORCH',
  worker: 'WORKER',
  post: 'POST',
};

// Per-executor-type colors (dots, badges — 4 types)
export const EXECUTOR_COLORS: Record<Executor, string> = {
  gateway: '#6366f1', // indigo
  worker: '#f59e0b', // amber
  reviewer: '#06b6d4', // cyan
  human: '#00ff88', // green
};

// Executor-mode lanes (3 lanes — worker+reviewer collapse into RUNNER)
export type ExecutorLane = 'gateway' | 'runner' | 'human';
const EXEC_LANE_ORDER: ExecutorLane[] = ['gateway', 'runner', 'human'];
const EXEC_LANE_COLORS: Record<ExecutorLane, string> = {
  gateway: '#6366f1',
  runner: '#f59e0b',
  human: '#00ff88',
};
const EXEC_LANE_LABELS: Record<ExecutorLane, string> = {
  gateway: 'GATEWAY',
  runner: 'RUNNER',
  human: 'HUMAN',
};
export function executorToLane(exec: Executor): ExecutorLane {
  if (exec === 'worker' || exec === 'reviewer') return 'runner';
  return exec;
}

export type LaneMode = 'phase' | 'executor';

// ─── Layout engine ───

export interface LayoutNode {
  id: string;
  node: FlowGraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutEdge {
  edge: FlowGraphEdge;
  d: string;
}

export interface LaneRender {
  label: string;
  color: string;
  labelY: number;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  lanes: LaneRender[];
  laneSepYs: number[];
}

export function computeGraphLayout(graph: FlowGraph, laneMode: LaneMode = 'phase'): GraphLayout {
  // Grouping config based on lane mode
  const groupOrder: string[] =
    laneMode === 'executor' ? EXEC_LANE_ORDER : ['orch', 'worker', 'post'];
  const groupColorMap: Record<string, string> =
    laneMode === 'executor' ? EXEC_LANE_COLORS : LANE_COLORS;
  const groupLabelMap: Record<string, string> =
    laneMode === 'executor' ? EXEC_LANE_LABELS : LANE_LABELS;
  const getGroup = (n: FlowGraphNode): string =>
    laneMode === 'executor' ? executorToLane(n.executor ?? 'gateway') : n.lane;

  const groupsUsed = new Set<string>();
  const visibleNodes = graph.nodes.filter((n) => !n.skipped);
  const skippedNodes = graph.nodes.filter((n) => n.skipped);

  // Group nodes, preserving order
  const groupNodes: Record<string, FlowGraphNode[]> = {};
  for (const g of groupOrder) groupNodes[g] = [];

  for (const n of visibleNodes) {
    const g = getGroup(n);
    groupNodes[g].push(n);
    groupsUsed.add(g);
  }
  for (const n of skippedNodes) {
    const g = getGroup(n);
    groupNodes[g].push(n);
    groupsUsed.add(g);
  }

  const usedGroups = groupOrder.filter((g) => groupsUsed.has(g));

  // Compute group Y positions
  const groupStartY: Record<string, number> = {};
  let currentY = PAD_Y + 20;
  for (const g of usedGroups) {
    groupStartY[g] = currentY;
    const rows = Math.ceil(groupNodes[g].length / 6);
    currentY += rows * (NODE_H + ROW_GAP);
  }

  // Assign positions within each group
  const layoutNodes: LayoutNode[] = [];
  const nodeMap = new Map<string, LayoutNode>();

  for (const g of usedGroups) {
    const nodes = groupNodes[g];
    let col = 0;
    let row = 0;
    for (const n of nodes) {
      const isSmall = n.kind === 'decision';
      const w = isSmall ? DECISION_SIZE * 2 + 12 : n.kind === 'chain' ? NODE_W - 10 : NODE_W;
      const h = isSmall ? DECISION_SIZE * 2 + 12 : NODE_H;

      const x = LANE_LABEL_W + PAD_X + col * (NODE_W + COL_GAP) + (isSmall ? (NODE_W - w) / 2 : 0);
      const y = groupStartY[g] + row * (NODE_H + ROW_GAP) + (isSmall ? (NODE_H - h) / 2 : 0);

      const ln: LayoutNode = { id: n.id, node: n, x, y, w, h };
      layoutNodes.push(ln);
      nodeMap.set(n.id, ln);
      col++;
      if (col >= 6) {
        col = 0;
        row++;
      }
    }
  }

  // Compute edges
  const layoutEdges: LayoutEdge[] = [];
  for (const edge of graph.edges) {
    const src = nodeMap.get(edge.from);
    const tgt = nodeMap.get(edge.to);
    if (!src || !tgt) continue;
    layoutEdges.push({ edge, d: computeEdgePath(src, tgt, edge) });
  }

  // Compute group separators
  const laneSepYs: number[] = [];
  for (let i = 0; i < usedGroups.length - 1; i++) {
    const g = usedGroups[i];
    const nextG = usedGroups[i + 1];
    const rows = Math.ceil(groupNodes[g].length / 6);
    const bottomOfGroup = groupStartY[g] + rows * (NODE_H + ROW_GAP) - ROW_GAP / 2;
    const topOfNext = groupStartY[nextG] - 10;
    laneSepYs.push((bottomOfGroup + topOfNext) / 2);
  }

  // Compute total dimensions
  let maxX = 0,
    maxY = 0;
  for (const ln of layoutNodes) {
    maxX = Math.max(maxX, ln.x + ln.w);
    maxY = Math.max(maxY, ln.y + ln.h);
  }

  // Lane render info
  const lanes: LaneRender[] = usedGroups.map((g) => {
    const firstNode = layoutNodes.find((ln) => getGroup(ln.node) === g);
    return {
      label: groupLabelMap[g] ?? g.toUpperCase(),
      color: groupColorMap[g] ?? colors.textMuted,
      labelY: firstNode ? firstNode.y + firstNode.h / 2 : 0,
    };
  });

  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    width: maxX + PAD_X * 2 + 40,
    height: maxY + PAD_Y * 2 + 20,
    lanes,
    laneSepYs,
  };
}

// ─── Neighborhood helpers ───

export interface Neighborhood {
  preds: FlowGraphNode[];
  succs: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

export function getNeighborhood(graph: FlowGraph, nodeId: string): Neighborhood {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter((e) => e.from === nodeId || e.to === nodeId);
  const predIds = [...new Set(edges.filter((e) => e.to === nodeId).map((e) => e.from))];
  const succIds = [...new Set(edges.filter((e) => e.from === nodeId).map((e) => e.to))];
  return {
    preds: predIds.map((id) => nodeMap.get(id)!).filter(Boolean),
    succs: succIds.map((id) => nodeMap.get(id)!).filter(Boolean),
    edges,
  };
}

export function computeEdgePath(src: LayoutNode, tgt: LayoutNode, edge: FlowGraphEdge): string {
  // Self-loop (from->to same or loop back)
  const srcCx = src.x + src.w / 2;
  const srcCy = src.y + src.h / 2;
  const tgtCx = tgt.x + tgt.w / 2;
  const tgtCy = tgt.y + tgt.h / 2;

  // Loop edges arc above the nodes
  if (edge.style === 'loop') {
    const startX = src.x + src.w;
    const startY = srcCy;
    const endX = tgt.x;
    const endY = tgtCy;
    const arcY = Math.min(src.y, tgt.y) - 30;
    return `M ${startX} ${startY} C ${startX + 30} ${arcY}, ${endX - 30} ${arcY}, ${endX} ${endY}`;
  }

  // Same lane, left to right
  if (Math.abs(srcCy - tgtCy) < 10) {
    const startX = src.x + src.w;
    const y = srcCy;
    const endX = tgt.x;
    return `M ${startX} ${y} L ${endX} ${y}`;
  }

  // Cross-lane: bezier from bottom of src to top of tgt
  const x1 = srcCx;
  const y1 = src.y + src.h;
  const x2 = tgtCx;
  const y2 = tgt.y;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}
