import { AppState, Platform } from 'react-native';

import {
  nativeResourceQueryInfo,
  type NativeResourceStoreDiagnostics,
  nativeResourceStoreDiagnostics,
} from '@farmslot/local-store/native';
import type {
  FamilyObservabilityGetResult,
  FamilyObservabilitySnapshot,
  GitDiffResult,
  NativeSessionInfo,
  NativeSessionReadResult,
  Run,
  RunGetResult,
  RunRecipeRunsForRunResult,
  SlotRunHistoryResult,
  SlotStatus,
  TaskProgressResult,
  TaskProgressStructured,
} from '@farmslot/protocol';
import {
  type NativeHistorySnapshot,
  nativeHistoryStorageId,
  type NativeTimelineEntry,
  type ResourceQuery,
  resourceQuery,
  type ResourceQueryState,
  type StoredResourceQueryInfo,
} from '@farmslot/protocol/client-cache';

import type { VisualReviewScreenState } from '../features/visual-review/visual-review-controller';
import {
  nativeActiveRunsQuery,
  nativeDecisionsQuery,
  nativeFleetQuery,
} from '../lib/gateway-run-sync';
import type {
  NativeWorkerViewSelection,
  NativeWorkerViewTarget,
} from '../lib/native-worker-target';
import { getResourceCache, getResourceWorkspaceKey } from '../lib/resource-cache';
import { useConnectionStore } from '../store/connection';
import { useDecisionStore } from '../store/decisions';
import { useFilterStore } from '../store/filters';
import { useFleetStore } from '../store/fleet';
import { useRunStore } from '../store/runs';

import { readBacklogReadyTouches } from './backlog-ready-touch-proof';
import type { FarmslotRecipeUiObserver } from './RecipeBridgeProvider';

const startedAt = Date.now();
// Recipe evidence records real lifecycle events only, without driving app or cache state.
const appStateHistory = [{ state: AppState.currentState, at: startedAt }];
if (__DEV__ && process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE === '1')
  AppState.addEventListener('change', (state) => {
    appStateHistory.push({ state, at: Date.now() });
    if (appStateHistory.length > 16) appStateHistory.shift();
  });
