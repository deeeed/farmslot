import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent, ScrollView } from 'react-native';
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
  Events,
  type FamilyObservabilityGetResult,
  type FamilyObservabilitySnapshot,
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type SlotRunHistoryEntry,
  type SlotRunHistoryResult,
  type TaskProgressResult,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import {
  artifactsForRecipeRun,
  artifactUrlForEntry,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
  resolveRecipeRunSelection,
} from '../../lib/artifact-url';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { runRefreshEventMatchesSlotWorkspace, runRefreshEventRunId } from '../../lib/run-refresh';
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
  shouldAcceptTaskProgressUpdate,
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
import { routeParamString } from '../workspace-shared/route-params';

import type {
  HistoryRecipeEvidenceSummary,
  HistoryRunVisualEvidenceSummary,
} from './slot-workspace-model';

export function useSlotWorkspaceController() {
  const {
    id,
    runId: routeRunId,
    recipeRun: routeRecipeRunId,
    artifact: routeArtifactPath,
    workspace,
    decisionKind,
  } = useLocalSearchParams<{
    id: string;
    runId?: string | string[];
    recipeRun?: string | string[];
    artifact?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
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
  const [taskProgress, setTaskProgress] = useState<TaskProgressResult | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [currentRecipeRuns, setCurrentRecipeRuns] = useState<RecipeRunArtifactGroup[]>([]);
  const [currentRecipeRunsLoaded, setCurrentRecipeRunsLoaded] = useState(false);
  const [familySnapshot, setFamilySnapshot] = useState<FamilyObservabilitySnapshot | null>(null);
  const [selectedRecipeRunId, setSelectedRecipeRunId] = useState<string | null>(null);
  const [slotHistory, setSlotHistory] = useState<SlotRunHistoryEntry[]>([]);
  const [historyRecipeEvidence, setHistoryRecipeEvidence] = useState<
    Record<string, HistoryRecipeEvidenceSummary>
  >({});
  const [historyRunVisualEvidence, setHistoryRunVisualEvidence] = useState<
    Record<string, HistoryRunVisualEvidenceSummary>
  >({});
  const [detailError, setDetailError] = useState<string | null>(null);
  const [navLayout, setNavLayout] = useState<WorkspaceStickyNavLayout | null>(null);
  const [stickyNavVisible, setStickyNavVisibleState] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const slotHistoryRequestRef = useRef(0);
  const workspaceRunRequestRef = useRef(0);
  const currentRecipeRunsRequestRef = useRef(0);
  const stickyNavVisibleRef = useRef(false);
  const scrollY = useSharedValue(0);
  const workspaceRunId = selectSlotWorkspaceRunId({
    requestedRunId,
    currentRunId: slot?.currentRunId,
    history: slotHistory,
  });
  const workspaceRecipeRunId =
    requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : (selectedRecipeRunId ?? requestedRecipeRunId) || null;
  const slotWorkerProgressActive = isSlotWorkerProgressActive(slot);
  const taskProgressTrackingActive = slotWorkerProgressActive || isWorkerProgressActive(currentRun);

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

  const fetchTaskProgress = useCallback(() => {
    if (!client || !id || !workspaceRunId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, {
        slotId: id,
        runId: workspaceRunId,
      })
      .then((result) => {
        setTaskProgress(result);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [client, id, workspaceRunId]);

  useEffect(() => {
    if (!workspaceRunId) {
      setTaskProgress(null);
      setTaskProgressError(null);
    }
  }, [workspaceRunId]);

  const refreshSlotHistory = useCallback(
    async (reason: string) => {
      if (!client || !id) return;
      const requestId = slotHistoryRequestRef.current + 1;
      slotHistoryRequestRef.current = requestId;
      try {
        const result = await client.request<SlotRunHistoryResult>('run.slotHistory', {
          slotId: id,
          limit: 8,
        });
        if (slotHistoryRequestRef.current !== requestId) return;
        setSlotHistory(result.runs);
      } catch (err) {
        if (slotHistoryRequestRef.current !== requestId) return;
        setDetailError(
          `Failed to refresh slot run history after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, id],
  );

  const refreshWorkspaceRun = useCallback(
    async (reason: string) => {
      if (!client || !workspaceRunId) return;
      const requestId = workspaceRunRequestRef.current + 1;
      workspaceRunRequestRef.current = requestId;
      try {
        const result = await client.request<RunGetResult>('run.get', {
          runId: workspaceRunId,
        });
        if (workspaceRunRequestRef.current !== requestId) return;
        setCurrentRun(result.run);
        setDetailError(null);
      } catch (err) {
        if (workspaceRunRequestRef.current !== requestId) return;
        setDetailError(
          `Failed to refresh workspace run after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, workspaceRunId],
  );

  useEffect(() => {
    void refreshSlotHistory('initial load');
  }, [refreshSlotHistory]);

  useEffect(() => {
    if (!workspaceRunId) {
      setCurrentRun(null);
      setCurrentRecipeRuns([]);
      setFamilySnapshot(null);
      setSelectedRecipeRunId(null);
      return;
    }
    setCurrentRun(null);
    void refreshWorkspaceRun('initial load');
  }, [refreshWorkspaceRun, workspaceRunId]);

  useEffect(() => {
    if (!client || !currentRun?.familyId) {
      setFamilySnapshot(null);
      return;
    }
    let disposed = false;
    client
      .request<FamilyObservabilityGetResult>('family.observability.get', {
        familyId: currentRun.familyId,
        project: currentRun.project,
      })
      .then((result) => {
        if (!disposed) setFamilySnapshot(result.snapshot);
      })
      .catch((err: Error) => {
        if (!disposed) {
          setFamilySnapshot(null);
          setDetailError(`Failed to load family context: ${err.message}`);
        }
      });
    return () => {
      disposed = true;
    };
  }, [client, currentRun?.familyId, currentRun?.project]);

  const historyRecipeRunIds = useMemo(
    () =>
      slotHistory
        .filter((entry) => entry.runId !== workspaceRunId)
        .slice(0, 5)
        .map((entry) => entry.runId),
    [slotHistory, workspaceRunId],
  );
  const _historyRecipeRunIdsKey = historyRecipeRunIds.join('\n');

  useEffect(() => {
    if (!client || historyRecipeRunIds.length === 0) {
      setHistoryRecipeEvidence({});
      return;
    }
    let disposed = false;
    const runIds = [...historyRecipeRunIds];
    Promise.allSettled(
      runIds.map((historyRunId) =>
        client
          .request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
            runId: historyRunId,
          })
          .then((result) => [historyRunId, result.recipeRuns] as const),
      ),
    )
      .then((results) => {
        if (disposed) return;
        const nextEvidence: Record<string, HistoryRecipeEvidenceSummary> = {};
        const failed = results.find((result) => result.status === 'rejected');
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const [historyRunId, recipeRuns] = result.value;
          const compareTarget = selectSlotCompareTarget({
            runArtifacts: [],
            recipeRuns,
            selectedRecipeRunId: null,
          });
          nextEvidence[historyRunId] = {
            artifactCount: recipeRuns.reduce(
              (sum, group) => sum + artifactsForRecipeRun(group).length,
              0,
            ),
            pairCount: compareTarget?.pairCount ?? 0,
            recipeRunId: compareTarget?.recipeRunId ?? null,
            artifactPath: compareTarget?.artifactPath ?? null,
            primaryPair:
              groupVisualArtifactPairs(
                selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
                (artifact) => artifactUrlForEntry(gatewayUrl, historyRunId, artifact),
              ).pairs[0] ?? null,
          };
        }
        setHistoryRecipeEvidence(nextEvidence);
        if (failed) {
          setDetailError(
            `Failed to load recent recipe evidence: ${(failed.reason as Error).message}`,
          );
        }
      })
      .catch((err: Error) => {
        if (!disposed) setDetailError(`Failed to load recent recipe evidence: ${err.message}`);
      });
    return () => {
      disposed = true;
    };
  }, [client, gatewayUrl, historyRecipeRunIds]);

  useEffect(() => {
    if (!client || historyRecipeRunIds.length === 0) {
      setHistoryRunVisualEvidence({});
      return;
    }
    let disposed = false;
    const runIds = [...historyRecipeRunIds];
    Promise.allSettled(
      runIds.map((historyRunId) =>
        client.request<RunGetResult>('run.get', { runId: historyRunId }).then((result) => {
          const runArtifacts = result.run ? extractRunArtifactManifest(result.run) : [];
          const pairs = groupVisualArtifactPairs(runArtifacts, (artifact) =>
            artifactUrlForEntry(gatewayUrl, historyRunId, artifact),
          ).pairs;
          return [
            historyRunId,
            { pairCount: pairs.length, primaryPair: pairs[0] ?? null },
          ] as const;
        }),
      ),
    )
      .then((results) => {
        if (disposed) return;
        const nextEvidence: Record<string, HistoryRunVisualEvidenceSummary> = {};
        const failed = results.find((result) => result.status === 'rejected');
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const [historyRunId, evidence] = result.value;
          nextEvidence[historyRunId] = evidence;
        }
        setHistoryRunVisualEvidence(nextEvidence);
        if (failed) {
          setDetailError(
            `Failed to load recent visual evidence: ${(failed.reason as Error).message}`,
          );
        }
      })
      .catch((err: Error) => {
        if (!disposed) setDetailError(`Failed to load recent visual evidence: ${err.message}`);
      });
    return () => {
      disposed = true;
    };
  }, [client, gatewayUrl, historyRecipeRunIds]);

  const refreshCurrentRecipeRuns = useCallback(
    async (reason: string, reset: boolean) => {
      if (!client || !workspaceRunId) return;
      const requestId = currentRecipeRunsRequestRef.current + 1;
      currentRecipeRunsRequestRef.current = requestId;
      if (reset) {
        setCurrentRecipeRuns([]);
        setCurrentRecipeRunsLoaded(false);
        setSelectedRecipeRunId(null);
      }
      try {
        const result = await client.request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
          runId: workspaceRunId,
        });
        if (currentRecipeRunsRequestRef.current !== requestId) return;
        setCurrentRecipeRuns(result.recipeRuns);
        setCurrentRecipeRunsLoaded(true);
        if (requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM) {
          setSelectedRecipeRunId(null);
          return;
        }
        setSelectedRecipeRunId(
          resolveRecipeRunSelection(
            result.recipeRuns,
            requestedRecipeRunId,
            result.selectedRecipeRunId,
          ),
        );
        setDetailError(null);
      } catch (err) {
        if (currentRecipeRunsRequestRef.current !== requestId) return;
        setCurrentRecipeRunsLoaded(true);
        setDetailError(
          `Failed to refresh recipe artifacts after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, requestedRecipeRunId, workspaceRunId],
  );

  useEffect(() => {
    if (!workspaceRunId) {
      setCurrentRecipeRuns([]);
      setCurrentRecipeRunsLoaded(false);
      setSelectedRecipeRunId(null);
      return;
    }
    void refreshCurrentRecipeRuns('initial load', true);
  }, [refreshCurrentRecipeRuns, workspaceRunId]);

  useEffect(() => {
    if (!client || !id) return;
    const knownRunIds = slotHistory.map((entry) => entry.runId);
    const handleRunEvent = (payload: unknown, reason: string) => {
      const event = payload as { run?: Run; runId?: string };
      if (
        !runRefreshEventMatchesSlotWorkspace({ slotId: id, workspaceRunId, knownRunIds }, event)
      ) {
        return;
      }
      const eventRunId = runRefreshEventRunId(event);
      if (event.run?.id === workspaceRunId) {
        workspaceRunRequestRef.current += 1;
        setCurrentRun(event.run);
        setDetailError(null);
      } else if (eventRunId === workspaceRunId) {
        void refreshWorkspaceRun(reason);
      }
      void refreshSlotHistory(reason);
      if (eventRunId === workspaceRunId || event.run?.slotId === id) {
        void refreshCurrentRecipeRuns(reason, false);
      }
    };
    const unsubscribers = [
      client.subscribe(Events.RUN_CREATED, (payload) => handleRunEvent(payload, 'run.created')),
      client.subscribe(Events.RUN_UPDATED, (payload) => handleRunEvent(payload, 'run.updated')),
      client.subscribe(Events.RUN_COMPLETED, (payload) => handleRunEvent(payload, 'run.completed')),
      client.subscribe(Events.RUN_STEP_COMPLETED, (payload) =>
        handleRunEvent(payload, 'run.step.completed'),
      ),
      client.subscribe(Events.RUN_DECISION_NEW, (payload) =>
        handleRunEvent(payload, 'run.decision.new'),
      ),
      client.subscribe(Events.RUN_DECISION_RESOLVED, (payload) =>
        handleRunEvent(payload, 'run.decision.resolved'),
      ),
      client.subscribe(Events.RUN_DECISION_UPDATED, (payload) =>
        handleRunEvent(payload, 'run.decision.updated'),
      ),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    client,
    id,
    refreshCurrentRecipeRuns,
    refreshSlotHistory,
    refreshWorkspaceRun,
    slotHistory,
    workspaceRunId,
  ]);

  useEffect(() => {
    if (!client || !id || !workspaceRunId || !taskProgressTrackingActive) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (currentRun) {
        if (!shouldAcceptTaskProgressUpdate(currentRun, update)) return;
      } else if (update.slotId !== id || update.runId !== workspaceRunId) {
        return;
      }
      setTaskProgress(update.progress);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, currentRun, id, taskProgressTrackingActive, workspaceRunId]);

  useEffect(() => {
    if (!taskProgressTrackingActive) return;
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTaskProgress, taskProgressTrackingActive]);

  const activeTaskProgress = effectiveTaskProgressForRun(currentRun, taskProgress?.structured);
  const shouldShowTaskProgress =
    Boolean(activeTaskProgress?.totalSteps) && taskProgressTrackingActive;
  const fallbackTaskProgress = taskProgressTrackingActive
    ? fallbackTaskProgressSummary(currentRun, slot)
    : null;
  const openLiveTerminal = () => {
    if (!id) return;
    router.push({
      pathname: '/terminal/[slotId]',
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
  const currentCompareTarget = currentRun
    ? selectSlotCompareTarget({
        runArtifacts: extractRunArtifactManifest(currentRun),
        recipeRuns: currentRecipeRuns,
        selectedRecipeRunId,
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
    workspaceRecipeRunId,
    requestedArtifactPath,
    workspaceRouteContext,
    taskProgressError,
    currentRun,
    currentRecipeRuns,
    currentRecipeRunsLoaded,
    familySnapshot,
    selectedRecipeRunId,
    slotHistory,
    historyRecipeEvidence,
    historyRunVisualEvidence,
    detailError,
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
