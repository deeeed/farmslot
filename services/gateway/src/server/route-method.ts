// route-method.ts — Gateway RPC dispatch boundary for non-run method families

import { WebSocket } from 'ws';

import {
  type AnalyticsQueryParams,
  type BacklogAutoDispatchTickParams,
  type BacklogCreateParams,
  type BacklogDeleteParams,
  type BacklogDequeueParams,
  type BacklogEnqueueParams,
  type BacklogListParams,
  type BacklogMarkReadyParams,
  type BacklogSpecGetParams,
  type BacklogUpcomingParams,
  type BacklogUpdateParams,
  type ChatAbortParams,
  type ChatClearParams,
  type ChatConfirmActionParams,
  type ChatHistoryParams,
  type ChatListActionsParams,
  type ChatNewParams,
  type ChatObserverEvidenceParams,
  type ChatSaveMemoryParams,
  type ChatScreenEvidenceParams,
  type ChatSendParams,
  type ChatSessionContextParams,
  type ChatSessionCreateParams,
  type ChatSessionDeleteParams,
  type ChatSessionPinParams,
  type ChatSessionsBulkDeleteParams,
  type ConfigPoolParams,
  type ConfigPoolUpdateParams,
  type ConfigProjectAutoRecoveryUpdateParams,
  type ConfigProjectBacklogUpdateParams,
  type ConfigProjectParams,
  type ConfigSlotUpdateParams,
  type ConfigTemplateOptionsParams,
  type ConfigTemplatePreviewParams,
  type ConfigTemplatesParams,
  type CopilotFormatInstructionParams,
  type DecisionResolveParams,
  type DiagnosticsRunParams,
  type DispatchCandidatesParams,
  type DispatchMatchProjectParams,
  type DispatchPreviewParams,
  type DispatchQueueAddParams,
  type DispatchQueueRemoveOrphanParams,
  type DispatchQueueRemoveParams,
  type DispatchQueueReorderParams,
  type DispatchQueueUpdateParams,
  type EventFrame,
  Events,
  type FinetuneExportDPOParams,
  type FinetuneExportSFTParams,
  type FinetuneIndexParams,
  type FleetPrSummaryParams,
  type FleetRefreshSlotsCancelParams,
  type FleetRefreshSlotsParams,
  type FleetStatusParams,
  type FsDeleteParams,
  type FsListParams,
  type FsMkdirParams,
  type FsReadParams,
  type FsRenameParams,
  type FsRevealParams,
  type FsWriteParams,
  type GatewayDoctorParams,
  type GatewayStatusParams,
  type GitBranchDiffParams,
  type GitDiffParams,
  type GitDiscardParams,
  type GitFilesParams,
  type GitLogParams,
  type GitShowParams,
  type GitStageParams,
  type GitStatusParams,
  type GitUnstageParams,
  type ImprovementApplyParams,
  type ImprovementChatParams,
  type LLMAuthAddParams,
  type LLMAuthImportParams,
  type LLMAuthLoginParams,
  type LLMAuthRefreshParams,
  type LLMAuthRemoveParams,
  type LLMAuthTestParams,
  type LLMConfigSetParams,
  Methods,
  type NodeHealthAllResult,
  type NodeHealthParams,
  type NodeHealthResult,
  type PairingCandidatesParams,
  type PairingCreateParams,
  type PRAddCommentParams,
  type PRDeleteCommentParams,
  type PREditCommentParams,
  type PRForSlotParams,
  type PRListParams,
  PROTOCOL_VERSION,
  type PRResolveThreadParams,
  type PRReviewCommentsParams,
  type PRStatusParams,
  type PRSubmitReviewParams,
  type RecipeCancelParams,
  type RecipeCommandParams,
  type RecipeProjectHookCommandParams,
  type RecipeProjectHookRunParams,
  type RecipeRerunParams,
  type ResourceCleanupParams,
  type ResourceControlParams,
  type ResourceHealthParams,
  type ResourceListParams,
  type ResourceWatchSetEnabledParams,
  type RoadmapDeleteParams,
  type RoadmapGetParams,
  type RoadmapListParams,
  type RoadmapPromoteParams,
  type RoadmapPromotionDraftGetParams,
  type RoadmapPromotionDraftListParams,
  type RoadmapPromotionDraftSaveParams,
  type RoadmapPromptGetParams,
  type RoadmapRefinementSessionGetParams,
  type RoadmapRefineParams,
  type RoadmapSaveParams,
  type SearchQueryParams,
  type SlotActionListParams,
  type SlotActionRunParams,
  type SlotCheckParams,
  type SlotCleanupParams,
  type SlotFixtureRefreshParams,
  type SlotPrepareParams,
  type SlotPrepareStatusParams,
  type SlotRecycleParams,
  type SlotRefreshParams,
  type SlotReleaseParams,
  type StreamSubscribeParams,
  type StreamUnsubscribeParams,
  type TaskProgressParams,
  type TerminalInputParams,
  type TerminalReinitParams,
  type TerminalResizeParams,
  type TerminalSendParams,
  type TerminalSnapshotParams,
  type TerminalSubscribeParams,
  type TerminalWorkerInputParams,
  type TerminalWorkerResizeParams,
  type TerminalWorkerSnapshotParams,
  type TerminalWorkerSubscribeParams,
  type TerminalWorkerUnsubscribeParams,
  type TmuxKillPaneParams,
  type TmuxListParams,
  type TmuxNewWindowParams,
  type TmuxRenameWindowParams,
  type TmuxSelectPaneParams,
  type TmuxSelectWindowParams,
  type TmuxSendKeysParams,
  type TmuxSplitParams,
  type TmuxSynchronizePanesParams,
  type TmuxWorkerListParams,
  type TmuxZoomPaneParams,
  type WorkerSessionHistoryGetParams,
  type WorkerSessionHistorySubscribeParams,
  type WorkerSessionHistoryUnsubscribeParams,
  type WorkGraphActivateParams,
  type WorkGraphAddEdgeParams,
  type WorkGraphAddNodeParams,
  type WorkGraphCreateParams,
  type WorkGraphGateResolveParams,
  type WorkGraphGetParams,
  type WorkGraphListRpcParams,
  type WorkGraphPauseParams,
  type WorkGraphRemoveEdgeParams,
  type WorkGraphRemoveNodeParams,
  type WorkGraphSchedulerTickParams,
  type WorkGraphUpdateNodeParams,
  type WorkspaceMetroSubscribeParams,
  type WorkspaceMetroUnsubscribeParams,
} from '@farmslot/protocol';

