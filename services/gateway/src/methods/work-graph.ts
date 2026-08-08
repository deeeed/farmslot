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

import { currentSessionOriginator, workAuthorshipNotice } from '../security/work-originator.js';
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
  workGraphRecordOriginator,
} from '../work-graph/store.js';

export const workGraphCreate = (params: WorkGraphCreateParams) =>
  createWorkGraph(params, currentSessionOriginator());
export const workGraphGet = (params: WorkGraphGetParams) => getWorkGraph(params);
export const workGraphList = (params: WorkGraphListRpcParams = {}) => listWorkGraphs(params);
export const workGraphAddNode = (params: WorkGraphAddNodeParams) =>
  addWorkGraphNode(params, currentSessionOriginator());
export const workGraphAddEdge = (params: WorkGraphAddEdgeParams) =>
  addWorkGraphEdge(params, currentSessionOriginator());
export const workGraphRemoveNode = (params: WorkGraphRemoveNodeParams) =>
  removeWorkGraphNode(params, currentSessionOriginator());
export const workGraphRemoveEdge = (params: WorkGraphRemoveEdgeParams) =>
  removeWorkGraphEdge(params, currentSessionOriginator());
export const workGraphUpdateNode = async (params: WorkGraphUpdateNodeParams) => {
  const previous = workGraphRecordOriginator(params.graphId);
  const originator = currentSessionOriginator();
  const result = await updateWorkGraphNode(params, originator);
  const authorshipNotice = workAuthorshipNotice(previous, originator);
  return { ...result, ...(authorshipNotice ? { authorshipNotice } : {}) };
};
export const workGraphActivate = (params: WorkGraphActivateParams) =>
  activateWorkGraph(params, currentSessionOriginator());
export const workGraphPause = (params: WorkGraphPauseParams) =>
  pauseWorkGraph(params, currentSessionOriginator());
export const workGraphGateResolve = (params: WorkGraphGateResolveParams) =>
  gateResolve(params, currentSessionOriginator());
export const workGraphSchedulerTick = (params: WorkGraphSchedulerTickParams = {}) =>
  schedulerTick(params);
