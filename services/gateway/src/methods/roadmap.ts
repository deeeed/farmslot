import type {
  RoadmapDeleteParams,
  RoadmapGetParams,
  RoadmapListParams,
  RoadmapPromoteParams,
  RoadmapPromotionDraftGetParams,
  RoadmapPromotionDraftListParams,
  RoadmapPromotionDraftSaveParams,
  RoadmapPromptGetParams,
  RoadmapRefinementSessionGetParams,
  RoadmapRefineParams,
  RoadmapSaveParams,
} from '@farmslot/protocol';

import {
  deleteRoadmapItem,
  getRoadmapItem,
  getRoadmapPromotionDraft,
  getRoadmapPrompt,
  getRoadmapRefinementSession,
  listRoadmapItems,
  listRoadmapPromotionDrafts,
  promoteRoadmapItem,
  saveRoadmapItem,
  saveRoadmapPromotionDraft,
  startRoadmapRefinement,
} from '../roadmap/store.js';

export const roadmapList = (params: RoadmapListParams = {}) => listRoadmapItems(params);
export const roadmapGet = (params: RoadmapGetParams) => getRoadmapItem(params);
export const roadmapSave = (params: RoadmapSaveParams) => saveRoadmapItem(params);
export const roadmapDelete = (params: RoadmapDeleteParams) => deleteRoadmapItem(params);
export const roadmapRefine = (params: RoadmapRefineParams) => startRoadmapRefinement(params);
export const roadmapRefinementSessionGet = (params: RoadmapRefinementSessionGetParams) =>
  getRoadmapRefinementSession(params);
export const roadmapPromptGet = (params: RoadmapPromptGetParams) => getRoadmapPrompt(params);
export const roadmapPromotionDraftList = (params: RoadmapPromotionDraftListParams) =>
  listRoadmapPromotionDrafts(params);
export const roadmapPromotionDraftGet = (params: RoadmapPromotionDraftGetParams) =>
  getRoadmapPromotionDraft(params);
export const roadmapPromotionDraftSave = (params: RoadmapPromotionDraftSaveParams) =>
  saveRoadmapPromotionDraft(params);
export const roadmapPromote = (params: RoadmapPromoteParams) => promoteRoadmapItem(params);