import { restartBranchWatchesForMachine } from '../automation/branch-watcher.js';
import { getAllNodes, registerNode } from '../fleet/machine-registry.js';
import { getAllMachineHealth, getMachineHealth, markMachineOnline } from '../fleet/node-health.js';
import { pairingCandidates, pairingCreate } from '../fleet/pairing.js';
import {
  sendWatchInstructions,
  shouldAutoStartResourceWatches,
} from '../fleet/resource-manager.js';
import { slotCleanup } from '../fleet/slot-cleanup.js';
import { loadFleetStatus } from '../fleet/state.js';
import { analyticsBackfill, analyticsQuery } from '../methods/analytics.js';
import {
  backlogAutoDispatchTick,
  backlogCreate,
  backlogDelete,
  backlogDequeue,
  backlogEnqueue,
  backlogList,
  backlogMarkReady,
  backlogSpecGet,
  backlogUpcoming,
  backlogUpdate,
} from '../methods/backlog.js';
import {
  chatAbort,
  chatClear,
  chatConfirmAction,
  chatContext,
  chatHistory,
  chatListActions,
  chatNew,
  chatObserverEvidence,
  chatSaveMemory,
  chatScreenEvidence,
  chatSend,
  chatSessionContext,
  chatSessionCreate,
  chatSessionDelete,
  chatSessionPin,
  chatSessions,
  chatSessionsBulkDelete,
} from '../methods/chat.js';
import {
  configPool,
  configPoolRaw,
  configPools,
  configPoolUpdate,
  configProject,
  configProjectAutoRecoveryUpdate,
  configProjectBacklogUpdate,
  configProjects,
  configSlotUpdate,
  configTemplateOptions,
  configTemplatePreview,
  configTemplates,
} from '../methods/config.js';
import { copilotFormatInstruction } from '../methods/copilot.js';
import { decisionList, decisionResolve } from '../methods/decisions.js';
import { diagnosticsRun } from '../methods/diagnostics.js';
import {
  dispatchCandidates,
  dispatchMatchProject,
  dispatchPreview,
  dispatchQueueAdd,
  dispatchQueueList,
  dispatchQueueRemove,
  dispatchQueueRemoveOrphan,
  dispatchQueueReorder,
  dispatchQueueUpdate,
  refreshBranches,
} from '../methods/dispatch.js';
import {
  fsDelete,
  fsList,
  fsMkdir,
  fsRead,
  fsRename,
  fsReveal,
  fsWrite,
} from '../methods/filesystem.js';
import { finetuneExportDPO, finetuneExportSFT, finetuneIndex } from '../methods/finetune.js';
import { fleetRefresh, fleetStatus } from '../methods/fleet.js';
import {
  fleetPrSummary,
  fleetRefreshSlots,
  fleetRefreshSlotsCancel,
} from '../methods/fleet-refresh.js';
import { gatewayDoctor } from '../methods/gateway-doctor.js';
import { gatewayStatus } from '../methods/gateway-status.js';
import {
  gitBranchDiff,
  gitDiff,
  gitDiscard,
  gitFiles,
  gitLog,
  gitShow,
  gitStage,
  gitStatus,
  gitUnstage,
} from '../methods/git.js';
import { improvementApply, improvementChat } from '../methods/improvement.js';
import {
  llmAuthAdd,
  llmAuthImport,
  llmAuthList,
  llmAuthLogin,
  llmAuthRefresh,
  llmAuthRemove,
  llmAuthTest,
} from '../methods/llm-auth.js';
import { llmConfigGet, llmConfigSet, llmTiers } from '../methods/llm-config.js';
import { prForSlot, prList, prMonitor, prStatus } from '../methods/pr.js';
import {
  prAddComment,
  prDeleteComment,
  prEditComment,
  prResolveThread,
  prReviewComments,
  prSubmitReview,
} from '../methods/pr/review-comments.js';
import {
  recipeCancel,
  recipeCommand,
  recipeProjectHookCommand,
  recipeProjectHookRun,
  recipeRerun,
} from '../methods/recipe.js';
import {
  resourceCleanup,
  resourceControl,
  resourceHealth,
  resourceList,
  resourceWatchSetEnabled,
} from '../methods/resource.js';
import {
  roadmapDelete,
  roadmapGet,
  roadmapList,
  roadmapPromote,
  roadmapPromotionDraftGet,
  roadmapPromotionDraftList,
  roadmapPromotionDraftSave,
  roadmapPromptGet,
  roadmapRefine,
  roadmapRefinementSessionGet,
  roadmapSave,
} from '../methods/roadmap.js';
import { searchQuery } from '../methods/search.js';
import {
  slotCheck,
  slotFixtureRefresh,
  slotOpenEditor,
  slotPrepare,
  slotPrepareStatus,
  slotRecycle,
  slotRefresh,
  slotRelease,
} from '../methods/slot.js';
import { slotActionList, slotActionRun } from '../methods/slot-actions.js';
import { streamSubscribe, streamUnsubscribe } from '../methods/stream-feed.js';
import { taskProgress } from '../methods/task.js';
import {
  resolveTerminalKey,
  terminalInput,
  terminalKey,
  terminalReinit,
  terminalResize,
  terminalSend,
  terminalSnapshot,
  terminalSubscribe,
} from '../methods/terminal.js';
import {
  terminalWorkerInput,
  terminalWorkerResize,
  terminalWorkerSnapshot,
  terminalWorkerSubscribe,
  terminalWorkerUnsubscribeKey,
  unsubscribeWorkerTerminalPty,
} from '../methods/terminal-worker.js';
import {
  tmuxKillPane,
  tmuxList,
  tmuxNewWindow,
  tmuxRenameWindow,
  tmuxSelectPane,
  tmuxSelectWindow,
  tmuxSendKeys,
  tmuxSplit,
  tmuxSynchronizePanes,
  tmuxZoomPane,
} from '../methods/tmux-control.js';
import { tmuxWorkerList } from '../methods/tmux-workers.js';
import {
  workGraphActivate,
  workGraphAddEdge,
  workGraphAddNode,
  workGraphCreate,
  workGraphGateResolve,
  workGraphGet,
  workGraphList,
  workGraphPause,
  workGraphRemoveEdge,
  workGraphRemoveNode,
  workGraphSchedulerTick,
  workGraphUpdateNode,
} from '../methods/work-graph.js';
import {
  workerSessionHistoryGet,
  workerSessionHistorySubscribe,
  workerSessionHistorySubscriptionKey,
} from '../methods/worker-session-history.js';
import { metroSubscribe, metroUnsubscribe } from '../methods/workspace.js';
import { getAllThumbnails, subscribeThumbnails } from '../observability/thumbnail-cache.js';
import { farmslotRoot } from '../projects/repo-root.js';
import { unsubscribePty } from '../runtime/pty-stream.js';
import { resubscribeAgentScreenSessions } from '../runtime/screen-session.js';
import { unsubscribe as unsubscribeTerminalPoll } from '../runtime/tmux-stream.js';
// Method handlers
import { type GatewayAuthRuntime, requireNodeSession } from '../security/auth.js';

