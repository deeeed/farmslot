import type {
  RoadmapDeleteParams,
  RoadmapGetParams,
  RoadmapListParams,
  RoadmapPromoteParams,
  RoadmapRefineParams,
  RoadmapSaveParams,
} from '@farmslot/protocol';

import {
  deleteRoadmapItem,
  getRoadmapItem,
  listRoadmapItems,
  promoteRoadmapItem,
  saveRoadmapItem,
  startRoadmapRefinement,
} from '../roadmap/store.js';

export const roadmapList = (params: RoadmapListParams = {}) => listRoadmapItems(params);
export const roadmapGet = (params: RoadmapGetParams) => getRoadmapItem(params);
export const roadmapSave = (params: RoadmapSaveParams) => saveRoadmapItem(params);
export const roadmapDelete = (params: RoadmapDeleteParams) => deleteRoadmapItem(params);
export const roadmapRefine = (params: RoadmapRefineParams) => startRoadmapRefinement(params);
export const roadmapPromote = (params: RoadmapPromoteParams) => promoteRoadmapItem(params);
