import type { OkResult } from '../contracts/index.js';
import type {
  GraphGateResolution,
  WorkGraphAddEdgeInput,
  WorkGraphAddNodeInput,
  WorkGraphCreateInput,
  WorkGraphListParams,
  WorkGraphProjection,
  WorkGraphUpdateNodeInput,
} from '../contracts/work-graph.js';

import { Methods } from './registry.js';

export const WorkGraphMethods = {
  create: Methods.WORK_GRAPH_CREATE,
  get: Methods.WORK_GRAPH_GET,
  list: Methods.WORK_GRAPH_LIST,
  addNode: Methods.WORK_GRAPH_ADD_NODE,
  addEdge: Methods.WORK_GRAPH_ADD_EDGE,
  updateNode: Methods.WORK_GRAPH_UPDATE_NODE,
  activate: Methods.WORK_GRAPH_ACTIVATE,
  pause: Methods.WORK_GRAPH_PAUSE,
  gateResolve: Methods.WORK_GRAPH_GATE_RESOLVE,
  schedulerTick: Methods.WORK_GRAPH_SCHEDULER_TICK,
} as const;

export interface WorkGraphCreateParams extends WorkGraphCreateInput {}
export interface WorkGraphCreateResult {
  graph: WorkGraphProjection;
}

export interface WorkGraphGetParams {
  graphId: string;
}
export interface WorkGraphGetResult {
  graph: WorkGraphProjection;
}

export interface WorkGraphListResult {
  graphs: WorkGraphProjection[];
}
export interface WorkGraphListRpcParams extends WorkGraphListParams {}

export interface WorkGraphAddNodeParams extends WorkGraphAddNodeInput {}
export interface WorkGraphAddNodeResult {
  graph: WorkGraphProjection;
}

export interface WorkGraphAddEdgeParams extends WorkGraphAddEdgeInput {}
export interface WorkGraphAddEdgeResult {
  graph: WorkGraphProjection;
}

export interface WorkGraphUpdateNodeParams extends WorkGraphUpdateNodeInput {}
export interface WorkGraphUpdateNodeResult {
  graph: WorkGraphProjection;
}

export interface WorkGraphActivateParams {
  graphId: string;
}
export interface WorkGraphActivateResult {
  graph: WorkGraphProjection;
}

export interface WorkGraphPauseParams {
  graphId: string;
}
export interface WorkGraphPauseResult {
  graph: WorkGraphProjection;
}

export interface WorkGraphGateResolveParams extends Omit<GraphGateResolution, 'resolvedAt'> {}
export interface WorkGraphGateResolveResult {
  graph: WorkGraphProjection;
}

export interface WorkGraphSchedulerTickParams {
  graphId?: string;
}
export interface WorkGraphSchedulerTickResult extends OkResult {
  graphs: WorkGraphProjection[];
}