import type { ClientState } from './client-state.js';
import { routeRunMethod } from './run-route.js';
import {
  removeTerminalSubscriptionForKey,
  terminalKeysForSlot,
  terminalUnsubscribeKeysForRequest,
} from './terminal-subscriptions.js';

const ENABLE_BRANCH_WATCHERS =
  process.env.FARMSLOT_BRANCH_WATCHERS === '1' || process.env.FARMSLOT_BRANCH_WATCHERS === 'true';

async function refreshConnectedNodeBranches(
  machine: string,
  broadcast: (frame: EventFrame) => void,
  nextEventSeq: () => number,
): Promise<void> {
  const fleet = await loadFleetStatus(true);
  const machineSlots = fleet.slots.filter((slot) => slot.machine === machine && slot.enabled);
  let refreshError: unknown;
  try {
    if (machineSlots.length > 0) await refreshBranches(machineSlots);
  } catch (err) {
    refreshError = err;
  }
  const refreshedFleet = await loadFleetStatus(true);
  broadcast({
    type: 'event',
    event: Events.FLEET_UPDATED,
    payload: { fleet: refreshedFleet },
    seq: nextEventSeq(),
  });
  if (refreshError) throw refreshError;
}

export interface RouteMethodContext {
  state: ClientState;
  emit: (event: string, payload: unknown) => void;
  authRuntime: GatewayAuthRuntime;
  isActiveClient: (state: ClientState) => boolean;
  broadcast: (frame: EventFrame) => void;
  nextEventSeq: () => number;
}