interface ConversationProofFrame {
  focused: boolean;
  observation: ResourceQueryState<RunGetResult>;
  historyQuery?: ResourceQuery<NativeHistorySnapshot>;
  historyObservation: ResourceQueryState<NativeHistorySnapshot>;
  selection: NativeWorkerViewSelection;
  worker?: NativeWorkerViewTarget;
  session?: NativeSessionInfo;
  timeline: NativeTimelineEntry[];
  cursor: number;
  eventCount: number;
  pageReadCount: number;
  pageAfters: readonly number[];
  commands: NativeSessionReadResult['commands'];
  draft: string;
  pendingCommandId?: string;
  pendingText?: string;
  responses: readonly string[];
  ready: boolean;
  caughtUp: boolean;
  writable: boolean;
  canSend: boolean;
  resumeAvailable: boolean;
  resumeReady: boolean;
  busy: boolean;
}
const conversationFrames = new Map<string, Set<() => ConversationProofFrame>>();
/** Inspect the actual pinned conversation, without writing controls or query data. */
export function observeNativeConversation(runId: string, read: () => ConversationProofFrame) {
  const frames = conversationFrames.get(runId) ?? new Set<() => ConversationProofFrame>();
  conversationFrames.set(runId, frames);
  frames.add(read);
  return () => {
    frames.delete(read);
    if (!frames.size && conversationFrames.get(runId) === frames) conversationFrames.delete(runId);
  };
}
interface VisualReviewProofFrame {
  focused: boolean;
  run: Run | null;
  recipes: ResourceQueryState<RunRecipeRunsForRunResult>;
  state: VisualReviewScreenState;
  target: ResourceQueryState<RunGetResult>;
  commandsReady: boolean;
}
const visualFrames = new Map<string, () => VisualReviewProofFrame>();
/** Read the mounted visual-review projection without modifying its draft or shared cache. */
export function observeNativeVisualReview(runId: string, read: () => VisualReviewProofFrame) {
  visualFrames.set(runId, read);
  return () => {
    if (visualFrames.get(runId) === read) visualFrames.delete(runId);
  };
}
interface FamilyProofFrame {
  focused: boolean;
  routeRunId: string;
  snapshot: FamilyObservabilitySnapshot | null;
  selectedFullRun: Run | null;
  runIds: readonly string[];
  recipes: readonly ResourceQueryState<RunRecipeRunsForRunResult>[];
}
const familyFrames = new Map<string, Set<() => FamilyProofFrame>>();
interface DiffProofFrame {
  focused: boolean;
  run: Run | null;
  recipes: ResourceQueryState<RunRecipeRunsForRunResult>;
}
const diffFrames = new Map<string, Set<() => DiffProofFrame>>();
export interface SlotProofFrame extends Omit<DiffProofFrame, 'recipes'> {
  /** The slot and diff frames read recipes; the terminal frame has none. */
  recipes?: ResourceQueryState<RunRecipeRunsForRunResult>;
  // Dev-only render evidence. These fields never fetch or adopt query data.
  ac4SlotId?: string;
  ac4Slot?: SlotStatus;
  ac4ProgressQuery?: ResourceQuery<TaskProgressResult>;
  ac4Progress?: ResourceQueryState<TaskProgressResult>;
  ac4RenderedProgress?: TaskProgressStructured;
  ac4ProgressShown?: boolean;
  ac4DiffQuery?: ResourceQuery<GitDiffResult>;
  ac4Diff?: ResourceQueryState<GitDiffResult>;
  ac4DiffText?: string;
  history?: ResourceQueryState<SlotRunHistoryResult>;
  historyRunIds?: readonly string[];
  historyRuns?: readonly ResourceQueryState<RunGetResult>[];
  historyRecipes?: readonly ResourceQueryState<RunRecipeRunsForRunResult>[];
  terminalReady?: boolean;
  terminalTarget?: import('@farmslot/protocol').SlotAgentTargetParams;
  terminalInputDisabledReason?: string | null;
  terminalStream?: string;
  terminalControlBusy?: boolean;
  terminalControlError?: string | null;
  terminalSnapshotError?: string | null;
  readTerminalText?: () => Promise<string>;
  terminalInputCommands?: number;
  terminalSubscriptionStarts?: number;
  terminalDraft?: string;
  terminalSends?: readonly string[];
  terminalReinit?: string;
  terminalWorker?: import('@farmslot/protocol').TmuxWorkerRef | null;
  terminalNative?: boolean;
}
const slotFrames = new Map<string, Set<() => SlotProofFrame>>();

/** Inspect real slot workspace inputs without changing the mounted view or its cache. */
export function observeNativeSlotFrame(
  kind: 'slot' | 'slot-diff' | 'terminal',
  runId: string,
  read: () => SlotProofFrame,
) {
  const key = `${kind}:${runId}`;
  const frames = slotFrames.get(key) ?? new Set<() => SlotProofFrame>();
  slotFrames.set(key, frames);
  frames.add(read);
  return () => {
    frames.delete(read);
    if (!frames.size && slotFrames.get(key) === frames) slotFrames.delete(key);
  };
}
interface ArtifactProofFrame {
  focused: boolean;
  run: Run | null;
  recipes: ResourceQueryState<RunRecipeRunsForRunResult>;
  query?: ResourceQuery<RunRecipeRunsForRunResult>;
  decisionId?: string;
  artifactPaths: readonly string[];
  syncBusy: boolean;
}
const artifactFrames = new Map<string, Set<() => ArtifactProofFrame>>();

/** Read the artifact view's actual selection and render inputs without changing them. */
export function observeNativeArtifactFrame(runId: string, read: () => ArtifactProofFrame) {
  const frames = artifactFrames.get(runId) ?? new Set<() => ArtifactProofFrame>();
  artifactFrames.set(runId, frames);
  frames.add(read);
  return () => {
    frames.delete(read);
    if (!frames.size && artifactFrames.get(runId) === frames) artifactFrames.delete(runId);
  };
}

