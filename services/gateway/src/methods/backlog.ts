import type {
  BacklogArchiveParams,
  BacklogAutoDispatchTickParams,
  BacklogCreateParams,
  BacklogDeleteParams,
  BacklogDequeueParams,
  BacklogEnqueueParams,
  BacklogListParams,
  BacklogMarkReadyParams,
  BacklogSpecGetParams,
  BacklogUpcomingParams,
  BacklogUpdateParams,
} from '@farmslot/protocol';

import {
  archiveBacklogItem,
  autoDispatchBacklogReady,
  createBacklogItem,
  deleteBacklogItem,
  dequeueBacklogItem,
  enqueueBacklogItem,
  getBacklogSpec,
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
export const backlogArchive = (params: BacklogArchiveParams) => archiveBacklogItem(params);
export const backlogEnqueue = (params: BacklogEnqueueParams) => enqueueBacklogItem(params);
export const backlogDequeue = (params: BacklogDequeueParams) => dequeueBacklogItem(params);
export const backlogAutoDispatchTick = (params: BacklogAutoDispatchTickParams = {}) =>
  autoDispatchBacklogReady(params);
export const backlogUpcoming = (params: BacklogUpcomingParams = {}) => upcomingBacklogItems(params);
export const backlogSpecGet = (params: BacklogSpecGetParams) => getBacklogSpec(params);
