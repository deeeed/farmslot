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
  type BacklogRefinementSessionGetParams,
  type BacklogRefineParams,
  type BacklogSpecGetParams,
  type BacklogUpcomingParams,
  type BacklogUpdateParams,
  Events,
} from '@farmslot/protocol';

import { getBacklogRefinementSession, startBacklogRefinement } from '../backlog/refinement.js';
import { archiveFailedRunsBeforeEnqueue } from '../backlog/standing-rerun.js';
import {
  archiveBacklogItem,
  autoDispatchBacklogReady,
  backlogRecordOriginator,
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
import { currentSessionOriginator, workAuthorshipNotice } from '../security/work-originator.js';
import { schedulerTick } from '../work-graph/store.js';

export const backlogCreate = (params: BacklogCreateParams) =>
  createBacklogItem(params, currentSessionOriginator());
export const backlogList = (params: BacklogListParams = {}) => listBacklogItems(params);
export const backlogUpdate = async (params: BacklogUpdateParams) => {
  const previous = backlogRecordOriginator(params.itemId);
  const originator = currentSessionOriginator();
  const result = await updateBacklogItem(params, originator);
  const authorshipNotice = workAuthorshipNotice(previous, originator);
  return { ...result, ...(authorshipNotice ? { authorshipNotice } : {}) };
};
export const backlogDelete = (params: BacklogDeleteParams) => deleteBacklogItem(params.itemId);
export const backlogMarkReady = async (params: BacklogMarkReadyParams) => {
  const result = await markBacklogItemReady(params, currentSessionOriginator());
  if (result.item.workGraphId) await schedulerTick({ graphId: result.item.workGraphId });
  return result;
};
export const backlogArchive = (params: BacklogArchiveParams) =>
  archiveBacklogItem(params, currentSessionOriginator());
export const backlogEnqueue = async (
  params: BacklogEnqueueParams,
  emit: (event: string, payload: unknown) => void,
) => {
  // A multi-PR item's failed runs hold its ticket and slot until archived (ADR-044 Amendment 2).
  const archivedPriorRunIds = await archiveFailedRunsBeforeEnqueue(params.itemId, emit);
  return enqueueBacklogItem(params, { archivedPriorRunIds }, currentSessionOriginator());
};
export const backlogDequeue = (params: BacklogDequeueParams) =>
  dequeueBacklogItem(params, currentSessionOriginator());
export const backlogAutoDispatchTick = (params: BacklogAutoDispatchTickParams = {}) =>
  autoDispatchBacklogReady(params);
export const backlogUpcoming = (params: BacklogUpcomingParams = {}) => upcomingBacklogItems(params);
export const backlogSpecGet = (params: BacklogSpecGetParams) => getBacklogSpec(params);
export const backlogReconcileRun = async (
  params: BacklogReconcileRunParams,
  emit: (event: string, payload: unknown) => void,
) => {
  const result = await reconcileBacklogRun(params, currentSessionOriginator());
  emit(Events.RUN_UPDATED, { run: result.run });
  return result;
};
export const backlogCloseShipped = (params: BacklogCloseShippedParams) =>
  closeShippedBacklogItem(params, currentSessionOriginator());
export const backlogRefine = (params: BacklogRefineParams) => startBacklogRefinement(params);
export const backlogRefinementSessionGet = (params: BacklogRefinementSessionGetParams) =>
  getBacklogRefinementSession(params);