/** Observe the focused diff's actual render inputs, without adopting or seeding data. */
export function observeNativeDiffFrame(runId: string, read: () => DiffProofFrame) {
  const frames = diffFrames.get(runId) ?? new Set<() => DiffProofFrame>();
  diffFrames.set(runId, frames);
  frames.add(read);
  return () => {
    frames.delete(read);
    if (!frames.size && diffFrames.get(runId) === frames) diffFrames.delete(runId);
  };
}

/** Observe the production render projection without changing any UI or cache value. */
export function observeNativeFamilyFrame(familyId: string, read: () => FamilyProofFrame) {
  const frames = familyFrames.get(familyId) ?? new Set<() => FamilyProofFrame>();
  familyFrames.set(familyId, frames);
  frames.add(read);
  return () => {
    frames.delete(read);
    if (!frames.size && familyFrames.get(familyId) === frames) familyFrames.delete(familyId);
  };
}

/** Inspect metadata through the store's write queue; never create or adopt cache data. */
async function storedNativeQuery(
  diagnostics: NativeResourceStoreDiagnostics,
  workspaceKey: string | undefined,
  queryId: string,
): Promise<StoredResourceQueryInfo | undefined> {
  if (!workspaceKey) return undefined;
  const scope = JSON.parse(workspaceKey).scope;
  if (typeof scope !== 'string') throw new Error('The native resource owner has no store scope.');
  return nativeResourceQueryInfo(scope, queryId, diagnostics.filename);
}

