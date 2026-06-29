import type {
  WorkGraphActivateParams,
  WorkGraphAddEdgeParams,
  WorkGraphAddNodeParams,
  WorkGraphCreateParams,
  WorkGraphGateResolveParams,
  WorkGraphGetParams,
  WorkGraphListRpcParams,
  WorkGraphPauseParams,
  WorkGraphRemoveEdgeParams,
  WorkGraphRemoveNodeParams,
  WorkGraphSchedulerTickParams,
  WorkGraphUpdateNodeParams,
} from '@farmslot/protocol';

import {
  activateWorkGraph,
  addWorkGraphEdge,
  addWorkGraphNode,
  createWorkGraph,
  gateResolve,
  getWorkGraph,
  listWorkGraphs,
  pauseWorkGraph,
  removeWorkGraphEdge,
  removeWorkGraphNode,
  schedulerTick,
  updateWorkGraphNode,
} from '../work-graph/store.js';

export const workGraphCreate = (params: WorkGraphCreateParams) => createWorkGraph(params);
export const workGraphGet = (params: WorkGraphGetParams) => getWorkGraph(params);
export const workGraphList = (params: WorkGraphListRpcParams = {}) => listWorkGraphs(params);
export const workGraphAddNode = (params: WorkGraphAddNodeParams) => addWorkGraphNode(params);
export const workGraphAddEdge = (params: WorkGraphAddEdgeParams) => addWorkGraphEdge(params);
export const workGraphRemoveNode = (params: WorkGraphRemoveNodeParams) =>
  removeWorkGraphNode(params);
export const workGraphRemoveEdge = (params: WorkGraphRemoveEdgeParams) =>
  removeWorkGraphEdge(params);
export const workGraphUpdateNode = (params: WorkGraphUpdateNodeParams) =>
  updateWorkGraphNode(params);
export const workGraphActivate = (params: WorkGraphActivateParams) => activateWorkGraph(params);
export const workGraphPause = (params: WorkGraphPauseParams) => pauseWorkGraph(params);
export const workGraphGateResolve = (params: WorkGraphGateResolveParams) => gateResolve(params);
export const workGraphSchedulerTick = (params: WorkGraphSchedulerTickParams = {}) =>
  schedulerTick(params);
