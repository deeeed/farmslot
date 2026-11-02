import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent, ScrollViewInstance } from 'react-native';
import {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  extractRunArtifactManifest,
  type FamilyObservabilityGetResult,
  Methods,
  type RecipeRunArtifactGroup,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type SlotRunHistoryEntry,
  type SlotRunHistoryResult,
  type TaskProgressResult,
} from '@farmslot/protocol';
import { type ResourceQuery, resourceQuery } from '@farmslot/protocol/client-cache';

import { observeNativeSlotFrame } from '../../farmslot/run-collections-proof';
import { useResourceQueries, useResourceQuery } from '../../hooks/useResourceQuery';
import { useRunAcceptance } from '../../hooks/useRunAcceptance';
import {
  artifactsForRecipeRun,
  artifactUrlForEntry,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
  resolveRecipeRunSelection,
} from '../../lib/artifact-url';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { getResourceCache, getResourceWorkspaceKey } from '../../lib/resource-cache';
import { readErrorMessage } from '../../lib/resource-read-status';
import { summarizeSlotFamilyContext } from '../../lib/slot-family-context';
import {
  hasRunWorkspaceDiff,
  selectSlotCompareTarget,
  selectSlotRecipeArtifactsForPreviewScope,
  selectSlotWorkspaceRunId,
  summarizeSlotWorkspaceGates,
  summarizeSlotWorkspaceRetro,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isSlotWorkerProgressActive,
  isWorkerProgressActive,
  taskProgressRequestForRun,
} from '../../lib/task-progress';
import {
  selectPrimaryWorkspaceDecision,
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  workspaceDecisionKind,
} from '../../lib/workspace-decisions';
import { workspaceGateNavMeta, workspaceRetroNavMeta } from '../../lib/workspace-nav-meta';
import {
  targetWorkspaceRouteContextParams,
  workspaceNavCurrentForRoute,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import {
  type WorkspaceStickyNavLayout,
  workspaceStickyNavThreshold,
} from '../../lib/workspace-sticky-nav';
import { useConnectionStore } from '../../store/connection';
import { useFleetStore } from '../../store/fleet';
import { heldConnectionCurrent } from '../../store/held-connection';
import { routeParamString } from '../workspace-shared/route-params';

import type {
  HistoryRecipeEvidenceSummary,
  HistoryRunVisualEvidenceSummary,
} from './slot-workspace-model';

const emptyHistory: SlotRunHistoryEntry[] = [];
const emptyRecipes: RecipeRunArtifactGroup[] = [];

export function useSlotWorkspaceController() {
  const {
    id: routeId,
    slotId: routeSlotId,
    runId: routeRunId,
    recipeRun: routeRecipeRunId,
    artifact: routeArtifactPath,
    workspace,
    decisionKind,
  } = useLocalSearchParams<{
    id?: string | string[];
    slotId?: string | string[];
    runId?: string | string[];
    recipeRun?: string | string[];
    artifact?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const id = routeParamString(routeId ?? routeSlotId).trim();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const focused = useIsFocused();
  const slot = useFleetStore((s) => s.fleet?.slots.find((sl) => sl.slot === id));
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const requestedRunId = routeParamString(routeRunId).trim();
  const requestedRecipeRunId = routeParamString(routeRecipeRunId).trim();
  const requestedArtifactPath = routeParamString(routeArtifactPath).trim();
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        'slot',
      ),
    [decisionKind, workspace],
  );

  const historyQuery = useMemo(
    () =>
      id
        ? resourceQuery<SlotRunHistoryResult>(Methods.RUN_SLOT_HISTORY, { slotId: id, limit: 8 })
        : undefined,
    [id],
  );
  const historyObservation = useResourceQuery(historyQuery);
  const slotHistory = historyObservation.data?.runs ?? emptyHistory;
  const boundRunId = historyObservation.data
    ? (slotHistory.find((entry) => entry.currentForSlot)?.runId ?? null)
    : slot?.currentRunId;
  const workspaceRunId = selectSlotWorkspaceRunId({
    requestedRunId,
    currentRunId: boundRunId,
    history: slotHistory,
  });
  const runQuery = useMemo(
    () =>
      workspaceRunId
        ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: workspaceRunId })
        : undefined,
    [workspaceRunId],
  );
  const runObservation = useResourceQuery(runQuery);
  const currentRun = runObservation.data?.run ?? null;
  const progressQuery = useMemo(() => {
    const target = taskProgressRequestForRun(currentRun);
    return target ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, target) : undefined;
  }, [currentRun?.id, currentRun?.slotId, currentRun?.reviewWorkspace?.workspaceId]);
  const progressObservation = useResourceQuery(progressQuery);
  const taskProgress = progressObservation.data ?? null;
  const progressReadError = readErrorMessage(progressObservation, heldConnectionCurrent());
  const taskProgressError = progressReadError
    ? `Task progress unavailable: ${progressReadError}`
    : null;
  const recipeQuery = useMemo(
    () =>
      workspaceRunId
        ? resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, {
            runId: workspaceRunId,
          })
        : undefined,
    [workspaceRunId],
  );
  const recipeObservation = useResourceQuery(recipeQuery);
  const currentRecipeRuns = recipeObservation.data?.recipeRuns ?? emptyRecipes;
  const currentRecipeRunsLoaded = Boolean(recipeObservation.data);
  const familyQuery = useMemo(
    () =>
      currentRun?.familyId
        ? resourceQuery<FamilyObservabilityGetResult>(Methods.FAMILY_OBSERVABILITY_GET, {
            familyId: currentRun.familyId,
            project: currentRun.project,
          })
        : undefined,
    [currentRun?.familyId, currentRun?.project],
  );
  const familyObservation = useResourceQuery(familyQuery);
  const familySnapshot = familyObservation.data?.snapshot ?? null;
  const workspaceKey = getResourceWorkspaceKey();
  const selectionScope = JSON.stringify([workspaceKey, id, workspaceRunId, requestedRecipeRunId]);
  const [recipeSelection, setRecipeSelection] = useState<{ scope: string; id: string | null }>();
  const selectedRecipeRunId =
    requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? null
      : resolveRecipeRunSelection(
          currentRecipeRuns,
          recipeSelection?.scope === selectionScope ? recipeSelection.id : requestedRecipeRunId,
          recipeObservation.data?.selectedRecipeRunId,
        );
  const setSelectedRecipeRunId = (next: string | null) =>
    setRecipeSelection({ scope: selectionScope, id: next });
  const historyRecipeRunIds = useMemo(
    () =>
      slotHistory
        .filter((entry) => entry.runId !== workspaceRunId)
        .slice(0, 5)
        .map((entry) => entry.runId),
    [slotHistory, workspaceRunId],
  );
  const historyRecipeQueries = useMemo(
    () =>
      historyRecipeRunIds.map((runId) =>
        resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, { runId }),
      ),
    [historyRecipeRunIds],
  );
  const historyRunQueries = useMemo(
    () =>
      historyRecipeRunIds.map((runId) => resourceQuery<RunGetResult>(Methods.RUN_GET, { runId })),
    [historyRecipeRunIds],
  );
  const historyRecipes = useResourceQueries(historyRecipeQueries);
  const historyRuns = useResourceQueries(historyRunQueries);
  const historyRecipeEvidence = useMemo(
    () =>
      Object.fromEntries(
        historyRecipeRunIds.flatMap((runId, index) => {
          const recipeRuns = historyRecipes[index]?.data?.recipeRuns;
          if (!recipeRuns) return [];
          const target = selectSlotCompareTarget({
            runArtifacts: [],
            recipeRuns,
            selectedRecipeRunId: null,
          });
          const summary: HistoryRecipeEvidenceSummary = {
            artifactCount: recipeRuns.reduce(
              (sum, group) => sum + artifactsForRecipeRun(group).length,
              0,
            ),
            pairCount: target?.pairCount ?? 0,
            recipeRunId: target?.recipeRunId ?? null,
            artifactPath: target?.artifactPath ?? null,
            primaryPair:
              groupVisualArtifactPairs(
                selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
                (artifact) => artifactUrlForEntry(gatewayUrl, runId, artifact),
              ).pairs[0] ?? null,
          };
          return [[runId, summary]];
        }),
      ),
    [gatewayUrl, historyRecipeRunIds, historyRecipes],
  );
  const historyRunVisualEvidence = useMemo(
    () =>
      Object.fromEntries(
        historyRecipeRunIds.flatMap((runId, index) => {
          const run = historyRuns[index]?.data?.run;
          if (!run) return [];
          const pairs = groupVisualArtifactPairs(extractRunArtifactManifest(run), (artifact) =>
            artifactUrlForEntry(gatewayUrl, runId, artifact),
          ).pairs;
          const summary: HistoryRunVisualEvidenceSummary = {
            pairCount: pairs.length,
            primaryPair: pairs[0] ?? null,
          };
          return [[runId, summary]];
        }),
      ),
    [gatewayUrl, historyRecipeRunIds, historyRuns],
  );
  const readObservations = [
    { observation: historyObservation, label: 'slot history' },
    { observation: runObservation, label: 'slot run' },
    { observation: progressObservation, label: 'task progress' },
    { observation: recipeObservation, label: 'slot recipe inventory' },
    { observation: familyObservation, label: 'family' },
    ...historyRecipes.map((observation) => ({ observation, label: 'run history evidence' })),
    ...historyRuns.map((observation) => ({ observation, label: 'history run' })),
  ];
  const retryRead = async () => {
    const cache = getResourceCache();
    const queries: Array<ResourceQuery<unknown> | undefined> = [
      historyQuery,
      runQuery,
      progressQuery,
      recipeQuery,
      familyQuery,
      ...historyRecipeQueries,
      ...historyRunQueries,
    ];
    await Promise.all(
      queries
        .filter((query) => query && cache?.read(query).error)
        .map((query) => cache?.retry(query!)),
    );
  };
  const slotWorkerProgressActive = isSlotWorkerProgressActive(slot);
  const taskProgressTrackingActive = slotWorkerProgressActive || isWorkerProgressActive(currentRun);
  const activeTaskProgress = effectiveTaskProgressForRun(currentRun, taskProgress?.structured);
  const shouldShowTaskProgress =
    Boolean(activeTaskProgress?.totalSteps) && taskProgressTrackingActive;
  const fallbackTaskProgress = taskProgressTrackingActive
    ? fallbackTaskProgressSummary(currentRun, slot)
    : null;
  const frame = useRef({
    focused,
    ac4SlotId: id,
    ac4Slot: slot,
    ac4ProgressQuery: progressQuery,
    ac4Progress: progressObservation,
    ac4RenderedProgress: shouldShowTaskProgress ? activeTaskProgress : undefined,
    ac4ProgressShown: shouldShowTaskProgress,
    run: currentRun,
    recipes: recipeObservation,
    history: historyObservation,
    historyRecipes,
    historyRuns,
    historyRunIds: historyRecipeRunIds,
  });
  frame.current = {
    focused,
    ac4SlotId: id,
    ac4Slot: slot,
    ac4ProgressQuery: progressQuery,
    ac4Progress: progressObservation,
    ac4RenderedProgress: shouldShowTaskProgress ? activeTaskProgress : undefined,
    ac4ProgressShown: shouldShowTaskProgress,
    run: currentRun,
    recipes: recipeObservation,
    history: historyObservation,
    historyRecipes,
    historyRuns,
    historyRunIds: historyRecipeRunIds,
  };
  useEffect(() => {
    if (__DEV__ && workspaceRunId)
      return observeNativeSlotFrame('slot', workspaceRunId, () => frame.current);
  }, [workspaceRunId]);
  const [navLayout, setNavLayout] = useState<WorkspaceStickyNavLayout | null>(null);
  const [stickyNavVisible, setStickyNavVisibleState] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const stickyNavVisibleRef = useRef(false);
  const scrollY = useSharedValue(0);
  const workspaceRecipeRunId =
    requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : (selectedRecipeRunId ?? requestedRecipeRunId) || null;

  const setStickyNavVisible = useCallback((visible: boolean) => {
    if (stickyNavVisibleRef.current === visible) return;
    stickyNavVisibleRef.current = visible;
    setStickyNavVisibleState(visible);
  }, []);
  const stickyThreshold = workspaceStickyNavThreshold(navLayout);
  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
  });
  const stickyNavStyle = useAnimatedStyle(() => {
    const progress = interpolate(
      scrollY.value,
      [stickyThreshold, stickyThreshold + 40],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return {
      opacity: progress,
      transform: [
        {
          translateY: interpolate(progress, [0, 1], [-8, 0], Extrapolation.CLAMP),
        },
      ],
    };
  }, [stickyThreshold]);

  useAnimatedReaction(
    () => scrollY.value > stickyThreshold + 8,
    (visible, previous) => {
      if (visible !== previous) runOnJS(setStickyNavVisible)(visible);
    },
    [setStickyNavVisible, stickyThreshold],
  );

  const rememberNavLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setNavLayout({ y, height });
  }, []);

  const openLiveTerminal = () => {
    if (!id) return;
    router.push({
      pathname: '/workspace/slot/[slotId]/terminal',
      params: {
        slotId: id,
        ...targetWorkspaceRouteContextParams('terminal', workspaceRouteContext.decisionKind),
        details: '1',
        ...(workspaceRunId ? { runId: workspaceRunId } : {}),
        ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
        ...(requestedArtifactPath ? { artifact: requestedArtifactPath } : {}),
      },
    });
  };
  const currentRecipeArtifactCount = currentRecipeRuns.reduce(
    (sum, group) => sum + artifactsForRecipeRun(group).length,
    0,
  );
  const currentRecipeAvailable = currentRecipeRunsLoaded
    ? currentRecipeArtifactCount > 0
    : undefined;
  const currentArtifactCount = currentRun ? extractRunArtifactManifest(currentRun).length : null;
  const primaryDecision = selectPrimaryWorkspaceDecision(currentRun);
  const readyDecision = selectReadyWorkspaceDecision(currentRun);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(currentRun);
  const retroDecision = selectRetrospectiveWorkspaceDecision(currentRun);
  const navFamilySummary = summarizeSlotFamilyContext(familySnapshot);
  const currentWorkspaceGates = currentRun ? summarizeSlotWorkspaceGates(currentRun) : [];
  const currentReadyGate =
    currentWorkspaceGates.find((gate) => gate.label === 'Ready workspace') ?? null;
  const currentReviewGate =
    currentWorkspaceGates.find(
      (gate) => gate.label === 'Review workspace' || gate.label === 'No-change review',
    ) ?? null;
  const currentRetroSummary = currentRun ? summarizeSlotWorkspaceRetro(currentRun) : null;
  const currentDiffAvailable = currentRun
    ? hasRunWorkspaceDiff(currentRun, currentWorkspaceGates[0] ?? null)
    : undefined;
  const currentAcceptance = useRunAcceptance(client, currentRun, {
    ...(selectedRecipeRunId
      ? { recipeRunId: selectedRecipeRunId }
      : primaryDecision?.payload?.kind === 'ready'
        ? { decisionId: primaryDecision.id }
        : {}),
  });
  const currentEvidenceModel = currentAcceptance.evidenceModel;
  const currentCompareTarget = currentRun
    ? selectSlotCompareTarget({
        runArtifacts: extractRunArtifactManifest(currentRun),
        recipeRuns: currentRecipeRuns,
        selectedRecipeRunId,
        evidenceModel: currentEvidenceModel,
      })
    : null;
  const workspaceNavProps = {
    dense: true,
    current: workspaceNavCurrentForRoute('slot', workspaceRouteContext.workspace),
    decisionId: primaryDecision?.id ?? null,
    decisionKind: workspaceDecisionKind(primaryDecision),
    routeWorkspace: workspaceRouteContext.workspace,
    routeDecisionKind: workspaceRouteContext.decisionKind,
    readyDecisionId: readyDecision?.id ?? null,
    reviewDecisionId: reviewGateDecision?.id ?? null,
    retroDecisionId: retroDecision?.id ?? null,
    readyMeta: workspaceGateNavMeta(currentReadyGate),
    reviewMeta: workspaceGateNavMeta(currentReviewGate),
    retroMeta: workspaceRetroNavMeta(currentRetroSummary),
    familyRetrospectiveCount: navFamilySummary?.retrospectives,
    pendingFamilyRetrospectiveCount: navFamilySummary?.pendingRetrospectives,
    familyId: currentRun?.familyId,
    project: currentRun?.project,
    prNumber: currentRun?.prNumber,
    prRepo: prRepoFromWorkspaceSource(currentRun, currentRun?.prNumber ?? null),
    recipeRunId: workspaceRecipeRunId,
    recipeAvailable: currentRecipeAvailable,
    recipeArtifactCount: currentRecipeRunsLoaded ? currentRecipeArtifactCount : null,
    diffAvailable: currentDiffAvailable,
    artifactCount: currentArtifactCount,
    visualPairCount: currentCompareTarget?.pairCount ?? 0,
    compareArtifactPath: currentCompareTarget?.artifactPath ?? null,
    compareRecipeRunId: currentCompareTarget?.recipeRunId,
    artifactPath: requestedArtifactPath || null,
    slotId: slot?.slot ?? id ?? '',
    runId: currentRun?.id ?? workspaceRunId,
  };

  return {
    insets,
    router,
    id,
    slot,
    workspaceRunId,
    boundRunId,
    workspaceRecipeRunId,
    requestedArtifactPath,
    workspaceRouteContext,
    taskProgressError,
    currentRun,
    runObservation,
    progressObservation,
    historyObservation,
    recipeObservation,
    retryRead,
    currentRecipeRuns,
    currentRecipeRunsLoaded,
    currentEvidenceModel,
    familySnapshot,
    selectedRecipeRunId,
    slotHistory,
    historyRecipeEvidence,
    historyRunVisualEvidence,
    readObservations,
    navLayout,
    stickyNavVisible,
    scrollRef,
    scrollHandler,
    stickyNavStyle,
    rememberNavLayout,
    shouldShowTaskProgress,
    activeTaskProgress,
    fallbackTaskProgress,
    workspaceNavProps,
    gatewayUrl,
    artifactAuthHeaders,
    setSelectedRecipeRunId,
    openLiveTerminal,
  };
}
