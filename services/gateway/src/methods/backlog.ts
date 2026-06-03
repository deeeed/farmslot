import type {
  BacklogAutoDispatchTickParams,
  BacklogCreateParams,
  BacklogDeleteParams,
  BacklogEnqueueParams,
  BacklogListParams,
  BacklogMarkReadyParams,
  BacklogUpcomingParams,
  BacklogUpdateParams,
} from '@farmslot/protocol';

import {
  autoDispatchBacklogReady,
  createBacklogItem,
  deleteBacklogItem,
  enqueueBacklogItem,
  listBacklogItems,
  markBacklogItemReady,
  upcomingBacklogItems,
  updateBacklogItem,
} from '../backlog/store.js';

export const backlogCreate = (params: BacklogCreateParams) => createBacklogItem(params);
export const backlogList = (params: BacklogListParams = {}) => listBacklogItems(params);
export const backlogUpdate = (params: BacklogUpdateParams) => updateBacklogItem(params);
export const backlogDelete = (params: BacklogDeleteParams) => deleteBacklogItem(params.itemId);
export const backlogMarkReady = (params: BacklogMarkReadyParams) => markBacklogItemReady(params);
export const backlogEnqueue = (params: BacklogEnqueueParams) => enqueueBacklogItem(params);
export const backlogAutoDispatchTick = (params: BacklogAutoDispatchTickParams = {}) =>
  autoDispatchBacklogReady(params);
export const backlogUpcoming = (params: BacklogUpcomingParams = {}) => upcomingBacklogItems(params);