export async function routeMethod(
  method: string,
  params: unknown,
  context: RouteMethodContext,
): Promise<unknown> {
  const { authRuntime, broadcast, emit, isActiveClient, nextEventSeq, state } = context;
  // RPC dispatch boundary — params arrive untyped from the wire;
  // each handler receives its typed params via assertion.
  const p: unknown = params ?? {};
  const runRoute = await routeRunMethod(method, p, { broadcast, emit });
  if (runRoute.handled) return runRoute.value;

  switch (method) {
    // Gateway self-status
    case Methods.GATEWAY_STATUS:
      return gatewayStatus(p as GatewayStatusParams);
    case Methods.GATEWAY_DOCTOR:
      return gatewayDoctor(p as GatewayDoctorParams);

    // Fleet
    case Methods.FLEET_STATUS:
      return fleetStatus(p as FleetStatusParams);
    case Methods.FLEET_REFRESH:
      return fleetRefresh();

    // Slot
    case Methods.SLOT_CHECK:
      return slotCheck(p as SlotCheckParams, emit);
    case Methods.SLOT_PREPARE:
      return slotPrepare(p as SlotPrepareParams, emit);
    case Methods.SLOT_RELEASE:
      return slotRelease(p as SlotReleaseParams, emit);
    case Methods.SLOT_RECYCLE:
      return slotRecycle(p as SlotRecycleParams, emit);
    case Methods.SLOT_REFRESH:
      return slotRefresh(p as SlotRefreshParams, emit);
    case Methods.SLOT_FIXTURE_REFRESH:
      return slotFixtureRefresh(p as SlotFixtureRefreshParams, emit);
    case Methods.SLOT_CLEANUP:
      return slotCleanup(p as SlotCleanupParams);
    case Methods.SLOT_PREPARE_STATUS:
      return slotPrepareStatus(p as SlotPrepareStatusParams);
    case Methods.FLEET_REFRESH_SLOTS:
      return fleetRefreshSlots(p as FleetRefreshSlotsParams, emit);
    case Methods.FLEET_REFRESH_SLOTS_CANCEL:
      return fleetRefreshSlotsCancel(p as FleetRefreshSlotsCancelParams);
    case Methods.FLEET_PR_SUMMARY:
      return fleetPrSummary(p as FleetPrSummaryParams);
    case Methods.SLOT_OPEN_EDITOR:
      return slotOpenEditor(p as { slotId: string; editor: string });
    case Methods.SLOT_ACTION_LIST:
      return slotActionList(p as SlotActionListParams);
    case Methods.SLOT_ACTION_RUN:
      return slotActionRun(p as SlotActionRunParams);

    // Dispatch
    case Methods.DISPATCH_PREVIEW:
      return dispatchPreview(p as DispatchPreviewParams);
    // dispatch.execute removed from public API — use run.create instead
    // (dispatchExecute is still called internally by run-engine S.DISPATCH)
    case Methods.DISPATCH_MATCH_PROJECT:
      return dispatchMatchProject(p as DispatchMatchProjectParams);
    case Methods.DISPATCH_CANDIDATES:
      return dispatchCandidates(p as DispatchCandidatesParams);
    case Methods.DISPATCH_QUEUE_ADD:
      return dispatchQueueAdd(p as DispatchQueueAddParams);
    case Methods.DISPATCH_QUEUE_LIST:
      return dispatchQueueList();
    case Methods.DISPATCH_QUEUE_REMOVE:
      return dispatchQueueRemove(p as DispatchQueueRemoveParams);
    case Methods.DISPATCH_QUEUE_REMOVE_ORPHAN:
      return dispatchQueueRemoveOrphan(p as DispatchQueueRemoveOrphanParams);
    case Methods.DISPATCH_QUEUE_UPDATE:
      return dispatchQueueUpdate(p as DispatchQueueUpdateParams);
    case Methods.DISPATCH_QUEUE_REORDER:
      return dispatchQueueReorder(p as DispatchQueueReorderParams);

    // Backlog
    case Methods.BACKLOG_CREATE:
      return backlogCreate(p as BacklogCreateParams);
    case Methods.BACKLOG_LIST:
      return backlogList((p ?? {}) as BacklogListParams);
    case Methods.BACKLOG_UPDATE:
      return backlogUpdate(p as BacklogUpdateParams);
    case Methods.BACKLOG_DELETE:
      return backlogDelete(p as BacklogDeleteParams);
    case Methods.BACKLOG_MARK_READY:
      return backlogMarkReady(p as BacklogMarkReadyParams);
    case Methods.BACKLOG_ENQUEUE:
      return backlogEnqueue(p as BacklogEnqueueParams);
    case Methods.BACKLOG_DEQUEUE:
      return backlogDequeue(p as BacklogDequeueParams);
    case Methods.BACKLOG_AUTO_DISPATCH_TICK:
      return backlogAutoDispatchTick((p ?? {}) as BacklogAutoDispatchTickParams);
    case Methods.BACKLOG_UPCOMING:
      return backlogUpcoming((p ?? {}) as BacklogUpcomingParams);
    case Methods.BACKLOG_SPEC_GET:
      return backlogSpecGet(p as BacklogSpecGetParams);

    // Work Graph
    case Methods.WORK_GRAPH_CREATE:
      return workGraphCreate(p as WorkGraphCreateParams);
    case Methods.WORK_GRAPH_GET:
      return workGraphGet(p as WorkGraphGetParams);
    case Methods.WORK_GRAPH_LIST:
      return workGraphList((p ?? {}) as WorkGraphListRpcParams);
    case Methods.WORK_GRAPH_ADD_NODE:
      return workGraphAddNode(p as WorkGraphAddNodeParams);
    case Methods.WORK_GRAPH_ADD_EDGE:
      return workGraphAddEdge(p as WorkGraphAddEdgeParams);
    case Methods.WORK_GRAPH_REMOVE_NODE:
      return workGraphRemoveNode(p as WorkGraphRemoveNodeParams);
    case Methods.WORK_GRAPH_REMOVE_EDGE:
      return workGraphRemoveEdge(p as WorkGraphRemoveEdgeParams);
    case Methods.WORK_GRAPH_UPDATE_NODE:
      return workGraphUpdateNode(p as WorkGraphUpdateNodeParams);
    case Methods.WORK_GRAPH_ACTIVATE:
      return workGraphActivate(p as WorkGraphActivateParams);
    case Methods.WORK_GRAPH_PAUSE:
      return workGraphPause(p as WorkGraphPauseParams);
    case Methods.WORK_GRAPH_GATE_RESOLVE:
      return workGraphGateResolve(p as WorkGraphGateResolveParams);
    case Methods.WORK_GRAPH_SCHEDULER_TICK:
      return workGraphSchedulerTick((p ?? {}) as WorkGraphSchedulerTickParams);

    // Roadmap
    case Methods.ROADMAP_LIST:
      return roadmapList((p ?? {}) as RoadmapListParams);
    case Methods.ROADMAP_GET:
      return roadmapGet(p as RoadmapGetParams);
    case Methods.ROADMAP_SAVE:
      return roadmapSave(p as RoadmapSaveParams);
    case Methods.ROADMAP_DELETE:
      return roadmapDelete(p as RoadmapDeleteParams);
    case Methods.ROADMAP_REFINE:
      return roadmapRefine(p as RoadmapRefineParams);
    case Methods.ROADMAP_REFINEMENT_SESSION_GET:
      return roadmapRefinementSessionGet(p as RoadmapRefinementSessionGetParams);
    case Methods.ROADMAP_PROMPT_GET:
      return roadmapPromptGet(p as RoadmapPromptGetParams);
    case Methods.ROADMAP_PROMOTION_DRAFT_LIST:
      return roadmapPromotionDraftList(p as RoadmapPromotionDraftListParams);
    case Methods.ROADMAP_PROMOTION_DRAFT_GET:
      return roadmapPromotionDraftGet(p as RoadmapPromotionDraftGetParams);
    case Methods.ROADMAP_PROMOTION_DRAFT_SAVE:
      return roadmapPromotionDraftSave(p as RoadmapPromotionDraftSaveParams);
    case Methods.ROADMAP_PROMOTE:
      return roadmapPromote(p as RoadmapPromoteParams);

    // Pipeline-ops analytics
    case Methods.ANALYTICS_QUERY:
      return analyticsQuery((p ?? {}) as AnalyticsQueryParams);
    case Methods.ANALYTICS_BACKFILL:
      return analyticsBackfill();

    // Terminal
    case Methods.TERMINAL_SUBSCRIBE: {
      const sub = p as TerminalSubscribeParams;
      // Capture and bump the subscribe sequence BEFORE any await: rapid role
      // tab switches fire two SUBSCRIBE calls back-to-back, and without this
      // gate the older completer's terminalHandlers.set clobbers the newer
      // registration silently.
      const mySeq = (state.terminalSubscribeSeq.get(sub.slotId) ?? 0) + 1;
      state.terminalSubscribeSeq.set(sub.slotId, mySeq);
      const key = await resolveTerminalKey(sub);
      // Pre-remove gate: if a newer subscribe already ran during
      // resolveTerminalKey above, we must NOT touch the existing handlers —
      // the newer call has already registered its own and removing them now
      // would leave the client with no active subscription.
      if (state.terminalSubscribeSeq.get(sub.slotId) !== mySeq) {
        return { subscribed: false };
      }
      // One browser client should have at most one interactive terminal handler
      // per slot. Role/context tabs use distinct PTY keys, so a resubscribe
      // removes only this client's stale same-slot handlers before attaching the
      // newly selected role.
      const keysToRemove = sub.interactive ? terminalKeysForSlot(state, sub.slotId) : [key];
      for (const oldKey of keysToRemove) {
        removeTerminalSubscriptionForKey(state, sub.slotId, oldKey);
      }
      const {
        key: subscribedKey,
        handler,
        ptyHandler,
        identity,
      } = await terminalSubscribe(sub, emit);
      // Late-completer check: if a newer subscribe ran during the await above,
      // discard ours. terminalSubscribe already registered the PTY handler in
      // pty-stream and (for poll mode) the poll subscriber; we must release
      // both so the orphaned subscriber does not keep an empty PTY session
      // alive after the newer subscribe finishes against a different key.
      if (state.terminalSubscribeSeq.get(sub.slotId) !== mySeq || !isActiveClient(state)) {
        if (ptyHandler) unsubscribePty(subscribedKey, ptyHandler);
        unsubscribeTerminalPoll(subscribedKey, handler);
        // Defensive: terminalSubscribe never wrote to terminalIdentities for
        // this client, but the newer subscribe may have set its own value
        // under the same key — only delete if we are confident it is ours.
        return { subscribed: false };
      }
      state.terminalHandlers.set(subscribedKey, handler);
      if (ptyHandler) {
        state.ptyHandlers.set(subscribedKey, ptyHandler);
      }
      state.terminalIdentities.set(subscribedKey, identity);
      return { subscribed: true };
    }
    case Methods.TERMINAL_UNSUBSCRIBE: {
      const unsub = p as TerminalSubscribeParams;
      const rawKey = terminalKey(unsub);
      let key = rawKey;
      try {
        key = await resolveTerminalKey(unsub);
      } catch (err) {
        // If the run/session is already gone, fall back to raw legacy key so
        // this client's existing handler can still be detached.
        console.warn(
          `[terminal] unsubscribe key resolution failed for ${unsub.slotId}: ${(err as Error).message}`,
        );
      }
      for (const keyToRemove of terminalUnsubscribeKeysForRequest(
        state,
        unsub.slotId,
        key,
        rawKey,
      )) {
        removeTerminalSubscriptionForKey(state, unsub.slotId, keyToRemove);
      }
      return { unsubscribed: true };
    }
    case Methods.TERMINAL_SEND:
      await terminalSend(p as TerminalSendParams);
      return { sent: true };
    case Methods.TERMINAL_INPUT:
      await terminalInput(p as TerminalInputParams);
      return { sent: true };
    case Methods.TERMINAL_RESIZE:
      await terminalResize(p as TerminalResizeParams);
      return { resized: true };
    case Methods.TERMINAL_REINIT:
      return terminalReinit(p as TerminalReinitParams);
    case Methods.TERMINAL_SNAPSHOT:
      return terminalSnapshot(p as TerminalSnapshotParams);
    case Methods.TERMINAL_WORKER_SUBSCRIBE: {
      const sub = p as TerminalWorkerSubscribeParams;
      const key = terminalWorkerUnsubscribeKey(sub);
      const oldHandler = state.workerTerminalHandlers.get(key);
      if (oldHandler) {
        unsubscribeWorkerTerminalPty(key, oldHandler);
        state.workerTerminalHandlers.delete(key);
      }
      const { ptyHandler } = await terminalWorkerSubscribe(sub, emit);
      state.workerTerminalHandlers.set(key, ptyHandler);
      return { subscribed: true };
    }
    case Methods.TERMINAL_WORKER_UNSUBSCRIBE: {
      const key = terminalWorkerUnsubscribeKey(p as TerminalWorkerUnsubscribeParams);
      const handler = state.workerTerminalHandlers.get(key);
      if (handler) {
        unsubscribeWorkerTerminalPty(key, handler);
        state.workerTerminalHandlers.delete(key);
      }
      return { unsubscribed: true };
    }
    case Methods.TERMINAL_WORKER_INPUT:
      await terminalWorkerInput(p as TerminalWorkerInputParams);
      return { sent: true };
    case Methods.TERMINAL_WORKER_RESIZE:
      await terminalWorkerResize(p as TerminalWorkerResizeParams);
      return { resized: true };
    case Methods.TERMINAL_WORKER_SNAPSHOT:
      return terminalWorkerSnapshot(p as TerminalWorkerSnapshotParams);
    case Methods.WORKER_SESSION_HISTORY_GET:
      return workerSessionHistoryGet(p as WorkerSessionHistoryGetParams);
    case Methods.WORKER_SESSION_HISTORY_SUBSCRIBE: {
      const sub = p as WorkerSessionHistorySubscribeParams;
      const key = workerSessionHistorySubscriptionKey(sub);
      const mySeq = (state.workerSessionHistorySubscribeSeq.get(key) ?? 0) + 1;
      state.workerSessionHistorySubscribeSeq.set(key, mySeq);
      state.workerSessionHistoryHandlers.get(key)?.();
      state.workerSessionHistoryHandlers.delete(key);
      const { result, unsubscribe } = await workerSessionHistorySubscribe(sub, emit);
      if (state.workerSessionHistorySubscribeSeq.get(key) === mySeq && isActiveClient(state)) {
        state.workerSessionHistoryHandlers.set(key, unsubscribe);
      } else {
        unsubscribe();
        return { ...result, subscribed: false };
      }
      return result;
    }
    case Methods.WORKER_SESSION_HISTORY_UNSUBSCRIBE: {
      const key = workerSessionHistorySubscriptionKey(p as WorkerSessionHistoryUnsubscribeParams);
      state.workerSessionHistorySubscribeSeq.set(
        key,
        (state.workerSessionHistorySubscribeSeq.get(key) ?? 0) + 1,
      );
      state.workerSessionHistoryHandlers.get(key)?.();
      state.workerSessionHistoryHandlers.delete(key);
      return { unsubscribed: true };
    }

    // PR
    case Methods.PR_STATUS:
      return prStatus(p as PRStatusParams);
    case Methods.PR_LIST:
      return prList(p as PRListParams);
    case Methods.PR_MONITOR:
      return prMonitor(p as PRStatusParams | undefined, emit);
    case Methods.PR_REVIEW_COMMENTS:
      return prReviewComments(p as PRReviewCommentsParams);
    case Methods.PR_ADD_COMMENT:
      return prAddComment(p as PRAddCommentParams);
    case Methods.PR_EDIT_COMMENT:
      return prEditComment(p as PREditCommentParams);
    case Methods.PR_DELETE_COMMENT:
      return prDeleteComment(p as PRDeleteCommentParams);
    case Methods.PR_SUBMIT_REVIEW:
      return prSubmitReview(p as PRSubmitReviewParams);
    case Methods.PR_RESOLVE_THREAD:
      return prResolveThread(p as PRResolveThreadParams);
    case Methods.PR_FOR_SLOT:
      return prForSlot(p as PRForSlotParams);

    // Decisions
    case Methods.DECISION_LIST:
      return decisionList();
    case Methods.DECISION_RESOLVE: {
      // Forward all per-request emits as broadcasts so RUN_DECISION_RESOLVED
      // and RUN_UPDATED reach every connected client (family page, slot card,
      // inbox), not just the requesting socket. Mirrors RUN_RESOLVE_DECISION.
      const broadcastEmit = (event: string, payload: unknown) => {
        broadcast({ type: 'event', event, payload });
      };
      const dr = await decisionResolve(p as DecisionResolveParams, broadcastEmit);
      broadcast({
        type: 'event',
        event: Events.DECISION_RESOLVED,
        payload: { id: (p as DecisionResolveParams).decisionId },
      });
      return dr;
    }

    // Nodes
    case 'node.connect': {
      requireNodeSession(authRuntime, state);
      const { machine, pid, protocolVersion, capabilities } = p as {
        machine: string;
        pid: number;
        protocolVersion?: string;
        capabilities?: import('@farmslot/protocol').RecipeRuntimeCapabilityDeclaration[];
      };
      registerNode(machine, pid, state.ws, protocolVersion, PROTOCOL_VERSION);
      markMachineOnline(machine, capabilities);
      const versionMatch = protocolVersion === PROTOCOL_VERSION;
      if (protocolVersion && !versionMatch) {
        console.log(
          `Node connected: ${machine} (pid ${pid}) ⚠ version mismatch: node=${protocolVersion} gateway=${PROTOCOL_VERSION}`,
        );
        broadcast({
          type: 'event',
          event: Events.NODE_VERSION_MISMATCH,
          payload: { machine, nodeVersion: protocolVersion, gatewayVersion: PROTOCOL_VERSION },
          seq: nextEventSeq(),
        });
      } else {
        console.log(`Node connected: ${machine} (pid ${pid}) v=${protocolVersion ?? 'unknown'}`);
      }
      broadcast({
        type: 'event',
        event: Events.NODE_CONNECTED,
        payload: { machine, pid, protocolVersion, versionMatch, capabilities },
        seq: nextEventSeq(),
      });
      // Refresh this machine's slot branches now that node exec is available.
      // A plain loadFleetStatus(true) only rebroadcasts .farm-status.json, which can be stale
      // when the worker changed branches while the node/gateway was disconnected.
      refreshConnectedNodeBranches(machine, broadcast, nextEventSeq).catch((err) => {
        console.warn(`[server] branch refresh on node connect failed: ${(err as Error).message}`);
      });
      // Auto-subscribe agent to push metrics every 30s
      const subscribeFrame = {
        type: 'req' as const,
        id: `auto-metrics-${machine}`,
        method: 'system.metrics.subscribe',
        params: { intervalMs: 30_000 },
      };
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(subscribeFrame));
      }
      // Tmux worker sampling lives on the node; the gateway only receives changed snapshots.
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(
          JSON.stringify({
            type: 'req',
            id: `auto-tmux-workers-${machine}`,
            method: 'tmux.worker.watch.start',
            params: { intervalMs: 2_000 },
          }),
        );
      }
      // Resource watches are the default cache source for resource.list / device grids.
      // Full resource.health probes remain request-driven.
      if (shouldAutoStartResourceWatches()) {
        sendWatchInstructions(machine).catch((err) => {
          console.log(
            `[server] failed to send resource watches for ${machine}: ${(err as Error).message}`,
          );
        });
      }
      // Re-establish remote branch watches after node reconnect only when
      // branch watchers were explicitly enabled at startup. Otherwise reconnects
      // would populate activeWatches without the poller that services them.
      if (ENABLE_BRANCH_WATCHERS) {
        restartBranchWatchesForMachine(machine).catch((err) => {
          console.log(
            `[server] failed to restart branch watches for ${machine}: ${(err as Error).message}`,
          );
        });
      }
      // Re-subscribe stashed screen sessions from previous connection
      resubscribeAgentScreenSessions(machine).catch((err) => {
        console.log(
          `[server] failed to resub screen sessions for ${machine}: ${(err as Error).message}`,
        );
      });
      return { registered: true };
    }
    case Methods.NODES_LIST:
      return { nodes: getAllNodes(), gatewayProtocolVersion: PROTOCOL_VERSION };

    case Methods.NODE_DEPLOY: {
      const { machine } = p as { machine: string };
      const { execFile } = await import('node:child_process');
      const { resolve } = await import('node:path');
      const scriptPath = resolve(farmslotRoot, 'scripts/deploy-node.sh');
      return new Promise((res) => {
        execFile('bash', [scriptPath, machine], { timeout: 120_000 }, (err, stdout, stderr) => {
          if (err) {
            res({ machine, success: false, output: (stderr || '') + '\n' + (err.message || '') });
          } else {
            res({ machine, success: true, output: stdout });
          }
        });
      });
    }

    // Task progress
    case Methods.TASK_PROGRESS:
      return taskProgress(p as TaskProgressParams);

    // Config
    case Methods.CONFIG_POOLS:
      return configPools();
    case Methods.CONFIG_POOL:
      return configPool(p as ConfigPoolParams);
    case Methods.CONFIG_POOL_RAW:
      return configPoolRaw(p as ConfigPoolParams);
    case Methods.CONFIG_PROJECTS:
      return configProjects();
    case Methods.CONFIG_PROJECT:
      return configProject(p as ConfigProjectParams);
    case Methods.CONFIG_TEMPLATES:
      return configTemplates(p as ConfigTemplatesParams);
    case Methods.CONFIG_TEMPLATE_PREVIEW:
      return configTemplatePreview(p as ConfigTemplatePreviewParams);
    case Methods.CONFIG_TEMPLATE_OPTIONS:
      return configTemplateOptions(p as ConfigTemplateOptionsParams);
    case Methods.CONFIG_SLOT_UPDATE: {
      const result = await configSlotUpdate(p as ConfigSlotUpdateParams);
      // Trigger fleet refresh so all clients see updated state
      await fleetRefresh();
      return result;
    }
    case Methods.CONFIG_POOL_UPDATE: {
      const result = await configPoolUpdate(p as ConfigPoolUpdateParams);
      await fleetRefresh();
      return result;
    }
    case Methods.CONFIG_PROJECT_AUTO_RECOVERY_UPDATE:
      return configProjectAutoRecoveryUpdate(p as ConfigProjectAutoRecoveryUpdateParams);
    case Methods.CONFIG_PROJECT_BACKLOG_UPDATE:
      return configProjectBacklogUpdate(p as ConfigProjectBacklogUpdateParams);

    // Filesystem
    case Methods.FS_LIST:
      return fsList(p as FsListParams);
    case Methods.FS_READ:
      return fsRead(p as FsReadParams);
    case Methods.FS_WRITE:
      return fsWrite(p as FsWriteParams);
    case Methods.FS_RENAME:
      return fsRename(p as FsRenameParams);
    case Methods.FS_DELETE:
      return fsDelete(p as FsDeleteParams);
    case Methods.FS_REVEAL:
      return fsReveal(p as FsRevealParams);
    case Methods.FS_MKDIR:
      return fsMkdir(p as FsMkdirParams);

    // Workspace — Metro logs
    case Methods.WORKSPACE_METRO_SUBSCRIBE:
      return metroSubscribe(p as WorkspaceMetroSubscribeParams, emit, state.id);
    case Methods.WORKSPACE_METRO_UNSUBSCRIBE:
      return metroUnsubscribe(p as WorkspaceMetroUnsubscribeParams, state.id);

    // Diagnostics
    case Methods.DIAGNOSTICS_RUN:
      return diagnosticsRun(p as DiagnosticsRunParams);

    // Search
    case Methods.SEARCH_QUERY:
      return searchQuery(p as SearchQueryParams);

    // Git
    case Methods.GIT_STATUS:
      return gitStatus(p as GitStatusParams);
    case Methods.GIT_DIFF:
      return gitDiff(p as GitDiffParams);
    case Methods.GIT_LOG:
      return gitLog(p as GitLogParams);
    case Methods.GIT_SHOW:
      return gitShow(p as GitShowParams);
    case Methods.GIT_FILES:
      return gitFiles(p as GitFilesParams);
    case Methods.GIT_STAGE:
      return gitStage(p as GitStageParams);
    case Methods.GIT_UNSTAGE:
      return gitUnstage(p as GitUnstageParams);
    case Methods.GIT_DISCARD:
      return gitDiscard(p as GitDiscardParams);
    case Methods.GIT_BRANCH_DIFF:
      return gitBranchDiff(p as GitBranchDiffParams);

    // Tmux control
    case Methods.TMUX_SPLIT:
      return tmuxSplit(p as TmuxSplitParams);
    case Methods.TMUX_SELECT_PANE:
      return tmuxSelectPane(p as TmuxSelectPaneParams);
    case Methods.TMUX_KILL_PANE:
      return tmuxKillPane(p as TmuxKillPaneParams);
    case Methods.TMUX_ZOOM_PANE:
      return tmuxZoomPane(p as TmuxZoomPaneParams);
    case Methods.TMUX_NEW_WINDOW:
      return tmuxNewWindow(p as TmuxNewWindowParams);
    case Methods.TMUX_SELECT_WINDOW:
      return tmuxSelectWindow(p as TmuxSelectWindowParams);
    case Methods.TMUX_RENAME_WINDOW:
      return tmuxRenameWindow(p as TmuxRenameWindowParams);
    case Methods.TMUX_LIST:
      return tmuxList(p as TmuxListParams);
    case Methods.TMUX_WORKER_LIST:
      return tmuxWorkerList((p ?? {}) as TmuxWorkerListParams);
    case Methods.TMUX_SEND_KEYS:
      return tmuxSendKeys(p as TmuxSendKeysParams);
    case Methods.TMUX_SYNCHRONIZE_PANES:
      return tmuxSynchronizePanes(p as TmuxSynchronizePanesParams);

    // Stream
    case Methods.STREAM_SUBSCRIBE: {
      const sub = p as StreamSubscribeParams;
      const feedKey = `${sub.slotId}:${sub.resourceId ?? sub.platform ?? 'auto'}`;
      // Clean up existing subscription for this feed
      const oldScreenHandler = state.screenHandlers.get(feedKey);
      if (oldScreenHandler) {
        streamUnsubscribe(state.ws, feedKey, oldScreenHandler, sub.resourceId);
        state.screenHandlers.delete(feedKey);
      }
      const { handler, key, resourceIndex } = await streamSubscribe(sub, state.ws, sub.slotId);
      state.screenHandlers.set(key, handler);
      return { ok: true, resourceIndex };
    }
    case Methods.STREAM_UNSUBSCRIBE: {
      const unsub = p as StreamUnsubscribeParams;
      const targetKey = unsub.resourceId ?? unsub.platform;
      for (const [key, handler] of state.screenHandlers) {
        if (!key.startsWith(unsub.slotId + ':')) continue;
        if (targetKey && key !== `${unsub.slotId}:${targetKey}`) continue;
        streamUnsubscribe(state.ws, key, handler, unsub.resourceId);
        state.screenHandlers.delete(key);
      }
      return { ok: true };
    }

    // Resources
    case Methods.RESOURCE_LIST:
      return resourceList(p as ResourceListParams);
    case Methods.RESOURCE_CONTROL:
      return resourceControl(p as ResourceControlParams);
    case Methods.RESOURCE_HEALTH:
      return resourceHealth(p as ResourceHealthParams);
    case Methods.RESOURCE_CLEANUP:
      return resourceCleanup(p as ResourceCleanupParams);
    case Methods.RESOURCE_WATCH_SET_ENABLED:
      return resourceWatchSetEnabled(p as ResourceWatchSetEnabledParams);

    // Fine-tuning data export
    case Methods.FINETUNE_INDEX:
      return finetuneIndex(p as FinetuneIndexParams);
    case Methods.FINETUNE_EXPORT_SFT:
      return finetuneExportSFT(p as FinetuneExportSFTParams);
    case Methods.FINETUNE_EXPORT_DPO:
      return finetuneExportDPO(p as FinetuneExportDPOParams);

    // LLM Auth
    case Methods.LLM_AUTH_LIST:
      return llmAuthList();
    case Methods.LLM_AUTH_ADD:
      return llmAuthAdd(p as LLMAuthAddParams);
    case Methods.LLM_AUTH_REMOVE:
      return llmAuthRemove(p as LLMAuthRemoveParams);
    case Methods.LLM_AUTH_TEST:
      return llmAuthTest(p as LLMAuthTestParams);
    case Methods.LLM_AUTH_IMPORT:
      return llmAuthImport(p as LLMAuthImportParams);
    case Methods.LLM_AUTH_REFRESH:
      return llmAuthRefresh(p as LLMAuthRefreshParams);
    case Methods.LLM_AUTH_LOGIN:
      return llmAuthLogin(p as LLMAuthLoginParams, emit);

    // LLM Config
    case Methods.LLM_CONFIG_GET:
      return llmConfigGet();
    case Methods.LLM_CONFIG_SET:
      return llmConfigSet(p as LLMConfigSetParams);
    case Methods.LLM_TIERS:
      return llmTiers();

    // Node Health
    case Methods.NODE_HEALTH: {
      const nhp = p as NodeHealthParams;
      const health = getMachineHealth(nhp.machine);
      if (!health) throw new Error(`No health data for machine: ${nhp.machine}`);
      return { health } satisfies NodeHealthResult;
    }
    case Methods.NODE_HEALTH_ALL:
      return { machines: getAllMachineHealth() } satisfies NodeHealthAllResult;

    // Co-Pilot Chat
    case Methods.CHAT_SEND:
      return chatSend(p as ChatSendParams, emit);
    case Methods.CHAT_HISTORY:
      return chatHistory(p as ChatHistoryParams);
    case Methods.CHAT_CLEAR:
      return chatClear(p as ChatClearParams);
    case Methods.CHAT_NEW:
      return chatNew(p as ChatNewParams, emit);
    case Methods.CHAT_SESSIONS:
      return chatSessions();
    case Methods.CHAT_SESSION_CREATE:
      return chatSessionCreate(p as ChatSessionCreateParams);
    case Methods.CHAT_SESSION_DELETE:
      return chatSessionDelete(p as ChatSessionDeleteParams);
    case Methods.CHAT_SESSIONS_BULK_DELETE:
      return chatSessionsBulkDelete(p as ChatSessionsBulkDeleteParams);
    case Methods.CHAT_SESSION_PIN:
      return chatSessionPin(p as ChatSessionPinParams);
    case Methods.CHAT_SCREEN_EVIDENCE:
      return chatScreenEvidence(p as ChatScreenEvidenceParams);
    case Methods.CHAT_OBSERVER_EVIDENCE:
      return chatObserverEvidence(p as ChatObserverEvidenceParams);
    case Methods.CHAT_SAVE_MEMORY:
      return chatSaveMemory(p as ChatSaveMemoryParams, emit);
    case Methods.CHAT_CONFIRM_ACTION:
      return chatConfirmAction(p as ChatConfirmActionParams, emit);
    case Methods.CHAT_LIST_ACTIONS:
      return chatListActions(p as ChatListActionsParams);
    case Methods.CHAT_ABORT:
      return chatAbort(p as ChatAbortParams);
    case Methods.CHAT_CONTEXT:
      return chatContext();
    case Methods.CHAT_SESSION_CONTEXT:
      return chatSessionContext(p as ChatSessionContextParams);
    // Improvement
    case Methods.IMPROVEMENT_CHAT:
      return improvementChat(p as ImprovementChatParams, emit);
    case Methods.IMPROVEMENT_APPLY:
      return improvementApply(p as ImprovementApplyParams, emit);

    // Screen Thumbnails
    case Methods.SCREEN_THUMBNAIL:
      if (!state.thumbnailSubscribed) {
        state.thumbnailSubscribed = true;
        subscribeThumbnails();
      }
      return { thumbnails: getAllThumbnails() };

    // Recipe
    case Methods.RECIPE_RERUN:
      return recipeRerun(p as RecipeRerunParams, emit);
    case Methods.RECIPE_COMMAND:
      return recipeCommand(p as RecipeCommandParams);
    case Methods.RECIPE_PROJECT_HOOK_COMMAND:
      return recipeProjectHookCommand(p as RecipeProjectHookCommandParams);
    case Methods.RECIPE_PROJECT_HOOK_RUN:
      return recipeProjectHookRun(p as RecipeProjectHookRunParams);
    case Methods.RECIPE_CANCEL:
      return recipeCancel(p as RecipeCancelParams);

    case Methods.COPILOT_FORMAT_INSTRUCTION:
      return copilotFormatInstruction(p as CopilotFormatInstructionParams);
    case Methods.PAIRING_CANDIDATES:
      return pairingCandidates(p as PairingCandidatesParams);
    case Methods.PAIRING_CREATE:
      return pairingCreate(p as PairingCreateParams, authRuntime);

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
