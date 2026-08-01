import {
  type BacklogArchiveParams,
  type BacklogAutoDispatchTickParams,
  type BacklogCloseShippedParams,
  type BacklogCreateParams,
  type BacklogDeleteParams,
  type BacklogDequeueParams,
  type BacklogEnqueueParams,
  type BacklogListParams,
  type BacklogMarkReadyParams,
  type BacklogReconcileRunParams,
  type BacklogRefineParams,
  type BacklogRefinementSessionGetParams,
  type BacklogSpecGetParams,
  type BacklogUpcomingParams,
  type BacklogUpdateParams,
  Events,
} from '@farmslot/protocol';

import {
  getBacklogRefinementSession,
  startBacklogRefinement,
} from '../backlog/refinement.js';
import {
  archiveBacklogItem,
  autoDispatchBacklogReady,
  closeShippedBacklogItem,
  createBacklogItem,
  deleteBacklogItem,
  dequeueBacklogItem,
  enqueueBacklogItem,
  getBacklogSpec,
  listBacklogItems,
  markBacklogItemReady,
  reconcileBacklogRun,
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
export const backlogReconcileRun = async (
  params: BacklogReconcileRunParams,
  emit: (event: string, payload: unknown) => void,
) => {
  const result = await reconcileBacklogRun(params);
  emit(Events.RUN_UPDATED, { run: result.run });
  return result;
};
export const backlogCloseShipped = (params: BacklogCloseShippedParams) =>
  closeShippedBacklogItem(params);
export const backlogRefine = (params: BacklogRefineParams) => startBacklogRefinement(params);
export const backlogRefinementSessionGet = (params: BacklogRefinementSessionGetParams) =>
  getBacklogRefinementSession(params);
