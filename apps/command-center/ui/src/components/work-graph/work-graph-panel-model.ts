import type { WorkGraphProjection } from '@farmslot/protocol';

import {
  resolveSelectedRowId,
  sortInventoryRows,
  type WorkInventorySortDirection,
} from '../shared/work-inventory-table.js';

export const WORK_GRAPH_SORT_KEYS = [
  'status',
  'project',
  'id',
  'title',
  'progress',
  'active',
  'blocked',
  'updated',
] as const;
export type WorkGraphSortKey = (typeof WORK_GRAPH_SORT_KEYS)[number];
export type WorkGraphSortDirection = WorkInventorySortDirection;

export interface WorkGraphInventoryStats {
  total: number;
  active: number;
  blocked: number;
  progress: number;
}

export function workGraphInventoryStats(graph: WorkGraphProjection): WorkGraphInventoryStats {
  const total = graph.nodes.length;
  let active = 0;
  let blocked = 0;
  let done = 0;
  for (const node of graph.nodes) {
    if (node.status === 'running' || node.status === 'ready' || node.status === 'queued') {
      active += 1;
    }
    if (
      node.status === 'waiting' ||
      node.status === 'failed' ||
      node.status === 'needs-attention' ||
      node.status === 'gated'
    ) {
      blocked += 1;
    }
    if (node.status === 'succeeded' || node.status === 'skipped') {
      done += 1;
    }
  }
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, active, blocked, progress };
}

function sortValue(graph: WorkGraphProjection, key: WorkGraphSortKey): string | number {
  const stats = workGraphInventoryStats(graph);
  switch (key) {
    case 'status':
      return graph.graph.status;
    case 'project':
      return graph.graph.project;
    case 'id':
      return graph.graph.id;
    case 'title':
      return graph.graph.title;
    case 'progress':
      return stats.progress;
    case 'active':
      return stats.active;
    case 'blocked':
      return stats.blocked;
    case 'updated':
      return graph.graph.updatedAt;
  }
}

export function sortWorkGraphInventory(
  graphs: readonly WorkGraphProjection[],
  key: WorkGraphSortKey,
  direction: WorkGraphSortDirection,
): WorkGraphProjection[] {
  return sortInventoryRows(
    graphs,
    (graph) => sortValue(graph, key),
    direction,
    (graph) => graph.graph.id,
  );
}

/**
 * Resolve selected graph id. A single remaining graph auto-selects, but callers
 * must still render the inventory/back affordance (see inventoryRetainsListAffordance).
 */
export function resolveWorkGraphSelection(
  graphIds: readonly string[],
  selectedId: string,
): { selectedId: string; autoSelected: boolean } {
  const previous = selectedId;
  const next = resolveSelectedRowId(graphIds, selectedId, { autoSelectSingle: true });
  const autoSelected = Boolean(next) && (!previous || previous !== next) && graphIds.length === 1;
  // Also treat "already selected the only graph" as auto-selected for the affordance.
  const singleAuto = graphIds.length === 1 && next === graphIds[0];
  return { selectedId: next, autoSelected: autoSelected || singleAuto };
}

export function defaultWorkGraphSortDirection(key: WorkGraphSortKey): WorkGraphSortDirection {
  return key === 'updated' || key === 'progress' || key === 'active' || key === 'blocked'
    ? 'desc'
    : 'asc';
}

/**
 * Resolve graph (and optional node) selection against the currently filtered
 * graph set. Prevents URL/hash from retaining a graph outside the project filter
 * while the canvas shows a different resolved graph.
 */
export function resolveWorkGraphHashSelection(options: {
  filteredGraphIds: readonly string[];
  rawGraphId: string;
  rawNodeId?: string;
  nodeExists?: (graphId: string, nodeId: string) => boolean;
}): { selectedGraphId: string; selectedNodeKey: string; changed: boolean } {
  // While graphs are still hydrating, keep the raw URL selection intact so a
  // microtask rewrite cannot delete deep-link params before data arrives.
  if (options.filteredGraphIds.length === 0) {
    const rawNodeId = options.rawNodeId?.trim() ?? '';
    return {
      selectedGraphId: options.rawGraphId,
      selectedNodeKey: options.rawGraphId && rawNodeId ? `${options.rawGraphId}:${rawNodeId}` : '',
      changed: false,
    };
  }
  const { selectedId, autoSelected } = resolveWorkGraphSelection(
    options.filteredGraphIds,
    options.rawGraphId,
  );
  let selectedNodeKey = '';
  const rawNodeId = options.rawNodeId?.trim() ?? '';
  if (selectedId && rawNodeId) {
    const ok = options.nodeExists
      ? options.nodeExists(selectedId, rawNodeId)
      : options.rawGraphId === selectedId;
    if (ok) selectedNodeKey = `${selectedId}:${rawNodeId}`;
  }
  const changed =
    selectedId !== options.rawGraphId ||
    Boolean(rawNodeId && !selectedNodeKey) ||
    // Auto-selected single graph still counts as a resolution change when the
    // raw URL had no graph id.
    (autoSelected && !options.rawGraphId && Boolean(selectedId));
  return { selectedGraphId: selectedId, selectedNodeKey, changed };
}