/** Read production projections and actual store diagnostics without issuing a query. */
export const observeRunCollectionsProof: FarmslotRecipeUiObserver = async (refs) => {
  const match =
    /^runs-cache:(detail|family|diff|artifacts|slot|slot-diff|terminal|visual|conversation):([a-f0-9-]{36})$/.exec(
      refs[0] ?? '',
    );
  const detailId = match?.[2];
  const visual = detailId && match?.[1] === 'visual' ? visualFrames.get(detailId)?.() : undefined;
  const family =
    match?.[1] === 'family' && detailId
      ? getResourceCache()?.read(
          resourceQuery<FamilyObservabilityGetResult>('family.observability.get', {
            familyId: detailId,
          }),
        )
      : undefined;
  if (refs[0] !== 'runs-cache:snapshot' && !detailId) return undefined;
  const runStore = useRunStore.getState();
  const decisionStore = useDecisionStore.getState();
  const fleetStore = useFleetStore.getState();
  const cache = getResourceCache();
  const conversation =
    detailId && match?.[1] === 'conversation'
      ? [...(conversationFrames.get(detailId) ?? [])]
          .map((read) => read())
          .find((value) => value.focused)
      : undefined;
  const diagnostics = await nativeResourceStoreDiagnostics();
  const storedFleet = fleetStore.observation.data
    ? await storedNativeQuery(diagnostics, getResourceWorkspaceKey(), nativeFleetQuery.id)
    : undefined;
  const storedHistory = conversation?.historyQuery
    ? await storedNativeQuery(
        diagnostics,
        getResourceWorkspaceKey(),
        nativeHistoryStorageId(conversation.historyQuery),
      )
    : undefined;
  const historyMessages = conversation?.timeline.filter(
    (entry) => entry.kind === 'user' || entry.kind === 'assistant',
  );
  const storedDetail =
    detailId && match?.[1] === 'terminal'
      ? await storedNativeQuery(
          diagnostics,
          getResourceWorkspaceKey(),
          resourceQuery('run.get', { runId: detailId }).id,
        )
      : undefined;
  const slotFrame = detailId
    ? [...(slotFrames.get(`${match?.[1]}:${detailId}`) ?? [])]
        .map((read) => read())
        .find((value) => value.focused)
    : undefined;
  const artifactFrame = detailId
    ? [...(artifactFrames.get(detailId) ?? [])].map((read) => read()).find((value) => value.focused)
    : undefined;
  const diffFrame = detailId
    ? [...(diffFrames.get(detailId) ?? [])].map((read) => read()).find((value) => value.focused)
    : undefined;
  const frame = detailId
    ? [...(familyFrames.get(detailId) ?? [])].map((read) => read()).find((value) => value.focused)
    : undefined;
  const familySelected = frame?.selectedFullRun
    ? cache?.read(resourceQuery<RunGetResult>('run.get', { runId: frame.selectedFullRun.id }))
    : undefined;
  return {
    observations: {
      runCollections: {
        platform: Platform.OS,
        startedAt,
        appStateHistory: [...appStateHistory],
        planningFilters: useFilterStore.getState().filters,
        backlogObservation: cache?.read(resourceQuery('backlog.list', { includeArchived: true })),
        backlogReadyTouches: readBacklogReadyTouches(),
        online: useConnectionStore.getState().client?.connectionState === 'connected',
        connectionGeneration: useConnectionStore.getState().client?.connectionGeneration,
        connectionProfileId: useConnectionStore.getState().activeProfileId,
        connectionProfileIds: useConnectionStore.getState().profiles.map((profile) => profile.id),
        // Inspect existing cache entries only. This does not observe, fetch or seed these reads.
        domainObservations: Object.fromEntries(
          (['prWatch.list', 'prRules.list', 'prPush.list', 'copilot.status'] as const).map(
            (method) => {
              const query = resourceQuery(method);
              const state = cache?.read(query);
              return [
                method,
                {
                  id: query.id,
                  persisted: query.persisted,
                  status: state?.status ?? 'loading',
                  hasData: state?.data !== undefined,
                  // Existing authenticated query values, read-only and never persisted here.
                  data: state?.data,
                  observedAt: state?.observedAt,
                  errorCode: state?.error?.code,
                  errorMessage: state?.error?.message,
                  resourceState: state?.resourceState,
                },
              ];
            },
          ),
        ),
        ...(conversation
          ? {
              conversation: {
                history: {
                  status: conversation.historyObservation.status,
                  observedAt: conversation.historyObservation.observedAt,
                  canonical: Boolean(
                    conversation.historyQuery &&
                    conversation.historyObservation === cache?.read(conversation.historyQuery),
                  ),
                  stored: storedHistory,
                  messageCount: historyMessages?.length ?? 0,
                  firstMessage: historyMessages?.[0]?.text,
                  lastMessage: historyMessages?.at(-1)?.text,
                },
                observation: conversation.observation,
                canonical:
                  conversation.observation ===
                  cache?.read(resourceQuery<RunGetResult>('run.get', { runId: detailId })),
                selection: conversation.selection,
                worker: conversation.worker,
                session: conversation.session
                  ? {
                      id: conversation.session.id,
                      executionNodeId: conversation.session.executionNodeId,
                      generation: conversation.session.generation,
                      workerLeaseId: conversation.session.workerLeaseId,
                      ownerPrincipalId: conversation.session.ownerPrincipalId,
                      state: conversation.session.state,
                      cwd: conversation.session.cwd,
                    }
                  : undefined,
                cursor: conversation.cursor,
                eventCount: conversation.eventCount,
                pageReadCount: conversation.pageReadCount,
                pageAfters: conversation.pageAfters,
                timeline: conversation.timeline.slice(-50),
                commands: conversation.commands.map(
                  ({ commandId, generation, state, submitted, accepted, queued }) => ({
                    commandId,
                    generation,
                    state,
                    submitted,
                    accepted,
                    queued,
                  }),
                ),
                draft: conversation.draft,
                pendingCommandId: conversation.pendingCommandId,
                pendingText: conversation.pendingText,
                responses: conversation.responses,
                ready: conversation.ready,
                caughtUp: conversation.caughtUp,
                writable: conversation.writable,
                canSend: conversation.canSend,
                resumeAvailable: conversation.resumeAvailable,
                resumeReady: conversation.resumeReady,
                busy: conversation.busy,
              },
            }
          : {}),
        ...(visual?.focused
          ? {
              visualState:
                visual.state.status === 'ready'
                  ? {
                      status: visual.state.status,
                      source: visual.state.source,
                      draft: visual.state.draft,
                      delivery: visual.state.delivery,
                      targetRunId: visual.state.targetRunId,
                    }
                  : visual.state,
              visualCommandsReady: visual.commandsReady,
              visualRunCanonical:
                visual.run ===
                cache?.read(resourceQuery<RunGetResult>('run.get', { runId: detailId })).data?.run,
              visualRecipesCanonical:
                visual.recipes ===
                cache?.read(
                  resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
                    runId: detailId,
                  }),
                ),
              visualRecipes: visual.recipes,
              visualTarget: visual.target,
            }
          : {}),
        workspaceKey: getResourceWorkspaceKey(),
        fleet: {
          status: fleetStore.observation.status,
          resourceState: fleetStore.observation.resourceState,
          observedAt: fleetStore.observation.observedAt,
          canonical: fleetStore.observation === cache?.read(nativeFleetQuery),
          projectionMatches: fleetStore.fleet === fleetStore.observation.data?.fleet,
          data: fleetStore.fleet,
          stored: storedFleet,
        },
        storedDetail,
        runsStatus: runStore.observation.status,
        runsObservedAt: runStore.observation.observedAt,
        runs: runStore.runs.map(({ id, ticketOrPr, tags }) => ({ id, ticketOrPr, tags })),
        activeIds: cache?.read(nativeActiveRunsQuery).data?.runs.map(({ id }) => id),
        historyLoaded: runStore.historyLoaded,
        decisionsStatus: decisionStore.observation.status,
        decisionsObservedAt: decisionStore.observation.observedAt,
        decisions: decisionStore.decisions.map(({ id, title }) => ({ id, title })),
        decisionProjectionMatches: decisionStore.observation === cache?.read(nativeDecisionsQuery),
        ...(slotFrame && detailId
          ? {
              nativeAc4: {
                version: 1,
                focused: slotFrame.focused,
                runId: slotFrame.run?.id,
                slotId: slotFrame.ac4SlotId,
                slot: slotFrame.ac4Slot,
                slotCanonical: Boolean(
                  slotFrame.ac4Slot &&
                  slotFrame.ac4Slot ===
                    cache
                      ?.read(nativeFleetQuery)
                      .data?.fleet.slots.find((slot) => slot.slot === slotFrame.ac4SlotId),
                ),
                ...(slotFrame.ac4ProgressQuery
                  ? {
                      progress: {
                        query: {
                          id: slotFrame.ac4ProgressQuery.id,
                          method: slotFrame.ac4ProgressQuery.method,
                          params: slotFrame.ac4ProgressQuery.params,
                        },
                        observation: slotFrame.ac4Progress,
                        canonical:
                          slotFrame.ac4Progress === cache?.read(slotFrame.ac4ProgressQuery),
                        rendered: slotFrame.ac4RenderedProgress,
                        shown: slotFrame.ac4ProgressShown,
                      },
                    }
                  : {}),
                ...(slotFrame.ac4DiffQuery
                  ? {
                      diff: {
                        query: {
                          id: slotFrame.ac4DiffQuery.id,
                          method: slotFrame.ac4DiffQuery.method,
                          params: slotFrame.ac4DiffQuery.params,
                        },
                        observation: slotFrame.ac4Diff,
                        canonical: slotFrame.ac4Diff === cache?.read(slotFrame.ac4DiffQuery),
                        text: slotFrame.ac4DiffText,
                      },
                    }
                  : {}),
              },
              slotProjectionMatches:
                slotFrame.run ===
                cache?.read(resourceQuery<RunGetResult>('run.get', { runId: detailId })).data?.run,
              slotRecipesMatch:
                slotFrame.recipes ===
                cache?.read(
                  resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
                    runId: detailId,
                  }),
                ),
              slotRecipes: slotFrame.recipes,
              terminalReady: slotFrame.terminalReady,
              terminalTarget: slotFrame.terminalTarget,
              terminalInputDisabledReason: slotFrame.terminalInputDisabledReason,
              terminalStream: slotFrame.terminalStream,
              terminalControlBusy: slotFrame.terminalControlBusy,
              terminalControlError: slotFrame.terminalControlError,
              terminalSnapshotError: slotFrame.terminalSnapshotError,
              terminalBufferText: await slotFrame.readTerminalText?.(),
              terminalInputCommands: slotFrame.terminalInputCommands,
              terminalSubscriptionStarts: slotFrame.terminalSubscriptionStarts,
              terminalDraft: slotFrame.terminalDraft,
              terminalSends: slotFrame.terminalSends,
              terminalReinit: slotFrame.terminalReinit,
              terminalWorker: slotFrame.terminalWorker,
              terminalNative: slotFrame.terminalNative,
              slotHistory: slotFrame.history,
              slotHistoryReadCount: slotFrame.historyRunIds?.length,
              slotHistoryReadsReady: Boolean(
                slotFrame.historyRunIds?.length &&
                slotFrame.historyRuns?.length === slotFrame.historyRunIds.length &&
                slotFrame.historyRecipes?.length === slotFrame.historyRunIds.length &&
                slotFrame.historyRuns.every((read) => read.status === 'ready' && read.data) &&
                slotFrame.historyRecipes.every((read) => read.status === 'ready' && read.data),
              ),
              slotHistoryDetailsMatch: slotFrame.historyRunIds?.every(
                (runId, index) =>
                  slotFrame.historyRuns?.[index] ===
                  cache?.read(resourceQuery<RunGetResult>('run.get', { runId })),
              ),
              slotHistoryRecipesMatch: slotFrame.historyRunIds?.every(
                (runId, index) =>
                  slotFrame.historyRecipes?.[index] ===
                  cache?.read(
                    resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', { runId }),
                  ),
              ),
            }
          : {}),
        ...(match?.[1] === 'artifacts' && detailId
          ? {
              artifactProjectionMatches: Boolean(
                artifactFrame?.query &&
                artifactFrame.run ===
                  cache?.read(resourceQuery<RunGetResult>('run.get', { runId: detailId })).data
                    ?.run &&
                artifactFrame.recipes === cache?.read(artifactFrame.query),
              ),
              artifactRecipes: artifactFrame?.recipes,
              artifactParams: artifactFrame?.query?.params,
              artifactDecisionId: artifactFrame?.decisionId,
              artifactPaths: artifactFrame?.artifactPaths,
              artifactSyncBusy: artifactFrame?.syncBusy,
            }
          : {}),
        ...(match?.[1] === 'diff' && detailId
          ? {
              diffProjectionMatches: Boolean(
                diffFrame &&
                diffFrame.run ===
                  cache?.read(resourceQuery<RunGetResult>('run.get', { runId: detailId })).data
                    ?.run &&
                diffFrame.recipes ===
                  cache?.read(
                    resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
                      runId: detailId,
                    }),
                  ),
              ),
              diffRecipes: diffFrame?.recipes,
            }
          : {}),
        ...(family
          ? {
              family,
              familySelected,
              familyRouteRunId: frame?.routeRunId,
              familySelectionInRoute: Boolean(
                frame?.selectedFullRun && frame.routeRunId === frame.selectedFullRun.id,
              ),
              familyProjectionMatches: Boolean(frame && frame.snapshot === family.data?.snapshot),
              selectedRunProjectionMatches: Boolean(
                frame && frame.selectedFullRun === familySelected?.data?.run,
              ),
              familyRecipeProjectionMatches: Boolean(
                frame &&
                frame.runIds.length === family.data?.snapshot.runs.length &&
                frame.recipes.length === frame.runIds.length &&
                frame.recipes.every(
                  (state, index) =>
                    state ===
                    cache?.read(
                      resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
                        runId: frame.runIds[index],
                      }),
                    ),
                ),
              ),
              familyRecipes: family.data?.snapshot.runs.map(({ runId }) => ({
                runId,
                status: cache?.read(
                  resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', { runId }),
                ).status,
              })),
            }
          : {}),
        ...(detailId
          ? {
              detail: cache?.read(resourceQuery<RunGetResult>('run.get', { runId: detailId })),
              recipes: cache?.read(
                resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
                  runId: detailId,
                  includeRecordedEvidence: true,
                }),
              ),
            }
          : {}),
        diagnostics,
      },
    },
  };
};
