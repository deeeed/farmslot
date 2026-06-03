import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
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
  type RunDecision,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type SlotRunHistoryEntry,
  type SlotRunHistoryResult,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import { BeforeAfterPreview } from '../../components/BeforeAfterPreview';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { TaskProgressFallbackPanel, TaskProgressPanel } from '../../components/TaskProgressPanel';
import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactSource,
  artifactUrl,
  artifactUrlForEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
  resolveRecipeRunSelection,
  type VisualArtifactPair,
} from '../../lib/artifact-url';
import { type DecisionPresentation, presentDecision } from '../../lib/decision-presentation';
import { diffArtifactCandidate } from '../../lib/diff';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { runRefreshEventMatchesSlotWorkspace, runRefreshEventRunId } from '../../lib/run-refresh';
import {
  type SlotFamilyContextSummary,
  summarizeSlotFamilyContext,
} from '../../lib/slot-family-context';
import {
  describeSlotWorkspaceRunFocus,
  hasRunWorkspaceDiff,
  isActionableWorkspaceDiffValue,
  orderSlotWorkspaceGatesForFocus,
  runWorkspaceDiffValue,
  selectSlotCompareTarget,
  selectSlotGatePreviewArtifacts,
  selectSlotRecipeArtifactsForPreviewScope,
  selectSlotRecipePreviewArtifacts,
  selectSlotRunEvidencePreviewArtifacts,
  selectSlotWorkspaceRunId,
  type SlotCompareTarget,
  slotHistoryCompareWorkspaceParams,
  slotHistoryRecipeWorkspaceParams,
  type SlotRecipeEvidenceSummary,
  type SlotWorkspaceGateSummary,
  type SlotWorkspaceRetroSummary,
  type SlotWorkspaceRunFocus,
  summarizeSlotRecipeEvidence,
  summarizeSlotWorkspaceGates,
  summarizeSlotWorkspaceRetro,
  workspaceGateDiffMetricValue,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isSlotWorkerProgressActive,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
  taskProgressPercent,
  taskProgressTitle,
} from '../../lib/task-progress';
import { baseStyles, colors, fonts, lifecycleColor, radii, spacing } from '../../lib/theme';
import {
  selectPrimaryWorkspaceDecision,
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  workspaceDecisionKind,
} from '../../lib/workspace-decisions';
import { workspaceGateNavMeta, workspaceRetroNavMeta } from '../../lib/workspace-nav-meta';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceForArtifactRoute,
  targetWorkspaceRouteContextParams,
  workspaceNavCurrentForRoute,
  workspaceRouteContextParams,
  workspaceSignalTargetForDecisionLabel,
} from '../../lib/workspace-navigation';
import {
  type WorkspaceStickyNavLayout,
  workspaceStickyNavThreshold,
} from '../../lib/workspace-sticky-nav';
import { useConnectionStore } from '../../store/connection';
import { useFleetStore } from '../../store/fleet';

const RUN_STATUS_COLORS: Record<string, string> = {
  done: colors.statusOk,
  failed: colors.statusFail,
  cancelled: colors.statusWarn,
  monitoring: colors.lifecycleWorking,
  preparing: colors.lifecycleDispatching,
  dispatching: colors.lifecycleDispatching,
  'writing-task': colors.accent,
  grading: colors.accent,
  'slot-finding': colors.accent,
  paused: colors.statusWarn,
};

const TONE_COLORS: Record<DecisionPresentation['tone'], string> = {
  ok: colors.statusOk,
  warn: colors.statusWarn,
  fail: colors.statusFail,
  info: colors.accent,
};

type SlotHistoryWorkspaceEntry = SlotRunHistoryEntry & {
  prNumber?: number | null;
  links?: Array<{ label?: string | null; url?: string | null }> | null;
};

interface HistoryRecipeEvidenceSummary {
  artifactCount: number;
  pairCount: number;
  recipeRunId: string | null;
  artifactPath: string | null;
  primaryPair: VisualArtifactPair | null;
}

interface HistoryRunVisualEvidenceSummary {
  pairCount: number;
  primaryPair: VisualArtifactPair | null;
}

function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDuration(ms: number | undefined): string {
  if (!ms) return '-';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

type SlotWorkspaceRouteFocus = ReturnType<typeof workspaceRouteContextParams>['workspace'];

function slotGateFocusForWorkspace(
  workspace: SlotWorkspaceRouteFocus,
): 'ready' | 'review' | 'no-change' | null {
  if (workspace === 'ready') return 'ready';
  if (workspace === 'review') return 'review';
  return null;
}

function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}

export default function SlotDetailScreen() {
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
      transform: [{ translateY: interpolate(progress, [0, 1], [-8, 0], Extrapolation.CLAMP) }],
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
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, { slotId: id, runId: workspaceRunId })
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
        const result = await client.request<RunGetResult>('run.get', { runId: workspaceRunId });
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
  }, [
    client,
    currentRun?.decisions.length,
    currentRun?.familyId,
    currentRun?.project,
    currentRun?.updatedAt,
  ]);

  const historyRecipeRunIds = useMemo(
    () =>
      slotHistory
        .filter((entry) => entry.runId !== workspaceRunId)
        .slice(0, 5)
        .map((entry) => entry.runId),
    [slotHistory, workspaceRunId],
  );
  const historyRecipeRunIdsKey = historyRecipeRunIds.join('\n');

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
          .request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', { runId: historyRunId })
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
  }, [client, gatewayUrl, historyRecipeRunIds, historyRecipeRunIdsKey]);

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
  }, [client, gatewayUrl, historyRecipeRunIds, historyRecipeRunIdsKey]);

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

  if (!slot) {
    return (
      <View style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom }]}>
        <Text style={baseStyles.textSecondary}>Slot not found</Text>
      </View>
    );
  }

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
    slotId: slot.slot,
    runId: currentRun?.id ?? workspaceRunId,
  };

  return (
    <View style={baseStyles.container}>
      <Animated.View
        pointerEvents={stickyNavVisible && navLayout !== null ? 'auto' : 'none'}
        style={[styles.stickyWorkspaceNav, stickyNavStyle]}
      >
        <RunWorkspaceNav {...workspaceNavProps} />
      </Animated.View>
      <Animated.ScrollView
        ref={scrollRef}
        style={baseStyles.container}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: styles.scrollContent.paddingBottom + insets.bottom },
        ]}
      >
        <View style={styles.headerCard}>
          <View style={styles.row}>
            <Text style={styles.slotName}>{slot.slot}</Text>
            <View
              style={[styles.badge, { backgroundColor: lifecycleColor(slot.lifecycle) + '30' }]}
            >
              <Text style={[styles.badgeText, { color: lifecycleColor(slot.lifecycle) }]}>
                {slot.lifecycle}
              </Text>
            </View>
          </View>
          <Text style={baseStyles.textSecondary}>
            {slot.machine} | {slot.platform}
          </Text>
          {slot.branch && (
            <Text style={[baseStyles.textSecondary, { marginTop: spacing.sm }]}>{slot.branch}</Text>
          )}
          {slot.dispatchedAt && (
            <Text style={baseStyles.textMuted}>Dispatched {relativeTime(slot.dispatchedAt)}</Text>
          )}
        </View>

        <View onLayout={rememberNavLayout}>
          <RunWorkspaceNav {...workspaceNavProps} />
        </View>

        {detailError ? <Text style={styles.errorText}>{detailError}</Text> : null}

        <SlotWorkspaceSection
          slotId={slot.slot}
          slotCurrentRunId={slot.currentRunId}
          run={currentRun}
          recipeRuns={currentRecipeRuns}
          recipeRunsLoaded={currentRecipeRunsLoaded}
          selectedRecipeRunId={selectedRecipeRunId}
          familySnapshot={familySnapshot}
          history={slotHistory}
          focusedArtifactPath={requestedArtifactPath || null}
          historyRecipeEvidence={historyRecipeEvidence}
          historyRunVisualEvidence={historyRunVisualEvidence}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          activeTaskProgress={shouldShowTaskProgress ? activeTaskProgress : undefined}
          fallbackTaskProgress={!shouldShowTaskProgress ? fallbackTaskProgress : null}
          taskProgressError={taskProgressError}
          workspaceRouteContext={workspaceRouteContext}
          routeWorkspace={workspaceRouteContext.workspace}
          onOpenTerminal={openLiveTerminal}
          onSelectRecipeRun={(recipeRunId) => {
            setSelectedRecipeRunId(recipeRunId);
            router.setParams({
              id,
              ...workspaceRouteContext,
              ...(workspaceRunId ? { runId: workspaceRunId } : {}),
              recipeRun: recipeRunId ?? undefined,
            });
          }}
        />

        {/* Health Grid */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Health</Text>
          <View style={styles.healthGrid}>
            {Object.entries(slot.health).map(([key, val]) => (
              <View key={key} style={styles.healthItem}>
                <Text style={styles.healthLabel}>{key}</Text>
                <Text style={[styles.healthValue, { color: healthColor(val) }]}>{val}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Runner / Model */}
        {(slot.runner || slot.model) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Worker</Text>
            <View style={styles.infoRow}>
              {slot.runner && <Text style={baseStyles.textPrimary}>Runner: {slot.runner}</Text>}
              {slot.model && <Text style={baseStyles.textPrimary}>Model: {slot.model}</Text>}
            </View>
          </View>
        )}
      </Animated.ScrollView>
    </View>
  );
}

function SlotWorkspaceSection({
  slotId,
  slotCurrentRunId,
  run,
  recipeRuns,
  recipeRunsLoaded,
  selectedRecipeRunId,
  familySnapshot,
  history,
  focusedArtifactPath,
  historyRecipeEvidence,
  historyRunVisualEvidence,
  gatewayUrl,
  artifactAuthHeaders,
  activeTaskProgress,
  fallbackTaskProgress,
  taskProgressError,
  workspaceRouteContext,
  routeWorkspace,
  onOpenTerminal,
  onSelectRecipeRun,
}: {
  slotId: string;
  slotCurrentRunId?: string | null;
  run: Run | null;
  recipeRuns: RecipeRunArtifactGroup[];
  recipeRunsLoaded: boolean;
  selectedRecipeRunId: string | null;
  familySnapshot: FamilyObservabilitySnapshot | null;
  history: SlotRunHistoryEntry[];
  focusedArtifactPath?: string | null;
  historyRecipeEvidence: Record<string, HistoryRecipeEvidenceSummary>;
  historyRunVisualEvidence: Record<string, HistoryRunVisualEvidenceSummary>;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  activeTaskProgress?: TaskProgressStructured;
  fallbackTaskProgress?: ReturnType<typeof fallbackTaskProgressSummary> | null;
  taskProgressError?: string | null;
  workspaceRouteContext: ReturnType<typeof workspaceRouteContextParams>;
  routeWorkspace?: ReturnType<typeof workspaceRouteContextParams>['workspace'];
  onOpenTerminal: () => void;
  onSelectRecipeRun: (recipeRunId: string | null) => void;
}) {
  const router = useRouter();
  const slotWorkspaceRouteContext = workspaceRouteContext;
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, slotWorkspaceRouteContext.decisionKind);
  const visibleHistory = history.filter((entry) => entry.runId !== run?.id).slice(0, 5);
  const latestHistoryEntry = visibleHistory[0] ?? null;
  const latestHistoryRecipeEvidence = latestHistoryEntry
    ? historyRecipeEvidence[latestHistoryEntry.runId]
    : undefined;
  const latestHistoryRunVisualEvidence = latestHistoryEntry
    ? historyRunVisualEvidence[latestHistoryEntry.runId]
    : undefined;
  const latestComparePairCount = latestHistoryEntry
    ? Math.max(
        latestHistoryRunVisualEvidence?.pairCount ?? latestHistoryEntry.visualPairCount,
        latestHistoryRecipeEvidence?.pairCount ?? 0,
      )
    : 0;
  const latestCompareTarget = latestHistoryEntry
    ? slotHistoryCompareWorkspaceParams({
        runPairCount:
          latestHistoryRunVisualEvidence?.pairCount ?? latestHistoryEntry.visualPairCount,
        runArtifactPath: latestHistoryRunVisualEvidence?.primaryPair?.after.path,
        recipePairCount: latestHistoryRecipeEvidence?.pairCount ?? 0,
        recipeRunId: latestHistoryRecipeEvidence?.recipeRunId,
        recipeArtifactPath: latestHistoryRecipeEvidence?.artifactPath,
      })
    : null;
  const latestComparePreviewPair =
    latestHistoryRunVisualEvidence?.primaryPair ?? latestHistoryRecipeEvidence?.primaryPair ?? null;
  const latestComparePreviewSource: 'run' | 'recipe' = latestHistoryRunVisualEvidence?.primaryPair
    ? 'run'
    : 'recipe';
  const openRunArtifacts = (
    runId: string,
    recipeRunId: string | null | undefined,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
    artifactPath?: string | null,
  ) => {
    const recipeRunParam = recipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM;
    const targetFilter =
      filter ??
      (recipeRunParam === DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? artifactFilterParamForWorkspaceNav('review')
        : artifactFilterParamForWorkspaceNav('recipe'));
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId,
        ...targetRouteContext(targetWorkspaceForArtifactRoute(recipeRunParam, targetFilter)),
        recipeRun: recipeRunParam,
        ...(targetFilter ? { filter: targetFilter } : {}),
        ...(artifactPath ? { artifact: artifactPath } : {}),
      },
    });
  };
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const openRunArtifact = (
    runId: string,
    artifactPath: string,
    recipeRunId?: string | null,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => {
    const recipeRunParam = recipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM;
    if (diffArtifactCandidate([{ path: artifactPath }])) {
      router.push({
        pathname: '/diff/[runId]',
        params: {
          runId,
          ...targetRouteContext('diff'),
          path: artifactPath,
          recipeRun: recipeRunParam,
        },
      });
      return;
    }
    const targetFilter =
      filter ??
      (recipeRunParam !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? artifactFilterParamForWorkspaceNav('recipe')
        : (artifactFilterParamForArtifactPath(artifactPath) ??
          artifactFilterParamForWorkspaceNav('review')));
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId,
        ...targetRouteContext(targetWorkspaceForArtifactRoute(recipeRunParam, targetFilter)),
        recipeRun: recipeRunParam,
        artifact: artifactPath,
        ...(targetFilter ? { filter: targetFilter } : {}),
      },
    });
  };
  const focusedCompareTarget = run
    ? selectSlotCompareTarget({
        runArtifacts: extractRunArtifactManifest(run),
        recipeRuns,
        selectedRecipeRunId,
      })
    : null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Workspace</Text>
      {run && focusedArtifactPath ? (
        <FocusedSlotArtifactCard
          artifactPath={focusedArtifactPath}
          recipeRunId={selectedRecipeRunId}
          familyId={run.familyId}
          prNumber={run.prNumber}
          onOpenRun={() =>
            router.push({
              pathname: '/run/[id]',
              params: {
                id: run.id,
                ...targetRouteContext('run'),
                recipeRun: selectedRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                artifact: focusedArtifactPath,
              },
            })
          }
          onOpenRecipe={() => {
            const recipeRunTarget = recipeWorkspaceParam(selectedRecipeRunId);
            openRunArtifacts(
              run.id,
              recipeRunTarget,
              artifactFilterParamForWorkspaceNav('recipe'),
              shouldPreserveArtifactForRecipeContext(recipeRunTarget, focusedArtifactPath)
                ? focusedArtifactPath
                : null,
            );
          }}
          onOpenArtifact={() =>
            openRunArtifact(
              run.id,
              focusedArtifactPath,
              selectedRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
            )
          }
          onOpenArtifacts={() =>
            openRunArtifacts(
              run.id,
              selectedRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
              artifactFilterParamForArtifactPath(focusedArtifactPath) ??
                artifactFilterParamForWorkspaceNav('review'),
            )
          }
          onOpenDiff={() =>
            hasRunWorkspaceDiff(run)
              ? router.push({
                  pathname: '/diff/[runId]',
                  params: {
                    runId: run.id,
                    ...targetRouteContext('diff'),
                    ...(focusedArtifactIsDiff && focusedArtifactPath
                      ? { path: focusedArtifactPath }
                      : {}),
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              : router.push({
                  pathname: '/diff/slot/[slotId]',
                  params: {
                    slotId,
                    ...targetRouteContext('diff'),
                    ...(focusedArtifactIsDiff && focusedArtifactPath
                      ? { path: focusedArtifactPath }
                      : {}),
                  },
                })
          }
          comparePairCount={focusedCompareTarget?.pairCount ?? 0}
          onOpenCompare={() => {
            if (!focusedCompareTarget) return;
            openRunArtifact(
              run.id,
              focusedCompareTarget.artifactPath,
              focusedCompareTarget.recipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
              artifactFilterParamForWorkspaceNav('compare'),
            );
          }}
          onOpenTerminal={onOpenTerminal}
          onOpenFamily={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('focus', slotWorkspaceRouteContext.decisionKind),
                runId: run.id,
                recipeRun: selectedRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                artifact: focusedArtifactPath,
                section: 'focus',
              },
            });
          }}
          onOpenPR={() => {
            if (!run.prNumber) return;
            const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
            router.push({
              pathname: '/(tabs)/prs',
              params: {
                pr: String(run.prNumber),
                ...targetRouteContext('pr'),
                ...(prRepo ? { repo: prRepo } : {}),
              },
            });
          }}
        />
      ) : null}
      {run ? (
        <ActiveRunWorkspaceCard
          run={run}
          recipeRuns={recipeRuns}
          recipeRunsLoaded={recipeRunsLoaded}
          selectedRecipeRunId={selectedRecipeRunId}
          familySummary={summarizeSlotFamilyContext(familySnapshot)}
          focus={describeSlotWorkspaceRunFocus({ runId: run.id, currentRunId: slotCurrentRunId })}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          activeTaskProgress={activeTaskProgress}
          fallbackTaskProgress={fallbackTaskProgress}
          taskProgressError={taskProgressError}
          routeWorkspace={routeWorkspace}
          onOpenTerminal={onOpenTerminal}
          onOpenRun={() =>
            router.push({
              pathname: '/run/[id]',
              params: {
                id: run.id,
                ...targetRouteContext('run'),
                recipeRun: selectedRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            })
          }
          onOpenArtifacts={() =>
            openRunArtifacts(
              run.id,
              DECISION_EVIDENCE_RECIPE_RUN_PARAM,
              undefined,
              focusedArtifactPath,
            )
          }
          onOpenGateArtifacts={(artifactPath) => {
            if (artifactPath) {
              openRunArtifact(
                run.id,
                artifactPath,
                DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                artifactFilterParamForWorkspaceNav('review'),
              );
              return;
            }
            openRunArtifacts(
              run.id,
              DECISION_EVIDENCE_RECIPE_RUN_PARAM,
              artifactFilterParamForWorkspaceNav('review'),
              focusedArtifactPath,
            );
          }}
          onOpenArtifact={(artifactPath) =>
            openRunArtifact(run.id, artifactPath, DECISION_EVIDENCE_RECIPE_RUN_PARAM)
          }
          onOpenRecipeArtifacts={(recipeRunId, artifactPath, filter) => {
            if (artifactPath) {
              openRunArtifact(run.id, artifactPath, recipeRunId, filter);
              return;
            }
            openRunArtifacts(
              run.id,
              recipeRunId,
              artifactFilterParamForWorkspaceNav('recipe'),
              recipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM ? focusedArtifactPath : null,
            );
          }}
          onSelectRecipeRun={onSelectRecipeRun}
          onOpenRecipe={() =>
            openRunArtifacts(
              run.id,
              recipeWorkspaceParam(selectedRecipeRunId),
              artifactFilterParamForWorkspaceNav('recipe'),
              selectedRecipeRunId ? focusedArtifactPath : null,
            )
          }
          onOpenDiff={() =>
            hasRunWorkspaceDiff(run)
              ? router.push({
                  pathname: '/diff/[runId]',
                  params: {
                    runId: run.id,
                    ...targetRouteContext('diff'),
                    ...(focusedArtifactIsDiff && focusedArtifactPath
                      ? { path: focusedArtifactPath }
                      : {}),
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              : router.push({
                  pathname: '/diff/slot/[slotId]',
                  params: {
                    slotId,
                    ...targetRouteContext('diff'),
                    ...(focusedArtifactIsDiff && focusedArtifactPath
                      ? { path: focusedArtifactPath }
                      : {}),
                  },
                })
          }
          onOpenFamily={() =>
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('focus', slotWorkspaceRouteContext.decisionKind),
                runId: run.id,
                recipeRun: selectedRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                section: 'focus',
              },
            })
          }
          onOpenFamilyEvidence={(targetRunId) => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams(
                  'evidence',
                  slotWorkspaceRouteContext.decisionKind,
                ),
                runId: targetRunId ?? run.id,
                section: 'evidence',
                ...(focusedArtifactPath && (!targetRunId || targetRunId === run.id)
                  ? { artifact: focusedArtifactPath }
                  : {}),
              },
            });
          }}
          onOpenFamilyCompare={(targetRunId) => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams(
                  'compare',
                  slotWorkspaceRouteContext.decisionKind,
                ),
                runId: targetRunId ?? run.id,
                section: 'compare',
                ...(focusedArtifactPath && (!targetRunId || targetRunId === run.id)
                  ? { artifact: focusedArtifactPath }
                  : {}),
              },
            });
          }}
          onOpenFamilyLedger={(targetRunId) => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams(
                  'ledger',
                  slotWorkspaceRouteContext.decisionKind,
                ),
                runId: targetRunId ?? run.id,
                section: 'ledger',
                ...(focusedArtifactPath && (!targetRunId || targetRunId === run.id)
                  ? { artifact: focusedArtifactPath }
                  : {}),
              },
            });
          }}
          onOpenFamilyRetros={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams(
                  'retros',
                  slotWorkspaceRouteContext.decisionKind,
                ),
                runId: run.id,
                section: 'retros',
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
          onOpenPR={() => {
            if (!run.prNumber) return;
            const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
            router.push({
              pathname: '/(tabs)/prs',
              params: {
                pr: String(run.prNumber),
                ...targetRouteContext('pr'),
                ...(prRepo ? { repo: prRepo } : {}),
              },
            });
          }}
          onOpenDecision={(decisionId, targetRunId, decisionKind) => {
            const targetDecision = run.decisions.find((decision) => decision.id === decisionId);
            const decisionRouteContext = decisionWorkspaceRouteParams(
              decisionKind ?? workspaceDecisionKind(targetDecision),
            );
            router.push({
              pathname: '/decision/[id]',
              params: {
                id: decisionId,
                ...decisionRouteContext,
                runId: targetRunId ?? run.id,
                ...(focusedArtifactPath && (!targetRunId || targetRunId === run.id)
                  ? { artifact: focusedArtifactPath }
                  : {}),
              },
            });
          }}
          onOpenCurrentRun={
            slotCurrentRunId && slotCurrentRunId !== run.id
              ? () =>
                  router.replace({
                    pathname: '/slot/[id]',
                    params: {
                      id: slotId,
                      ...slotWorkspaceRouteContext,
                      runId: slotCurrentRunId,
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
              : undefined
          }
        />
      ) : (
        <View style={styles.readyWorkspaceCard}>
          <View style={styles.workspaceGateHeader}>
            <View>
              <Text style={styles.workspaceTitle}>Ready workspace</Text>
              <Text style={styles.recipeEvidenceMeta}>{slotId} · no active run</Text>
            </View>
            <WorkspaceAction label="Terminal" value="live" primary onPress={onOpenTerminal} />
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.workspaceActions}
          >
            <WorkspaceAction label="State" value="ready" primary onPress={onOpenTerminal} />
            <WorkspaceAction label="Scope" value="workspace" onPress={onOpenTerminal} />
            <WorkspaceAction
              label="Live diff"
              value="git.diff"
              onPress={() =>
                router.push({
                  pathname: '/diff/slot/[slotId]',
                  params: { slotId, ...targetRouteContext('diff') },
                })
              }
            />
            <WorkspaceAction label="Terminal" value="control" onPress={onOpenTerminal} />
            {latestHistoryEntry ? (
              <WorkspaceAction
                label="Latest run"
                value={shortId(latestHistoryEntry.runId)}
                onPress={() =>
                  router.setParams({
                    id: slotId,
                    runId: latestHistoryEntry.runId,
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  })
                }
              />
            ) : null}
            {latestHistoryEntry ? (
              <WorkspaceAction
                label="Latest evidence"
                value={
                  latestHistoryEntry.visualPairCount
                    ? `${latestHistoryEntry.visualPairCount} pairs`
                    : 'open'
                }
                onPress={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: latestHistoryEntry.runId,
                      ...targetRouteContext('artifacts'),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('review'),
                    },
                  })
                }
              />
            ) : null}
            {latestHistoryEntry && latestCompareTarget ? (
              <WorkspaceAction
                label="Latest compare"
                value={`${latestComparePairCount} pair${latestComparePairCount === 1 ? '' : 's'}`}
                onPress={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: latestHistoryEntry.runId,
                      ...targetRouteContext('compare'),
                      recipeRun: latestCompareTarget.recipeRun,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      ...(latestCompareTarget.artifact
                        ? { artifact: latestCompareTarget.artifact }
                        : {}),
                    },
                  })
                }
              />
            ) : null}
            {latestHistoryEntry ? (
              <WorkspaceAction
                label="Latest recipe"
                value={latestHistoryRecipeEvidence ? 'recipe' : 'open'}
                onPress={() => {
                  const recipeTarget = slotHistoryRecipeWorkspaceParams(
                    latestHistoryRecipeEvidence,
                  );
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: latestHistoryEntry.runId,
                      ...targetRouteContext('recipe'),
                      ...recipeTarget,
                      filter: artifactFilterParamForWorkspaceNav('recipe'),
                    },
                  });
                }}
              />
            ) : null}
            {latestHistoryEntry ? (
              <WorkspaceAction
                label="Latest terminal"
                value="history"
                onPress={() =>
                  router.push({
                    pathname: '/terminal/[slotId]',
                    params: {
                      slotId,
                      ...targetRouteContext('terminal'),
                      runId: latestHistoryEntry.runId,
                      details: '1',
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
                }
              />
            ) : null}
            {latestHistoryEntry?.familyId ? (
              <WorkspaceAction
                label="Latest family"
                value={shortId(latestHistoryEntry.familyId)}
                onPress={() =>
                  router.push({
                    pathname: '/family/[familyId]',
                    params: {
                      familyId: latestHistoryEntry.familyId,
                      project: latestHistoryEntry.project,
                      ...familySectionRouteContextParams(
                        'focus',
                        slotWorkspaceRouteContext.decisionKind,
                      ),
                      runId: latestHistoryEntry.runId,
                      section: 'focus',
                    },
                  })
                }
              />
            ) : null}
            {latestHistoryEntry?.familyId ? (
              <WorkspaceAction
                label="Latest retros"
                value="family"
                onPress={() =>
                  router.push({
                    pathname: '/family/[familyId]',
                    params: {
                      familyId: latestHistoryEntry.familyId,
                      project: latestHistoryEntry.project,
                      ...familySectionRouteContextParams(
                        'retros',
                        slotWorkspaceRouteContext.decisionKind,
                      ),
                      runId: latestHistoryEntry.runId,
                      section: 'retros',
                    },
                  })
                }
              />
            ) : null}
          </ScrollView>
          {latestHistoryEntry && latestComparePreviewPair ? (
            <View style={styles.historyComparePreview}>
              <BeforeAfterPreview
                pair={latestComparePreviewPair}
                authHeaders={artifactAuthHeaders}
                onOpenArtifact={(artifactPath) =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: latestHistoryEntry.runId,
                      ...targetRouteContext('compare'),
                      recipeRun:
                        latestComparePreviewSource === 'recipe'
                          ? (latestHistoryRecipeEvidence?.recipeRunId ??
                            CURRENT_ARTIFACTS_RECIPE_RUN_PARAM)
                          : DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      artifact: artifactPath,
                    },
                  })
                }
                eyebrow={
                  latestComparePreviewSource === 'recipe' ? 'Latest recipe evidence' : 'Latest run'
                }
                title={
                  latestComparePreviewSource === 'recipe'
                    ? 'Latest recipe before → after'
                    : 'Latest before → after'
                }
                hint="Tap to inspect"
                imageHeight={72}
              />
            </View>
          ) : null}
        </View>
      )}

      {visibleHistory.length > 0 ? (
        <View style={styles.recentRunsBlock}>
          <Text style={styles.recentRunsTitle}>Recent on this slot</Text>
          {visibleHistory.map((entry) => {
            const recipeEvidence = historyRecipeEvidence[entry.runId];
            const runVisualEvidence = historyRunVisualEvidence[entry.runId];
            const compareUsesRecipe =
              (runVisualEvidence?.pairCount ?? entry.visualPairCount) === 0 &&
              (recipeEvidence?.pairCount ?? 0) > 0;
            return (
              <HistoryRunCard
                key={entry.runId}
                entry={entry}
                slotId={slotId}
                onFocusRun={() =>
                  router.setParams({
                    id: slotId,
                    runId: entry.runId,
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  })
                }
                recipeEvidence={recipeEvidence}
                runVisualEvidence={runVisualEvidence}
                artifactAuthHeaders={artifactAuthHeaders}
                onOpenRun={() =>
                  router.push({
                    pathname: '/run/[id]',
                    params: {
                      id: entry.runId,
                      ...targetRouteContext('run'),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
                }
                onOpenArtifacts={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: entry.runId,
                      ...targetRouteContext('artifacts'),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('review'),
                    },
                  })
                }
                onOpenCompare={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: entry.runId,
                      ...targetRouteContext('compare'),
                      recipeRun: compareUsesRecipe
                        ? (recipeEvidence?.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM)
                        : DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      ...(compareUsesRecipe && recipeEvidence?.artifactPath
                        ? { artifact: recipeEvidence.artifactPath }
                        : {}),
                    },
                  })
                }
                onOpenCompareArtifact={(artifactPath, source) =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: entry.runId,
                      ...targetRouteContext('compare'),
                      recipeRun:
                        source === 'recipe'
                          ? (recipeEvidence?.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM)
                          : DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      artifact: artifactPath,
                    },
                  })
                }
                onOpenRecipe={() => {
                  const recipeTarget = slotHistoryRecipeWorkspaceParams(recipeEvidence);
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: entry.runId,
                      ...targetRouteContext('recipe'),
                      ...recipeTarget,
                      filter: artifactFilterParamForWorkspaceNav('recipe'),
                    },
                  });
                }}
                onOpenDiff={() =>
                  router.push({
                    pathname: '/diff/[runId]',
                    params: {
                      runId: entry.runId,
                      ...targetRouteContext('diff'),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
                }
                onOpenFamily={() =>
                  router.push({
                    pathname: '/family/[familyId]',
                    params: {
                      familyId: entry.familyId,
                      project: entry.project,
                      ...familySectionRouteContextParams(
                        'focus',
                        slotWorkspaceRouteContext.decisionKind,
                      ),
                      runId: entry.runId,
                      section: 'focus',
                    },
                  })
                }
                onOpenFamilyRetros={() =>
                  router.push({
                    pathname: '/family/[familyId]',
                    params: {
                      familyId: entry.familyId,
                      project: entry.project,
                      ...familySectionRouteContextParams(
                        'retros',
                        slotWorkspaceRouteContext.decisionKind,
                      ),
                      runId: entry.runId,
                      section: 'retros',
                    },
                  })
                }
                onOpenTerminal={() =>
                  router.push({
                    pathname: '/terminal/[slotId]',
                    params: {
                      slotId,
                      ...targetRouteContext('terminal'),
                      runId: entry.runId,
                      details: '1',
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
                }
                onOpenPR={() => {
                  const historyEntry = entry as SlotHistoryWorkspaceEntry;
                  if (!historyEntry.prNumber) return;
                  const prRepo = prRepoFromWorkspaceSource(historyEntry, historyEntry.prNumber);
                  router.push({
                    pathname: '/(tabs)/prs',
                    params: {
                      pr: String(historyEntry.prNumber),
                      ...targetRouteContext('pr'),
                      ...(prRepo ? { repo: prRepo } : {}),
                    },
                  });
                }}
              />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function FocusedSlotArtifactCard({
  artifactPath,
  recipeRunId,
  familyId,
  prNumber,
  onOpenRun,
  onOpenRecipe,
  onOpenArtifact,
  onOpenArtifacts,
  onOpenDiff,
  comparePairCount,
  onOpenCompare,
  onOpenTerminal,
  onOpenFamily,
  onOpenPR,
}: {
  artifactPath: string;
  recipeRunId: string | null;
  familyId?: string | null;
  prNumber?: number | null;
  onOpenRun: () => void;
  onOpenRecipe: () => void;
  onOpenArtifact: () => void;
  onOpenArtifacts: () => void;
  onOpenDiff: () => void;
  comparePairCount: number;
  onOpenCompare: () => void;
  onOpenTerminal: () => void;
  onOpenFamily: () => void;
  onOpenPR: () => void;
}) {
  const artifactKind = focusedArtifactKindLabel(artifactPath);
  const isDiff = shouldOpenFocusedArtifactAsDiff(artifactPath);
  const recipeScopeLabel = recipeWorkspaceScopeLabel(recipeRunId);
  return (
    <View style={styles.focusedArtifactCard}>
      <View style={styles.workspaceGateHeader}>
        <View style={styles.focusedArtifactTitleBlock}>
          <Text style={styles.focusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.focusedArtifactPath} numberOfLines={2}>
            {artifactPath}
          </Text>
          <Text style={styles.focusedArtifactMeta} numberOfLines={1}>
            {artifactKind} · {recipeRunId ? 'recipe context' : 'decision evidence'}
          </Text>
        </View>
        <WorkspaceAction
          label={isDiff ? 'Open diff' : 'Open'}
          value={isDiff ? 'diff' : 'artifact'}
          primary
          onPress={isDiff ? onOpenDiff : onOpenArtifact}
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceActions}
      >
        <WorkspaceAction label="Files" value="context" onPress={onOpenArtifacts} />
        <WorkspaceAction label="Recipe files" value={recipeScopeLabel} onPress={onOpenRecipe} />
        <WorkspaceAction
          label="Before→After"
          value={comparePairCount > 0 ? String(comparePairCount) : '-'}
          onPress={onOpenCompare}
          disabled={comparePairCount === 0}
        />
        <WorkspaceAction label="Diff" value={isDiff ? 'focused' : 'run'} onPress={onOpenDiff} />
        <WorkspaceAction label="Run detail" value="open" onPress={onOpenRun} />
        <WorkspaceAction
          label="Family"
          value={shortId(familyId)}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
        <WorkspaceAction
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
        <WorkspaceAction label="Terminal" value="live" onPress={onOpenTerminal} />
      </ScrollView>
    </View>
  );
}

function focusedArtifactKindLabel(artifactPath: string): string {
  if (shouldOpenFocusedArtifactAsDiff(artifactPath)) return 'diff';
  const filter = artifactFilterParamForArtifactPath(artifactPath);
  if (filter === 'recipes') return 'recipe file';
  if (filter === 'visual') return 'visual evidence';
  return 'evidence file';
}

function shouldOpenFocusedArtifactAsDiff(artifactPath: string): boolean {
  return Boolean(diffArtifactCandidate([{ path: artifactPath }]));
}

function ActiveRunWorkspaceCard({
  run,
  recipeRuns,
  recipeRunsLoaded,
  selectedRecipeRunId,
  familySummary,
  focus,
  gatewayUrl,
  artifactAuthHeaders,
  activeTaskProgress,
  fallbackTaskProgress,
  taskProgressError,
  routeWorkspace,
  onOpenTerminal,
  onOpenRun,
  onOpenArtifacts,
  onOpenGateArtifacts,
  onOpenArtifact,
  onOpenRecipeArtifacts,
  onSelectRecipeRun,
  onOpenRecipe,
  onOpenDiff,
  onOpenFamily,
  onOpenFamilyEvidence,
  onOpenFamilyCompare,
  onOpenFamilyLedger,
  onOpenFamilyRetros,
  onOpenPR,
  onOpenDecision,
  onOpenCurrentRun,
}: {
  run: Run;
  recipeRuns: RecipeRunArtifactGroup[];
  recipeRunsLoaded: boolean;
  selectedRecipeRunId: string | null;
  familySummary: SlotFamilyContextSummary | null;
  focus: SlotWorkspaceRunFocus;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  activeTaskProgress?: TaskProgressStructured;
  fallbackTaskProgress?: ReturnType<typeof fallbackTaskProgressSummary> | null;
  taskProgressError?: string | null;
  routeWorkspace?: ReturnType<typeof workspaceRouteContextParams>['workspace'];
  onOpenTerminal: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenGateArtifacts: (artifactPath?: string) => void;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenRecipeArtifacts: (
    recipeRunId: string,
    artifactPath?: string,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => void;
  onSelectRecipeRun: (recipeRunId: string | null) => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenFamily: () => void;
  onOpenFamilyEvidence: (runId?: string) => void;
  onOpenFamilyCompare: (runId?: string) => void;
  onOpenFamilyLedger: (runId?: string) => void;
  onOpenFamilyRetros: () => void;
  onOpenPR: () => void;
  onOpenDecision: (decisionId: string, runId?: string, decisionKind?: string) => void;
  onOpenCurrentRun?: () => void;
}) {
  const runArtifacts = extractRunArtifactManifest(run);
  const artifactCount = runArtifacts.length;
  const runPreviewArtifacts = selectSlotRunEvidencePreviewArtifacts(runArtifacts);
  const visualPairSummary = groupVisualArtifactPairs(runArtifacts, (artifact) =>
    artifactUrlForEntry(gatewayUrl, run.id, artifact),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const selectedRecipeRun = recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null;
  const recipeArtifactCount = selectedRecipeRun
    ? artifactsForRecipeRun(selectedRecipeRun).length
    : 0;
  const recipeEvidence = summarizeSlotRecipeEvidence(recipeRuns);
  const recipeAvailable = recipeRunsLoaded ? Boolean(recipeEvidence?.totalArtifacts) : undefined;
  const recipeMetricCount = recipeRunsLoaded
    ? (recipeEvidence?.totalArtifacts ?? recipeArtifactCount)
    : null;
  const recipePreviewArtifacts = selectSlotRecipePreviewArtifacts(recipeRuns, selectedRecipeRunId);
  const recipeVisualPairSummary = groupVisualArtifactPairs(
    selectSlotRecipeArtifactsForPreviewScope(recipeRuns, selectedRecipeRunId),
    (artifact) => artifactUrlForEntry(gatewayUrl, run.id, artifact),
  );
  const recipePrimaryVisualPair = recipeVisualPairSummary.pairs[0] ?? null;
  const priorityVisualPair = primaryVisualPair ?? recipePrimaryVisualPair;
  const priorityVisualPairIsRecipe = !primaryVisualPair && Boolean(recipePrimaryVisualPair);
  const priorityRecipeRunId = recipePrimaryVisualPair
    ? (recipeRuns.find((group) => {
        const artifacts = artifactsForRecipeRun(group);
        return artifacts.some(
          (artifact) =>
            artifact.path === recipePrimaryVisualPair.before.path ||
            artifact.path === recipePrimaryVisualPair.after.path,
        );
      })?.id ??
      selectedRecipeRunId ??
      recipeRuns[0]?.id ??
      CURRENT_ARTIFACTS_RECIPE_RUN_PARAM)
    : null;
  const compareTarget = selectSlotCompareTarget({
    runArtifacts,
    recipeRuns,
    selectedRecipeRunId,
  });
  const openPriorityVisualArtifact = (artifactPath: string) => {
    if (!priorityVisualPairIsRecipe) {
      onOpenArtifact(artifactPath);
      return;
    }
    onOpenRecipeArtifacts(
      priorityRecipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
      artifactPath,
      artifactFilterParamForWorkspaceNav('compare'),
    );
  };
  const openPriorityCompare = () => {
    if (primaryVisualPair) {
      onOpenArtifact(primaryVisualPair.after.path);
      return;
    }
    if (recipePrimaryVisualPair) {
      onOpenRecipeArtifacts(
        priorityRecipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
        recipePrimaryVisualPair.after.path,
        artifactFilterParamForWorkspaceNav('compare'),
      );
    }
  };
  const pendingDecisions = (run.decisions ?? []).filter((decision) => !decision.resolvedAt);
  const workspaceGates = orderSlotWorkspaceGatesForFocus(
    summarizeSlotWorkspaceGates(run),
    slotGateFocusForWorkspace(routeWorkspace),
  );
  const readyGate = workspaceGates.find((gate) => gate.label === 'Ready workspace') ?? null;
  const reviewGate =
    workspaceGates.find(
      (gate) => gate.label === 'Review workspace' || gate.label === 'No-change review',
    ) ?? null;
  const focusedWorkspaceGate =
    routeWorkspace === 'ready' ? readyGate : routeWorkspace === 'review' ? reviewGate : null;
  const missingFocusedWorkspaceGate =
    (routeWorkspace === 'ready' && !readyGate) || (routeWorkspace === 'review' && !reviewGate);
  const listedWorkspaceGates = focusedWorkspaceGate
    ? workspaceGates.filter((gate) => gate.decision.id !== focusedWorkspaceGate.decision.id)
    : workspaceGates;
  const visualPairCount =
    visualPairSummary.pairs.length > 0
      ? visualPairSummary.pairs.length
      : (compareTarget?.pairCount ?? 0);
  const diffValue = runWorkspaceDiffValue(run, workspaceGates[0] ?? null);
  const diffAvailable = hasRunWorkspaceDiff(run, workspaceGates[0] ?? null);
  const retroSummary = summarizeSlotWorkspaceRetro(run);
  const openCompareTarget = () => {
    if (!compareTarget) return;
    onOpenRecipeArtifacts(
      compareTarget.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
      compareTarget.artifactPath,
      artifactFilterParamForWorkspaceNav('compare'),
    );
  };
  const openBestAvailableCompare = () => {
    if (primaryVisualPair || recipePrimaryVisualPair) {
      openPriorityCompare();
      return;
    }
    openCompareTarget();
  };
  const openCompareFallbackArtifact = (artifactPath: string) => {
    if (primaryVisualPair) {
      onOpenArtifact(artifactPath);
      return;
    }
    onOpenRecipeArtifacts(
      priorityRecipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
      artifactPath,
      artifactFilterParamForWorkspaceNav('compare'),
    );
  };
  const recipeEvidencePanel = recipeEvidence ? (
    <SlotRecipeEvidencePanel
      summary={recipeEvidence}
      selectedRecipeRunId={selectedRecipeRunId}
      selectedArtifactCount={recipeArtifactCount}
      runId={run.id}
      gatewayUrl={gatewayUrl}
      artifactAuthHeaders={artifactAuthHeaders}
      previewArtifacts={recipePreviewArtifacts}
      primaryPair={recipeVisualPairSummary.pairs[0] ?? null}
      onOpenRecipeArtifacts={onOpenRecipeArtifacts}
      onSelectRecipeRun={onSelectRecipeRun}
    />
  ) : null;
  const runEvidencePanel =
    artifactCount > 0 ? (
      <RunEvidencePreviewPanel
        artifactCount={artifactCount}
        artifacts={runPreviewArtifacts}
        primaryPair={primaryVisualPair}
        runId={run.id}
        gatewayUrl={gatewayUrl}
        artifactAuthHeaders={artifactAuthHeaders}
        onOpenArtifacts={onOpenArtifacts}
        onOpenArtifact={onOpenArtifact}
      />
    ) : null;
  const statusColor = RUN_STATUS_COLORS[run.status] ?? colors.textMuted;
  return (
    <View style={styles.workspaceCard}>
      <View style={styles.row}>
        <View style={styles.workspaceStatusRow}>
          <View style={[styles.workspaceBadge, { backgroundColor: statusColor + '22' }]}>
            <Text style={[styles.workspaceBadgeText, { color: statusColor }]}>{run.status}</Text>
          </View>
          <Text style={styles.workspaceMeta}>{run.flowType}</Text>
          <View
            style={[
              styles.workspaceFocusBadge,
              {
                borderColor: focus.isHistorical ? colors.statusWarn + '66' : colors.statusOk + '66',
              },
            ]}
          >
            <Text
              style={[
                styles.workspaceFocusText,
                { color: focus.isHistorical ? colors.statusWarn : colors.statusOk },
              ]}
            >
              {focus.label}
            </Text>
          </View>
        </View>
        {onOpenCurrentRun ? (
          <Pressable style={styles.workspaceCurrentButton} onPress={onOpenCurrentRun}>
            <Text style={styles.workspaceCurrentText}>Current</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.workspaceTitle} numberOfLines={2}>
        {run.ticketOrPr}
      </Text>
      {run.summary ? (
        <Text style={baseStyles.textSecondary} numberOfLines={3}>
          {run.summary}
        </Text>
      ) : null}
      {priorityVisualPair && routeWorkspace !== 'compare' ? (
        <SlotBeforeAfterPriorityPanel
          pair={priorityVisualPair}
          pairCount={
            primaryVisualPair
              ? visualPairSummary.pairs.length
              : recipeVisualPairSummary.pairs.length
          }
          authHeaders={artifactAuthHeaders}
          eyebrow={priorityVisualPairIsRecipe ? 'Recipe evidence' : 'Review first'}
          title={priorityVisualPairIsRecipe ? 'Recipe before → after' : 'Before → After evidence'}
          copy={
            priorityVisualPairIsRecipe
              ? 'Recipe evidence has the clearest visual delta for this slot.'
              : 'Confirm the visible delta before approving or retrying this slot.'
          }
          onOpenArtifact={openPriorityVisualArtifact}
          onOpenCompare={openPriorityCompare}
          onOpenArtifacts={onOpenArtifacts}
          onOpenRecipe={onOpenRecipe}
          onOpenDiff={onOpenDiff}
          onOpenTerminal={onOpenTerminal}
          artifactCount={artifactCount}
          recipeCount={recipeMetricCount}
          recipeAvailable={recipeAvailable}
          diffValue={diffValue}
        />
      ) : null}
      <SlotCockpitSummary
        artifactCount={artifactCount}
        recipeCount={recipeMetricCount}
        recipeAvailable={recipeAvailable}
        recipeScopeLabel={recipeWorkspaceScopeLabel(selectedRecipeRunId)}
        pendingCount={pendingDecisions.length}
        diffValue={diffValue}
        diffAvailable={diffAvailable}
        visualPairCount={visualPairCount}
        familySummary={familySummary}
        gateCount={workspaceGates.length}
        readyGate={readyGate}
        reviewGate={reviewGate}
        retroSummary={retroSummary}
        activeTaskProgress={activeTaskProgress}
        fallbackTaskProgress={fallbackTaskProgress}
        run={run}
        onOpenTerminal={onOpenTerminal}
        onOpenRun={onOpenRun}
        onOpenArtifacts={onOpenArtifacts}
        onOpenCompare={() => {
          if (primaryVisualPair) onOpenArtifact(primaryVisualPair.after.path);
          else if (compareTarget?.recipeRunId) {
            onOpenRecipeArtifacts(
              compareTarget.recipeRunId,
              compareTarget.artifactPath,
              artifactFilterParamForWorkspaceNav('compare'),
            );
          }
        }}
        onOpenRecipe={onOpenRecipe}
        onOpenDiff={onOpenDiff}
        onOpenFamily={onOpenFamily}
        onOpenFamilyRetros={onOpenFamilyRetros}
        onOpenPR={onOpenPR}
        onOpenGate={(gate) =>
          onOpenDecision(gate.decision.id, run.id, workspaceDecisionKind(gate.decision))
        }
        onOpenRetro={(retro) => onOpenDecision(retro.decision.id, run.id, 'retrospective')}
        prNumber={run.prNumber}
      />
      {focusedWorkspaceGate ? (
        <View style={styles.workspaceFocusedGateBlock}>
          <Text style={styles.workspaceFocusedGateTitle}>
            {routeWorkspace === 'ready' ? 'Ready workspace focus' : 'Review workspace focus'}
          </Text>
          <WorkspaceGateCard
            gate={focusedWorkspaceGate}
            runId={run.id}
            artifactManifest={runArtifacts}
            gatewayUrl={gatewayUrl}
            artifactAuthHeaders={artifactAuthHeaders}
            compareTarget={compareTarget}
            compareFallbackPair={primaryVisualPair ?? recipePrimaryVisualPair}
            compareFallbackPairIsRecipe={!primaryVisualPair && Boolean(recipePrimaryVisualPair)}
            runDiffValue={diffValue}
            runDiffAvailable={diffAvailable}
            onOpenDecision={() =>
              onOpenDecision(
                focusedWorkspaceGate.decision.id,
                run.id,
                workspaceDecisionKind(focusedWorkspaceGate.decision),
              )
            }
            onOpenAllArtifacts={onOpenGateArtifacts}
            onOpenArtifacts={(artifactPath) =>
              artifactPath ? onOpenArtifact(artifactPath) : onOpenArtifacts()
            }
            onOpenCompareTarget={openCompareTarget}
            onOpenCompareFallbackArtifact={openCompareFallbackArtifact}
            onOpenDiff={onOpenDiff}
            onOpenRecipe={onOpenRecipe}
            onOpenTerminal={onOpenTerminal}
          />
        </View>
      ) : null}
      {missingFocusedWorkspaceGate ? (
        <SlotMissingGateFocusPanel
          workspace={routeWorkspace === 'ready' ? 'ready' : 'review'}
          artifactCount={artifactCount}
          recipeCount={recipeMetricCount}
          recipeAvailable={recipeAvailable}
          diffValue={diffAvailable ? diffValue : 'workspace'}
          diffAvailable={diffAvailable}
          visualPairCount={visualPairCount}
          familySummary={familySummary}
          prNumber={run.prNumber}
          onOpenArtifacts={onOpenArtifacts}
          onOpenRecipe={onOpenRecipe}
          onOpenDiff={onOpenDiff}
          onOpenCompare={openBestAvailableCompare}
          onOpenTerminal={onOpenTerminal}
          onOpenRun={onOpenRun}
          onOpenFamily={onOpenFamily}
          onOpenPR={onOpenPR}
        />
      ) : null}
      {routeWorkspace === 'compare' ? (
        <SlotCompareFocusPanel
          pair={priorityVisualPair}
          pairCount={
            primaryVisualPair
              ? visualPairSummary.pairs.length
              : recipeVisualPairSummary.pairs.length
          }
          pairIsRecipe={priorityVisualPairIsRecipe}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={openPriorityVisualArtifact}
          onOpenCompare={openPriorityCompare}
          onOpenArtifacts={onOpenArtifacts}
          onOpenRecipe={onOpenRecipe}
          onOpenDiff={onOpenDiff}
          onOpenTerminal={onOpenTerminal}
        />
      ) : null}
      {routeWorkspace === 'retro' && retroSummary ? (
        <SlotRetroFocusPanel
          retro={retroSummary}
          runId={run.id}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          onOpenDecision={() => onOpenDecision(retroSummary.decision.id, run.id, 'retrospective')}
          onOpenEvidence={() => onOpenGateArtifacts(retroSummary.primaryArtifactPath ?? undefined)}
          onOpenCompare={openPriorityCompare}
          onOpenDiff={onOpenDiff}
          onOpenFamilyRetros={onOpenFamilyRetros}
          onOpenTerminal={onOpenTerminal}
          onOpenRun={onOpenRun}
          onOpenPR={onOpenPR}
          familyRetrosAvailable={Boolean(run.familyId)}
          prNumber={run.prNumber}
        />
      ) : null}
      {routeWorkspace === 'retro' && !retroSummary && familySummary ? (
        <View style={styles.workspaceFocusedGateBlock}>
          <Text style={styles.workspaceFocusedGateTitle}>Family retros focus</Text>
          <SlotFamilyContextPanel
            title="Family retros"
            summary={familySummary}
            gatewayUrl={gatewayUrl}
            artifactAuthHeaders={artifactAuthHeaders}
            onOpenFamily={onOpenFamily}
            onOpenFamilyEvidence={onOpenFamilyEvidence}
            onOpenFamilyCompare={onOpenFamilyCompare}
            onOpenFamilyLedger={onOpenFamilyLedger}
            onOpenFamilyRetros={onOpenFamilyRetros}
            onOpenRecipe={onOpenRecipe}
            onOpenTerminal={onOpenTerminal}
            onOpenDecision={onOpenDecision}
          />
        </View>
      ) : null}
      {routeWorkspace === 'retro' && !retroSummary && !familySummary ? (
        <SlotMissingGateFocusPanel
          workspace="retro"
          artifactCount={artifactCount}
          recipeCount={recipeMetricCount}
          recipeAvailable={recipeAvailable}
          diffValue={diffAvailable ? diffValue : 'workspace'}
          diffAvailable={diffAvailable}
          visualPairCount={visualPairCount}
          familySummary={familySummary}
          prNumber={run.prNumber}
          onOpenArtifacts={onOpenArtifacts}
          onOpenRecipe={onOpenRecipe}
          onOpenDiff={onOpenDiff}
          onOpenCompare={openBestAvailableCompare}
          onOpenTerminal={onOpenTerminal}
          onOpenRun={onOpenRun}
          onOpenFamily={onOpenFamily}
          onOpenPR={onOpenPR}
        />
      ) : null}
      {routeWorkspace === 'recipe' && recipeEvidencePanel ? (
        <View style={styles.workspaceFocusedGateBlock}>
          <Text style={styles.workspaceFocusedGateTitle}>Recipe workspace focus</Text>
          {recipeEvidencePanel}
        </View>
      ) : null}
      {routeWorkspace === 'artifacts' && runEvidencePanel ? (
        <View style={styles.workspaceFocusedGateBlock}>
          <Text style={styles.workspaceFocusedGateTitle}>Evidence workspace focus</Text>
          {runEvidencePanel}
        </View>
      ) : null}
      {routeWorkspace === 'diff' ? (
        <SlotDiffFocusPanel
          diffValue={diffAvailable ? diffValue : 'workspace'}
          diffAvailable={diffAvailable}
          artifactCount={artifactCount}
          recipeCount={recipeMetricCount}
          visualPairCount={visualPairCount}
          onOpenDiff={onOpenDiff}
          onOpenArtifacts={onOpenArtifacts}
          onOpenRecipe={onOpenRecipe}
          onOpenCompare={openPriorityCompare}
          onOpenTerminal={onOpenTerminal}
        />
      ) : null}
      {routeWorkspace === 'terminal' ? (
        <SlotTerminalFocusPanel
          diffValue={diffAvailable ? diffValue : 'workspace'}
          artifactCount={artifactCount}
          recipeCount={recipeMetricCount}
          visualPairCount={visualPairCount}
          onOpenTerminal={onOpenTerminal}
          onOpenDiff={onOpenDiff}
          onOpenArtifacts={onOpenArtifacts}
          onOpenRecipe={onOpenRecipe}
          onOpenCompare={openPriorityCompare}
          onOpenRun={onOpenRun}
        />
      ) : null}
      {activeTaskProgress ? (
        <TaskProgressPanel
          run={run}
          progress={activeTaskProgress}
          error={taskProgressError}
          compact
        />
      ) : fallbackTaskProgress ? (
        <TaskProgressFallbackPanel
          summary={fallbackTaskProgress}
          error={taskProgressError}
          compact
        />
      ) : null}
      {familySummary ? (
        routeWorkspace === 'family' ? (
          <View style={styles.workspaceFocusedGateBlock}>
            <Text style={styles.workspaceFocusedGateTitle}>Family workspace focus</Text>
            <SlotFamilyContextPanel
              summary={familySummary}
              gatewayUrl={gatewayUrl}
              artifactAuthHeaders={artifactAuthHeaders}
              onOpenFamily={onOpenFamily}
              onOpenFamilyEvidence={onOpenFamilyEvidence}
              onOpenFamilyCompare={onOpenFamilyCompare}
              onOpenFamilyLedger={onOpenFamilyLedger}
              onOpenFamilyRetros={onOpenFamilyRetros}
              onOpenRecipe={onOpenRecipe}
              onOpenTerminal={onOpenTerminal}
              onOpenDecision={onOpenDecision}
            />
          </View>
        ) : routeWorkspace === 'retro' && !retroSummary ? null : (
          <SlotFamilyContextPanel
            summary={familySummary}
            gatewayUrl={gatewayUrl}
            artifactAuthHeaders={artifactAuthHeaders}
            onOpenFamily={onOpenFamily}
            onOpenFamilyEvidence={onOpenFamilyEvidence}
            onOpenFamilyCompare={onOpenFamilyCompare}
            onOpenFamilyLedger={onOpenFamilyLedger}
            onOpenFamilyRetros={onOpenFamilyRetros}
            onOpenRecipe={onOpenRecipe}
            onOpenTerminal={onOpenTerminal}
            onOpenDecision={onOpenDecision}
          />
        )
      ) : null}
      {listedWorkspaceGates.length > 0 ? (
        <View style={styles.workspaceGateList}>
          {listedWorkspaceGates.map((workspaceGate) => (
            <WorkspaceGateCard
              key={workspaceGate.decision.id}
              gate={workspaceGate}
              runId={run.id}
              artifactManifest={runArtifacts}
              gatewayUrl={gatewayUrl}
              artifactAuthHeaders={artifactAuthHeaders}
              compareTarget={compareTarget}
              compareFallbackPair={primaryVisualPair ?? recipePrimaryVisualPair}
              compareFallbackPairIsRecipe={!primaryVisualPair && Boolean(recipePrimaryVisualPair)}
              runDiffValue={diffValue}
              runDiffAvailable={diffAvailable}
              onOpenDecision={() =>
                onOpenDecision(
                  workspaceGate.decision.id,
                  run.id,
                  workspaceDecisionKind(workspaceGate.decision),
                )
              }
              onOpenAllArtifacts={onOpenGateArtifacts}
              onOpenArtifacts={(artifactPath) =>
                artifactPath ? onOpenArtifact(artifactPath) : onOpenArtifacts()
              }
              onOpenCompareTarget={openCompareTarget}
              onOpenCompareFallbackArtifact={openCompareFallbackArtifact}
              onOpenDiff={onOpenDiff}
              onOpenRecipe={onOpenRecipe}
              onOpenTerminal={onOpenTerminal}
            />
          ))}
        </View>
      ) : pendingDecisions.length > 0 ? (
        <View style={styles.pendingDecisionBlock}>
          <Text style={styles.pendingDecisionTitle}>Needs review</Text>
          {pendingDecisions.slice(0, 2).map((decision) => (
            <Pressable
              key={decision.id}
              style={styles.pendingDecisionCard}
              onPress={() => onOpenDecision(decision.id)}
            >
              <Text style={styles.pendingDecisionText} numberOfLines={1}>
                {decision.title}
              </Text>
              <Text style={styles.pendingDecisionCta}>Open gate</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {routeWorkspace !== 'artifacts' ? runEvidencePanel : null}
      {routeWorkspace !== 'recipe' ? recipeEvidencePanel : null}
      {run.decisions.length > 0 ? (
        <SlotDecisionSignalsPanel
          run={run}
          decisions={run.decisions}
          onOpenDecision={onOpenDecision}
          onOpenArtifacts={onOpenArtifacts}
          onOpenCompare={() => {
            if (primaryVisualPair) onOpenArtifact(primaryVisualPair.after.path);
            else if (compareTarget?.recipeRunId) {
              onOpenRecipeArtifacts(
                compareTarget.recipeRunId,
                compareTarget.artifactPath,
                artifactFilterParamForWorkspaceNav('compare'),
              );
            } else onOpenArtifacts();
          }}
          onOpenDiff={onOpenDiff}
        />
      ) : null}
    </View>
  );
}

function SlotMissingGateFocusPanel({
  workspace,
  artifactCount,
  recipeCount,
  recipeAvailable,
  diffValue,
  diffAvailable,
  visualPairCount,
  familySummary,
  prNumber,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenDiff,
  onOpenCompare,
  onOpenTerminal,
  onOpenRun,
  onOpenFamily,
  onOpenPR,
}: {
  workspace: 'ready' | 'review' | 'retro';
  artifactCount: number;
  recipeCount: number | null;
  recipeAvailable?: boolean;
  diffValue: string;
  diffAvailable: boolean;
  visualPairCount: number;
  familySummary: SlotFamilyContextSummary | null;
  prNumber?: number | null;
  onOpenArtifacts: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenCompare: () => void;
  onOpenTerminal: () => void;
  onOpenRun: () => void;
  onOpenFamily: () => void;
  onOpenPR: () => void;
}) {
  const isReady = workspace === 'ready';
  const isRetro = workspace === 'retro';
  const tone = isReady ? colors.statusOk : isRetro ? colors.accent : colors.statusWarn;
  const badge = isReady ? 'Ready focus' : isRetro ? 'Retro focus' : 'Review focus';
  const title = isReady ? 'No ready gate yet' : isRetro ? 'No retro yet' : 'No review gate yet';
  const summary = isReady
    ? 'The run has not emitted a ready workspace gate yet. Use live evidence, recipe files, diff, or terminal context.'
    : isRetro
      ? 'No run or family retrospective is available yet. Keep the current evidence, recipe, diff, and terminal context reachable.'
      : 'The run has not emitted a review workspace gate yet. Use the current artifacts and live terminal while it progresses.';
  return (
    <View style={[styles.slotMissingGateFocusPanel, { borderColor: tone + '66' }]}>
      <View style={styles.workspaceGateHeader}>
        <View style={styles.slotRetroFocusTitleBlock}>
          <View style={[styles.workspaceGateBadge, { backgroundColor: tone + '22' }]}>
            <Text style={[styles.workspaceGateBadgeText, { color: tone }]}>{badge}</Text>
          </View>
          <Text style={styles.workspaceGateTitle} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Pressable style={styles.workspaceGateOpenButton} onPress={onOpenTerminal}>
          <Text style={[styles.workspaceGateOpenText, { color: tone }]}>Open terminal</Text>
        </Pressable>
      </View>
      <Text style={styles.workspaceGateSummary} numberOfLines={2}>
        {summary}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceActions}
      >
        <WorkspaceAction
          label="Evidence files"
          value={String(artifactCount)}
          primary={artifactCount > 0}
          onPress={onOpenArtifacts}
          disabled={artifactCount === 0}
        />
        <WorkspaceAction
          label="Recipe files"
          value={recipeCount === null ? 'loading' : recipeAvailable ? String(recipeCount) : '-'}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <WorkspaceAction
          label="Diff view"
          value={diffAvailable ? diffValue : 'workspace'}
          onPress={onOpenDiff}
        />
        <WorkspaceAction
          label="Before→After"
          value={visualPairCount > 0 ? String(visualPairCount) : '-'}
          onPress={onOpenCompare}
          disabled={visualPairCount === 0}
        />
        <WorkspaceAction label="Terminal" value="live" onPress={onOpenTerminal} />
        <WorkspaceAction label="Run detail" value="open" onPress={onOpenRun} />
        <WorkspaceAction
          label="Family"
          value={familySummary ? shortId(familySummary.familyId) : '-'}
          onPress={onOpenFamily}
          disabled={!familySummary}
        />
        <WorkspaceAction
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}

function SlotDiffFocusPanel({
  diffValue,
  diffAvailable,
  artifactCount,
  recipeCount,
  visualPairCount,
  onOpenDiff,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenCompare,
  onOpenTerminal,
}: {
  diffValue: string;
  diffAvailable: boolean;
  artifactCount: number;
  recipeCount: number | null;
  visualPairCount: number;
  onOpenDiff: () => void;
  onOpenArtifacts: () => void;
  onOpenRecipe: () => void;
  onOpenCompare: () => void;
  onOpenTerminal: () => void;
}) {
  const tone = diffAvailable ? colors.statusOk : colors.statusWarn;
  return (
    <View style={[styles.slotDiffFocusPanel, { borderColor: tone + '66' }]}>
      <View style={styles.workspaceGateHeader}>
        <View style={styles.slotRetroFocusTitleBlock}>
          <View style={[styles.workspaceGateBadge, { backgroundColor: tone + '22' }]}>
            <Text style={[styles.workspaceGateBadgeText, { color: tone }]}>Diff workspace</Text>
          </View>
          <Text style={styles.workspaceGateTitle} numberOfLines={1}>
            {diffAvailable ? 'Run diff ready' : 'Live workspace diff'}
          </Text>
        </View>
        <Pressable style={styles.workspaceGateOpenButton} onPress={onOpenDiff}>
          <Text style={[styles.workspaceGateOpenText, { color: tone }]}>Open diff</Text>
        </Pressable>
      </View>
      <Text style={styles.workspaceGateSummary} numberOfLines={2}>
        {diffAvailable
          ? 'Review changed files, then jump to evidence, recipe artifacts, or the live terminal.'
          : 'No run diff artifact is available yet; open the slot workspace diff for current files.'}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceActions}
      >
        <WorkspaceAction label="Diff view" value={diffValue} primary onPress={onOpenDiff} />
        <WorkspaceAction
          label="Evidence files"
          value={String(artifactCount)}
          onPress={onOpenArtifacts}
          disabled={artifactCount === 0}
        />
        <WorkspaceAction
          label="Before→After"
          value={String(visualPairCount)}
          onPress={onOpenCompare}
          disabled={visualPairCount === 0}
        />
        <WorkspaceAction
          label="Recipe files"
          value={recipeCount === null ? 'loading' : recipeCount > 0 ? String(recipeCount) : '-'}
          onPress={onOpenRecipe}
          disabled={recipeCount === 0}
        />
        <WorkspaceAction label="Terminal" value="live" onPress={onOpenTerminal} />
      </ScrollView>
    </View>
  );
}

function SlotCompareFocusPanel({
  pair,
  pairCount,
  pairIsRecipe,
  authHeaders,
  onOpenArtifact,
  onOpenCompare,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenDiff,
  onOpenTerminal,
}: {
  pair: VisualArtifactPair | null;
  pairCount: number;
  pairIsRecipe: boolean;
  authHeaders: ArtifactHttpHeaders;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenCompare: () => void;
  onOpenArtifacts: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
}) {
  return (
    <View style={styles.slotCompareFocusPanel}>
      <View style={styles.workspaceGateHeader}>
        <View style={styles.slotRetroFocusTitleBlock}>
          <View style={[styles.workspaceGateBadge, { backgroundColor: colors.accent + '22' }]}>
            <Text style={[styles.workspaceGateBadgeText, { color: colors.accent }]}>
              Compare focus
            </Text>
          </View>
          <Text style={styles.workspaceGateTitle} numberOfLines={1}>
            Before → after evidence
          </Text>
        </View>
        <Pressable
          style={[styles.workspaceGateOpenButton, !pair && styles.workspaceActionButtonDisabled]}
          onPress={onOpenCompare}
          disabled={!pair}
        >
          <Text style={[styles.workspaceGateOpenText, { color: colors.accent }]}>Open compare</Text>
        </Pressable>
      </View>
      <Text style={styles.workspaceGateSummary} numberOfLines={2}>
        {pair
          ? pairIsRecipe
            ? 'Recipe evidence provides the clearest visual delta for this slot.'
            : 'Run evidence provides the clearest visual delta for this slot.'
          : 'No before → after pair is available yet. Inspect evidence, recipe files, or the diff.'}
      </Text>
      {pair ? (
        <BeforeAfterPreview
          pair={pair}
          authHeaders={authHeaders}
          onOpenArtifact={onOpenArtifact}
          eyebrow={pairIsRecipe ? 'Recipe evidence' : 'Run evidence'}
          title={pairIsRecipe ? 'Recipe before → after' : 'Run before → after'}
          hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
          imageHeight={92}
        />
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceActions}
      >
        <WorkspaceAction
          label="Before→After"
          value={pair ? `${pairCount} pair${pairCount === 1 ? '' : 's'}` : '-'}
          primary={Boolean(pair)}
          onPress={onOpenCompare}
          disabled={!pair}
        />
        <WorkspaceAction label="Evidence files" value="review" onPress={onOpenArtifacts} />
        <WorkspaceAction label="Recipe files" value="context" onPress={onOpenRecipe} />
        <WorkspaceAction label="Diff view" value="open" onPress={onOpenDiff} />
        <WorkspaceAction label="Terminal" value="live" onPress={onOpenTerminal} />
      </ScrollView>
    </View>
  );
}

function SlotTerminalFocusPanel({
  diffValue,
  artifactCount,
  recipeCount,
  visualPairCount,
  onOpenTerminal,
  onOpenDiff,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenCompare,
  onOpenRun,
}: {
  diffValue: string;
  artifactCount: number;
  recipeCount: number | null;
  visualPairCount: number;
  onOpenTerminal: () => void;
  onOpenDiff: () => void;
  onOpenArtifacts: () => void;
  onOpenRecipe: () => void;
  onOpenCompare: () => void;
  onOpenRun: () => void;
}) {
  return (
    <View style={styles.slotTerminalFocusPanel}>
      <View style={styles.workspaceGateHeader}>
        <View style={styles.slotRetroFocusTitleBlock}>
          <View
            style={[styles.workspaceGateBadge, { backgroundColor: colors.lifecycleWorking + '22' }]}
          >
            <Text style={[styles.workspaceGateBadgeText, { color: colors.lifecycleWorking }]}>
              Terminal context
            </Text>
          </View>
          <Text style={styles.workspaceGateTitle} numberOfLines={1}>
            Live slot terminal
          </Text>
        </View>
        <Pressable style={styles.workspaceGateOpenButton} onPress={onOpenTerminal}>
          <Text style={[styles.workspaceGateOpenText, { color: colors.lifecycleWorking }]}>
            Open terminal
          </Text>
        </Pressable>
      </View>
      <Text style={styles.workspaceGateSummary} numberOfLines={2}>
        Jump back to the live terminal or inspect the evidence, recipe, and diff context behind this
        slot.
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceActions}
      >
        <WorkspaceAction label="Terminal" value="live" primary onPress={onOpenTerminal} />
        <WorkspaceAction label="Diff view" value={diffValue} onPress={onOpenDiff} />
        <WorkspaceAction
          label="Evidence files"
          value={String(artifactCount)}
          onPress={onOpenArtifacts}
          disabled={artifactCount === 0}
        />
        <WorkspaceAction
          label="Recipe files"
          value={recipeCount === null ? 'loading' : recipeCount > 0 ? String(recipeCount) : '-'}
          onPress={onOpenRecipe}
          disabled={recipeCount === 0}
        />
        <WorkspaceAction
          label="Before→After"
          value={String(visualPairCount)}
          onPress={onOpenCompare}
          disabled={visualPairCount === 0}
        />
        <WorkspaceAction label="Run detail" value="open" onPress={onOpenRun} />
      </ScrollView>
    </View>
  );
}

function SlotRetroFocusPanel({
  retro,
  runId,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenDecision,
  onOpenEvidence,
  onOpenCompare,
  onOpenDiff,
  onOpenFamilyRetros,
  onOpenTerminal,
  onOpenRun,
  onOpenPR,
  familyRetrosAvailable,
  prNumber,
}: {
  retro: SlotWorkspaceRetroSummary;
  runId: string;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  onOpenDecision: () => void;
  onOpenEvidence: () => void;
  onOpenCompare: () => void;
  onOpenDiff: () => void;
  onOpenFamilyRetros: () => void;
  onOpenTerminal: () => void;
  onOpenRun: () => void;
  onOpenPR: () => void;
  familyRetrosAvailable: boolean;
  prNumber?: number | null;
}) {
  const tone = retro.pending ? colors.statusWarn : colors.statusOk;
  const visualPair: VisualArtifactPair | null = retro.primaryVisualPair
    ? {
        before: {
          path: retro.primaryVisualPair.beforePath,
          purpose: 'screenshot-before',
          url: artifactUrl(gatewayUrl, runId, retro.primaryVisualPair.beforePath),
        },
        after: {
          path: retro.primaryVisualPair.afterPath,
          purpose: 'screenshot-after',
          url: artifactUrl(gatewayUrl, runId, retro.primaryVisualPair.afterPath),
        },
        stem: retro.primaryVisualPair.stem,
      }
    : null;
  return (
    <View style={[styles.slotRetroFocusPanel, { borderColor: tone + '66' }]}>
      <View style={styles.workspaceGateHeader}>
        <View style={styles.slotRetroFocusTitleBlock}>
          <View style={[styles.workspaceGateBadge, { backgroundColor: tone + '22' }]}>
            <Text style={[styles.workspaceGateBadgeText, { color: tone }]}>Retro workspace</Text>
          </View>
          <Text style={styles.workspaceGateTitle} numberOfLines={1}>
            {retro.title}
          </Text>
        </View>
        <Pressable style={styles.workspaceGateOpenButton} onPress={onOpenDecision}>
          <Text style={[styles.workspaceGateOpenText, { color: tone }]}>Open retro</Text>
        </Pressable>
      </View>
      <Text style={styles.workspaceGateSummary} numberOfLines={3}>
        {retro.summary}
      </Text>
      {visualPair ? (
        <View style={styles.slotRetroVisualPreview}>
          <BeforeAfterPreview
            pair={visualPair}
            authHeaders={artifactAuthHeaders}
            onOpenArtifact={onOpenCompare}
            eyebrow={retro.pending ? 'Pending retro evidence' : 'Retro evidence'}
            title="Before → after signal"
            hint="Tap to compare"
            imageHeight={64}
          />
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceActions}
      >
        <WorkspaceAction
          label="Status"
          value={retro.statusLabel}
          primary={retro.pending}
          onPress={onOpenDecision}
        />
        {retro.metrics.map((metric) => (
          <WorkspaceAction
            key={metric.label}
            label={metric.label}
            value={metric.value || '-'}
            onPress={onOpenDecision}
          />
        ))}
        <WorkspaceAction
          label="Evidence"
          value={String(retro.artifactPaths.length)}
          onPress={onOpenEvidence}
          disabled={retro.artifactPaths.length === 0}
        />
        <WorkspaceAction
          label="Before→After"
          value={retro.visualPairCount > 0 ? String(retro.visualPairCount) : '-'}
          onPress={onOpenCompare}
          disabled={!visualPair}
        />
        <WorkspaceAction label="Diff view" value="open" onPress={onOpenDiff} />
        <WorkspaceAction label="Terminal" value="live" onPress={onOpenTerminal} />
        <WorkspaceAction label="Run detail" value="open" onPress={onOpenRun} />
        <WorkspaceAction
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
        <WorkspaceAction
          label="Family retros"
          value={familyRetrosAvailable ? 'open' : '-'}
          onPress={onOpenFamilyRetros}
          disabled={!familyRetrosAvailable}
        />
      </ScrollView>
    </View>
  );
}

function SlotBeforeAfterPriorityPanel({
  pair,
  pairCount,
  authHeaders,
  artifactCount,
  recipeCount,
  recipeAvailable,
  diffValue,
  eyebrow = 'Review first',
  title = 'Before → After evidence',
  copy = 'Confirm the visible delta before approving or retrying this slot.',
  onOpenArtifact,
  onOpenCompare,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenDiff,
  onOpenTerminal,
}: {
  pair: VisualArtifactPair;
  pairCount: number;
  authHeaders: ArtifactHttpHeaders;
  artifactCount: number;
  recipeCount: number | null;
  recipeAvailable?: boolean;
  diffValue: string;
  eyebrow?: string;
  title?: string;
  copy?: string;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenCompare: () => void;
  onOpenArtifacts: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
}) {
  return (
    <View style={styles.slotBeforeAfterPriorityPanel}>
      <BeforeAfterPreview
        pair={pair}
        authHeaders={authHeaders}
        onOpenArtifact={onOpenArtifact}
        eyebrow={eyebrow}
        title={title}
        hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
        imageHeight={88}
      />
      <View style={styles.slotBeforeAfterPriorityActions}>
        <Text style={styles.slotBeforeAfterPriorityCopy}>{copy}</Text>
        <Pressable style={styles.slotBeforeAfterPriorityButton} onPress={onOpenCompare}>
          <Text style={styles.slotBeforeAfterPriorityButtonText}>Compare evidence</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.slotBeforeAfterPriorityRail}
      >
        <WorkspaceAction label="Evidence" value={String(artifactCount)} onPress={onOpenArtifacts} />
        <WorkspaceAction
          label="Recipe"
          value={recipeCount === null ? 'loading' : recipeAvailable ? String(recipeCount) : '-'}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <WorkspaceAction label="Diff" value={diffValue} onPress={onOpenDiff} />
        <WorkspaceAction label="Terminal" value="live" onPress={onOpenTerminal} />
      </ScrollView>
    </View>
  );
}

function SlotCockpitSummary({
  artifactCount,
  recipeCount,
  recipeAvailable,
  recipeScopeLabel,
  pendingCount,
  diffValue,
  diffAvailable,
  visualPairCount,
  familySummary,
  gateCount,
  readyGate,
  reviewGate,
  retroSummary,
  activeTaskProgress,
  fallbackTaskProgress,
  run,
  onOpenTerminal,
  onOpenRun,
  onOpenArtifacts,
  onOpenCompare,
  onOpenRecipe,
  onOpenDiff,
  onOpenFamily,
  onOpenFamilyRetros,
  onOpenPR,
  onOpenGate,
  onOpenRetro,
  prNumber,
}: {
  artifactCount: number;
  recipeCount: number | null;
  recipeAvailable?: boolean;
  recipeScopeLabel: ReturnType<typeof recipeWorkspaceScopeLabel>;
  pendingCount: number;
  diffValue: string;
  diffAvailable: boolean;
  visualPairCount: number;
  familySummary: SlotFamilyContextSummary | null;
  gateCount: number;
  readyGate: SlotWorkspaceGateSummary | null;
  reviewGate: SlotWorkspaceGateSummary | null;
  retroSummary: SlotWorkspaceRetroSummary | null;
  activeTaskProgress?: TaskProgressStructured;
  fallbackTaskProgress?: ReturnType<typeof fallbackTaskProgressSummary> | null;
  run: Run;
  onOpenTerminal: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenCompare: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenFamily: () => void;
  onOpenFamilyRetros: () => void;
  onOpenPR: () => void;
  onOpenGate: (gate: SlotWorkspaceGateSummary) => void;
  onOpenRetro: (retro: SlotWorkspaceRetroSummary) => void;
  prNumber?: number | null;
}) {
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';
  const progressMeta = activeTaskProgress
    ? taskProgressTitle(run, activeTaskProgress)
    : (fallbackTaskProgress?.meta ?? 'No progress');

  return (
    <View style={styles.cockpitPanel}>
      <View style={styles.cockpitHeader}>
        <View>
          <Text style={styles.cockpitTitle}>Workspace cockpit</Text>
          <Text style={styles.cockpitMeta}>
            {gateCount} gate{gateCount === 1 ? '' : 's'} · {pendingCount} pending
          </Text>
        </View>
        <Pressable style={styles.cockpitTerminalButton} onPress={onOpenTerminal}>
          <Text style={styles.cockpitTerminalText}>Terminal</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cockpitRail}
      >
        <CockpitTile
          label="Ready"
          value={readyGate ? gateStateLabel(readyGate) : '-'}
          hint={readyGate ? workspaceGateCockpitHint(readyGate) : undefined}
          onPress={() => {
            if (readyGate) onOpenGate(readyGate);
          }}
          disabled={!readyGate}
        />
        <CockpitTile
          label="Review gate"
          value={reviewGate ? gateStateLabel(reviewGate) : '-'}
          hint={reviewGate ? workspaceGateCockpitHint(reviewGate) : undefined}
          onPress={() => {
            if (reviewGate) onOpenGate(reviewGate);
          }}
          disabled={!reviewGate}
        />
        <CockpitTile
          label="Retro gate"
          value={retroSummary?.statusLabel ?? '-'}
          hint={retroSummary ? workspaceRetroCockpitHint(retroSummary) : undefined}
          onPress={() => {
            if (retroSummary) onOpenRetro(retroSummary);
          }}
          disabled={!retroSummary}
        />
        <CockpitTile
          label="Progress"
          value={progressValue}
          onPress={onOpenTerminal}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
          hint={progressMeta}
        />
        <CockpitTile label="Run detail" value="open" onPress={onOpenRun} />
        <CockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
        <CockpitTile
          label="Artifact files"
          value={String(artifactCount)}
          onPress={onOpenArtifacts}
        />
        <CockpitTile
          label="Before→After"
          value={String(visualPairCount)}
          onPress={onOpenCompare}
          disabled={visualPairCount === 0}
        />
        <CockpitTile
          label="Recipe files"
          value={recipeCount === null ? 'loading' : recipeAvailable ? String(recipeCount) : '-'}
          hint={recipeAvailable ? `${recipeScopeLabel} recipe scope` : undefined}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <CockpitTile
          label="Diff view"
          value={diffAvailable ? diffValue : 'workspace'}
          onPress={onOpenDiff}
        />
        <CockpitTile
          label="Family"
          value={familySummary ? `${familySummary.runs} runs` : '-'}
          onPress={onOpenFamily}
          disabled={!familySummary}
        />
        <CockpitTile
          label="Family retros"
          value={familyRetrosCockpitValue(familySummary)}
          hint={familySummary ? `${familySummary.workflowState} retrospective context` : undefined}
          onPress={onOpenFamilyRetros}
          disabled={!familySummary}
        />
      </ScrollView>
    </View>
  );
}

function familyRetrosCockpitValue(summary: SlotFamilyContextSummary | null): string {
  if (!summary) return '-';
  if (summary.pendingRetrospectives > 0) {
    return `${summary.pendingRetrospectives} pending`;
  }
  if (summary.retrospectives > 0) {
    return `${summary.retrospectives} total`;
  }
  return 'none';
}

function gateStateLabel(gate: SlotWorkspaceGateSummary): string {
  if (!gate.resolved) return 'pending';
  if (gate.tone === 'ready') return 'ready';
  if (gate.tone === 'warning') return 'warning';
  return 'resolved';
}

function workspaceGateCockpitHint(gate: SlotWorkspaceGateSummary): string {
  const diffValue = workspaceGateDiffMetricValue(gate);
  const artifactLabel = `${gate.artifactPaths.length} file${
    gate.artifactPaths.length === 1 ? '' : 's'
  }`;
  return diffValue ? `${artifactLabel} · ${diffValue}` : artifactLabel;
}

function workspaceRetroCockpitHint(retro: SlotWorkspaceRetroSummary): string {
  const fileLabel = `${retro.artifactPaths.length} file${
    retro.artifactPaths.length === 1 ? '' : 's'
  }`;
  if (retro.visualPairCount === 0) return fileLabel;
  return `${fileLabel} · ${retro.visualPairCount} before→after`;
}

function CockpitTile({
  label,
  value,
  onPress,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onPress: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Pressable
      style={[styles.cockpitTile, disabled && styles.cockpitTileDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.cockpitTileLabel}>{label}</Text>
      <Text style={styles.cockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.cockpitTileHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

function SlotFamilyContextPanel({
  title = 'Family context',
  summary,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenFamily,
  onOpenFamilyEvidence,
  onOpenFamilyCompare,
  onOpenFamilyLedger,
  onOpenFamilyRetros,
  onOpenRecipe,
  onOpenTerminal,
  onOpenDecision,
}: {
  title?: string;
  summary: SlotFamilyContextSummary;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  onOpenFamily: () => void;
  onOpenFamilyEvidence: (runId?: string) => void;
  onOpenFamilyCompare: (runId?: string) => void;
  onOpenFamilyLedger: (runId?: string) => void;
  onOpenFamilyRetros: () => void;
  onOpenRecipe: () => void;
  onOpenTerminal: () => void;
  onOpenDecision: (decisionId: string, runId?: string, decisionKind?: string) => void;
}) {
  return (
    <View style={styles.familyContextPanel}>
      <View style={styles.workspaceGateHeader}>
        <View>
          <Text style={styles.recipeEvidenceTitle}>{title}</Text>
          <Text style={styles.recipeEvidenceMeta} numberOfLines={1}>
            {summary.title} · {summary.workflowState}
          </Text>
        </View>
        <Pressable style={styles.familyContextOpenButton} onPress={onOpenFamily}>
          <Text style={styles.familyContextOpenText}>Family</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.familyContextRail}
      >
        <FamilyContextMetric
          label="Runs"
          value={`${summary.runs} (${summary.activeRuns} active)`}
          onPress={onOpenFamily}
        />
        <FamilyContextMetric
          label="Evidence files"
          value={String(summary.evidence)}
          onPress={() => onOpenFamilyEvidence()}
          disabled={summary.evidence === 0}
        />
        <FamilyContextMetric
          label="Before→After"
          value={summary.visualPairLabel}
          onPress={() => onOpenFamilyCompare()}
          disabled={summary.visualPairs === 0}
        />
        <FamilyContextMetric
          label="Diff view"
          value={summary.diffLabel}
          onPress={() => onOpenFamilyLedger()}
          disabled={summary.diffLabel === 'no diff'}
        />
        <FamilyContextMetric
          label="Recipe files"
          value={summary.recipeQualityLabel}
          onPress={onOpenRecipe}
        />
        <FamilyContextMetric
          label="Retro gates"
          value={`${summary.pendingRetrospectives} pending / ${summary.retrospectives}`}
          onPress={onOpenFamilyRetros}
          disabled={summary.retrospectives === 0}
        />
        <FamilyContextMetric label="Terminal" value="live" onPress={onOpenTerminal} />
        {summary.ledgerLabel ? (
          <FamilyContextMetric
            label="Change ledger"
            value={summary.ledgerLabel}
            onPress={() => onOpenFamilyLedger()}
          />
        ) : null}
      </ScrollView>
      {summary.retrospectiveSignals.length > 0 ? (
        <View style={styles.familyRetroSignalList}>
          {summary.retrospectiveSignals.map((retro) => {
            const tone = retro.pending ? colors.statusWarn : colors.statusOk;
            const visualPair = retro.primaryVisualPair
              ? {
                  before: {
                    path: retro.primaryVisualPair.beforePath,
                    purpose: 'screenshot-before',
                    url: artifactUrl(gatewayUrl, retro.runId, retro.primaryVisualPair.beforePath),
                  },
                  after: {
                    path: retro.primaryVisualPair.afterPath,
                    purpose: 'screenshot-after',
                    url: artifactUrl(gatewayUrl, retro.runId, retro.primaryVisualPair.afterPath),
                  },
                  stem: retro.primaryVisualPair.stem,
                }
              : null;
            return (
              <View
                key={retro.decisionId}
                style={[styles.familyRetroSignalCard, { borderColor: tone + '55' }]}
              >
                <Pressable
                  onPress={() => onOpenDecision(retro.decisionId, retro.runId, 'retrospective')}
                >
                  <View style={styles.familyRetroSignalHeader}>
                    <View style={[styles.familyRetroStatusBadge, { backgroundColor: tone + '22' }]}>
                      <Text style={[styles.familyRetroStatusText, { color: tone }]}>
                        {retro.pending ? 'Pending retro gate' : 'Retro gate recorded'}
                      </Text>
                    </View>
                    <Text style={styles.pendingDecisionCta}>Open retro gate</Text>
                  </View>
                  <Text style={styles.familyRetroTitle} numberOfLines={1}>
                    {retro.title}
                  </Text>
                  <Text style={styles.familyRetroMeta} numberOfLines={1}>
                    {retro.runTitle} · {relativeTime(retro.createdAt)}
                  </Text>
                </Pressable>
                {visualPair ? (
                  <View style={styles.familyRetroVisualPreview}>
                    <BeforeAfterPreview
                      pair={visualPair}
                      authHeaders={artifactAuthHeaders}
                      onOpenArtifact={() => onOpenFamilyCompare(retro.runId)}
                      eyebrow={retro.pending ? 'Pending retro evidence' : 'Retro evidence'}
                      title="Before → after signal"
                      hint="Tap to compare"
                      imageHeight={58}
                    />
                  </View>
                ) : null}
                <View style={styles.familyRetroSignalActions}>
                  <FamilyRetroSignalAction
                    label="Evidence"
                    value={String(retro.artifactCount)}
                    onPress={() => onOpenFamilyEvidence(retro.runId)}
                    disabled={retro.artifactCount === 0}
                  />
                  <FamilyRetroSignalAction
                    label="Before→After"
                    value={String(retro.visualPairs)}
                    onPress={() => onOpenFamilyCompare(retro.runId)}
                    disabled={retro.visualPairs === 0}
                  />
                  <FamilyRetroSignalAction
                    label="Diff"
                    value={retro.diffLabel}
                    onPress={() => onOpenFamilyLedger(retro.runId)}
                    disabled={!retro.diffAvailable}
                  />
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function FamilyRetroSignalAction({
  label,
  value,
  onPress,
  disabled,
}: {
  label: string;
  value: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.familyRetroSignalAction, disabled && styles.familyContextMetricDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.familyRetroSignalActionLabel}>{label}</Text>
      <Text style={styles.familyRetroSignalActionValue} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

function FamilyContextMetric({
  label,
  value,
  onPress,
  disabled,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Text style={styles.familyContextMetricLabel}>{label}</Text>
      <Text style={styles.familyContextMetricValue} numberOfLines={1}>
        {value}
        {onPress && !disabled ? ' ›' : ''}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        style={[styles.familyContextMetric, disabled && styles.familyContextMetricDisabled]}
        onPress={onPress}
        disabled={disabled}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={styles.familyContextMetric}>{content}</View>;
}

function decisionPresentationForRun(run: Run, decision: RunDecision): DecisionPresentation {
  return presentDecision({
    ...decision,
    slotId: run.slotId,
    context: {
      ...(decision.context ?? {}),
      runId: run.id,
      familyId: run.familyId,
      ticketOrPr: run.ticketOrPr,
      slotId: run.slotId,
      project: run.project,
      artifactManifest: extractRunArtifactManifest(run),
    },
    runMeta: {
      runId: run.id,
      familyId: run.familyId,
      flowType: run.flowType,
      ticketOrPr: run.ticketOrPr,
      ...(run.prNumber ? { prNumber: run.prNumber } : {}),
      ...(run.branch ? { branch: run.branch } : {}),
      ...(run.metrics?.runner ? { runner: run.metrics.runner } : {}),
      ...(run.metrics?.model ? { model: run.metrics.model } : {}),
      ...(run.summary ? { summary: run.summary } : {}),
    },
  });
}

function SlotDecisionSignalsPanel({
  run,
  decisions,
  onOpenDecision,
  onOpenArtifacts,
  onOpenCompare,
  onOpenDiff,
}: {
  run: Run;
  decisions: RunDecision[];
  onOpenDecision: (decisionId: string) => void;
  onOpenArtifacts: () => void;
  onOpenCompare: () => void;
  onOpenDiff: () => void;
}) {
  const cards = [...decisions]
    .sort((left, right) => Number(Boolean(left.resolvedAt)) - Number(Boolean(right.resolvedAt)))
    .slice(0, 3)
    .map((decision) => ({
      decision,
      presentation: decisionPresentationForRun(run, decision),
    }));

  return (
    <View style={styles.decisionSignalsPanel}>
      <View style={styles.workspaceGateHeader}>
        <View>
          <Text style={styles.recipeEvidenceTitle}>Review / retro signals</Text>
          <Text style={styles.recipeEvidenceMeta}>
            {decisions.length} decision{decisions.length === 1 ? '' : 's'} ·{' '}
            {decisions.filter((decision) => !decision.resolvedAt).length} pending
          </Text>
        </View>
      </View>
      {cards.map(({ decision, presentation }) => {
        const resolved = Boolean(decision.resolvedAt);
        const tone = TONE_COLORS[resolved ? 'ok' : presentation.tone];
        return (
          <Pressable
            key={decision.id}
            style={[styles.decisionSignalCard, { borderLeftColor: tone }]}
            onPress={() => onOpenDecision(decision.id)}
          >
            <View style={styles.row}>
              <View style={[styles.decisionSignalBadge, { backgroundColor: tone + '22' }]}>
                <Text style={[styles.decisionSignalBadgeText, { color: tone }]}>
                  {resolved ? 'Resolved' : presentation.kindLabel}
                </Text>
              </View>
              <Text style={styles.pendingDecisionCta}>
                {presentation.kind === 'retrospective' ? 'Retro' : 'Review'}
              </Text>
            </View>
            <Text style={styles.pendingDecisionText} numberOfLines={2}>
              {presentation.title}
            </Text>
            <Text style={styles.decisionSignalSummary} numberOfLines={2}>
              {presentation.summary || presentation.description}
            </Text>
            {presentation.highlights.length > 0 ? (
              <View style={styles.decisionSignalChipRow}>
                {presentation.highlights.slice(0, 3).map((item) => {
                  const signalTone = TONE_COLORS[item.tone ?? 'info'];
                  const target = workspaceSignalTargetForDecisionLabel(item.label);
                  const content = (
                    <Text style={[styles.decisionSignalChipText, { color: signalTone }]}>
                      {item.label}: {item.value}
                      {target ? ' ›' : ''}
                    </Text>
                  );
                  return target ? (
                    <Pressable
                      key={`${decision.id}:${item.label}:${item.value}`}
                      style={[styles.decisionSignalChip, { borderColor: signalTone + '66' }]}
                      onPress={
                        target === 'diff'
                          ? onOpenDiff
                          : target === 'compare'
                            ? onOpenCompare
                            : onOpenArtifacts
                      }
                    >
                      {content}
                    </Pressable>
                  ) : (
                    <View
                      key={`${decision.id}:${item.label}:${item.value}`}
                      style={[styles.decisionSignalChip, { borderColor: signalTone + '66' }]}
                    >
                      {content}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function RunEvidencePreviewPanel({
  artifactCount,
  artifacts,
  primaryPair,
  runId,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenArtifacts,
  onOpenArtifact,
}: {
  artifactCount: number;
  artifacts: ArtifactManifestEntry[];
  primaryPair: VisualArtifactPair | null;
  runId: string;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  onOpenArtifacts: () => void;
  onOpenArtifact: (artifactPath: string) => void;
}) {
  return (
    <View style={styles.runEvidencePanel}>
      <View style={styles.workspaceGateHeader}>
        <View>
          <Text style={styles.recipeEvidenceTitle}>Run evidence</Text>
          <Text style={styles.recipeEvidenceMeta}>
            {artifactCount} artifact{artifactCount === 1 ? '' : 's'} from review/ready context
          </Text>
        </View>
        <Pressable style={styles.runEvidenceOpenButton} onPress={onOpenArtifacts}>
          <Text style={styles.runEvidenceOpenText}>Evidence files</Text>
        </Pressable>
      </View>
      {primaryPair ? (
        <BeforeAfterPreview
          pair={primaryPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={onOpenArtifact}
          title="Before → After difference"
          hint="Tap a side to inspect"
          imageHeight={74}
        />
      ) : null}
      {artifacts.length > 0 ? (
        <View style={styles.recipePreviewStrip}>
          {artifacts.map((artifact) => {
            const mediaType = classifyArtifact(artifact);
            return (
              <Pressable
                key={artifact.path}
                style={styles.recipePreviewButton}
                onPress={() => onOpenArtifact(artifact.path)}
              >
                {mediaType === 'image' ? (
                  <Image
                    source={artifactSource(
                      artifactUrlForEntry(gatewayUrl, runId, artifact),
                      artifactAuthHeaders,
                    )}
                    style={styles.recipePreviewImage}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.runEvidenceDocumentTile}>
                    <Text style={styles.runEvidenceDocumentKind}>{mediaType.toUpperCase()}</Text>
                    <Text style={styles.runEvidenceDocumentPath} numberOfLines={2}>
                      {artifact.path.split('/').pop() ?? artifact.path}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text style={styles.runEvidenceEmptyText}>
          No manifest preview was found. Open evidence files for reports, logs, and diffs.
        </Text>
      )}
    </View>
  );
}

function SlotRecipeEvidencePanel({
  summary,
  selectedRecipeRunId,
  selectedArtifactCount,
  runId,
  gatewayUrl,
  artifactAuthHeaders,
  previewArtifacts,
  primaryPair,
  onOpenRecipeArtifacts,
  onSelectRecipeRun,
}: {
  summary: SlotRecipeEvidenceSummary;
  selectedRecipeRunId: string | null;
  selectedArtifactCount: number;
  runId: string;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  previewArtifacts: ArtifactManifestEntry[];
  primaryPair: VisualArtifactPair | null;
  onOpenRecipeArtifacts: (
    recipeRunId: string,
    artifactPath?: string,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => void;
  onSelectRecipeRun: (recipeRunId: string | null) => void;
}) {
  return (
    <View style={styles.recipeEvidencePanel}>
      <View style={styles.workspaceGateHeader}>
        <View>
          <Text style={styles.recipeEvidenceTitle}>Recipe evidence</Text>
          <Text style={styles.recipeEvidenceMeta}>
            {summary.totalRuns} run{summary.totalRuns === 1 ? '' : 's'} · {summary.totalArtifacts}{' '}
            artifact{summary.totalArtifacts === 1 ? '' : 's'} · {summary.passingRuns} pass ·{' '}
            {summary.failingRuns} fail
            {summary.staleRuns > 0 ? ` · ${summary.staleRuns} stale` : ''}
          </Text>
        </View>
        <View style={styles.recipeEvidenceHeaderActions}>
          {selectedRecipeRunId ? (
            <Text style={styles.recipeEvidenceSelected}>{selectedArtifactCount} selected</Text>
          ) : null}
          <Pressable
            style={styles.recipeEvidenceOpenButton}
            onPress={() =>
              onOpenRecipeArtifacts(selectedRecipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM)
            }
          >
            <Text style={styles.recipeEvidenceOpenText}>Recipe files</Text>
          </Pressable>
        </View>
      </View>
      {primaryPair ? (
        <BeforeAfterPreview
          pair={primaryPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={(artifactPath) => {
            const target = [primaryPair.before, primaryPair.after].find(
              (artifact) => artifact.path === artifactPath,
            );
            onOpenRecipeArtifacts(
              target?.recipeRunId ?? selectedRecipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
              artifactPath,
              artifactFilterParamForWorkspaceNav('compare'),
            );
          }}
          title="Recipe before → after"
          hint="Tap to inspect"
          imageHeight={70}
        />
      ) : null}
      {previewArtifacts.length > 0 ? (
        <View style={styles.recipePreviewStrip}>
          {previewArtifacts.map((artifact) => {
            const recipeRunId =
              artifact.recipeRunId ?? selectedRecipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
            const mediaType = classifyArtifact(artifact);
            return (
              <Pressable
                key={`${recipeRunId}:${artifact.path}`}
                style={styles.recipePreviewButton}
                onPress={() => onOpenRecipeArtifacts(recipeRunId, artifact.path)}
              >
                {mediaType === 'image' ? (
                  <Image
                    source={artifactSource(
                      artifactUrlForEntry(gatewayUrl, runId, artifact),
                      artifactAuthHeaders,
                    )}
                    style={styles.recipePreviewImage}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.runEvidenceDocumentTile}>
                    <Text style={styles.runEvidenceDocumentKind}>{mediaType.toUpperCase()}</Text>
                    <Text style={styles.runEvidenceDocumentPath} numberOfLines={2}>
                      {artifact.path.split('/').pop() ?? artifact.path}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <View style={styles.recipeRunPickerHeader}>
        <Text style={styles.recipeRunPickerTitle}>Preview recipe run</Text>
        <Text style={styles.recipeRunPickerHint} numberOfLines={1}>
          Tap to update this slot preview · Open for full artifacts
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Pressable
          style={[styles.recipeRunChip, !selectedRecipeRunId && styles.recipeRunChipActive]}
          onPress={() => onSelectRecipeRun(null)}
        >
          <View style={styles.recipeRunChipHeader}>
            <Text style={[styles.recipeRunStatus, { color: colors.accent }]}>current</Text>
            <Text style={styles.recipeRunPromoted}>default</Text>
          </View>
          <Text
            style={[
              styles.recipeRunChipTitle,
              !selectedRecipeRunId && styles.recipeRunChipTitleActive,
            ]}
            numberOfLines={1}
          >
            Current preview
          </Text>
          <Text style={styles.recipeRunChipMeta}>
            gateway selected · {summary.totalArtifacts} artifact
            {summary.totalArtifacts === 1 ? '' : 's'}
          </Text>
        </Pressable>
        {summary.groups.map((group) => {
          const active = group.id === selectedRecipeRunId;
          const statusColor = recipeStatusColor(group.status);
          return (
            <Pressable
              key={group.id}
              style={[styles.recipeRunChip, active && styles.recipeRunChipActive]}
              onPress={() => onSelectRecipeRun(group.id)}
            >
              <View style={styles.recipeRunChipHeader}>
                <Text style={[styles.recipeRunStatus, { color: statusColor }]}>{group.status}</Text>
                {group.promoted ? <Text style={styles.recipeRunPromoted}>promoted</Text> : null}
              </View>
              <Text
                style={[styles.recipeRunChipTitle, active && styles.recipeRunChipTitleActive]}
                numberOfLines={1}
              >
                {group.label}
              </Text>
              <Text style={styles.recipeRunChipMeta}>
                {group.artifactCount} artifact{group.artifactCount === 1 ? '' : 's'}
                {group.isStale ? ' · stale' : ''}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function WorkspaceGateCard({
  gate,
  runId,
  artifactManifest,
  gatewayUrl,
  artifactAuthHeaders,
  compareTarget,
  compareFallbackPair,
  compareFallbackPairIsRecipe,
  runDiffValue,
  runDiffAvailable,
  onOpenDecision,
  onOpenAllArtifacts,
  onOpenArtifacts,
  onOpenCompareTarget,
  onOpenCompareFallbackArtifact,
  onOpenDiff,
  onOpenRecipe,
  onOpenTerminal,
}: {
  gate: SlotWorkspaceGateSummary;
  runId: string;
  artifactManifest: ArtifactManifestEntry[];
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  compareTarget: SlotCompareTarget | null;
  compareFallbackPair: VisualArtifactPair | null;
  compareFallbackPairIsRecipe: boolean;
  runDiffValue: string;
  runDiffAvailable: boolean;
  onOpenDecision: () => void;
  onOpenAllArtifacts: (artifactPath?: string) => void;
  onOpenArtifacts: (artifactPath?: string) => void;
  onOpenCompareTarget: () => void;
  onOpenCompareFallbackArtifact: (artifactPath: string) => void;
  onOpenDiff: () => void;
  onOpenRecipe: () => void;
  onOpenTerminal: () => void;
}) {
  const toneColor =
    gate.tone === 'ready'
      ? colors.statusOk
      : gate.tone === 'warning'
        ? colors.statusFail
        : colors.statusWarn;
  const previewArtifacts = selectSlotGatePreviewArtifacts(gate, artifactManifest, 6);
  const gateArtifacts = selectSlotGatePreviewArtifacts(
    gate,
    artifactManifest,
    gate.artifactPaths.length,
  );
  const visualPairSummary = groupVisualArtifactPairs(gateArtifacts, (artifact) =>
    artifactUrlForEntry(gatewayUrl, runId, artifact),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const fallbackVisualPair = primaryVisualPair ? null : compareFallbackPair;
  const comparePairCount =
    visualPairSummary.pairs.length > 0
      ? visualPairSummary.pairs.length
      : (compareTarget?.pairCount ?? 0);
  const openCompareEvidence = () => {
    if (primaryVisualPair) {
      onOpenArtifacts(primaryVisualPair.after.path);
      return;
    }
    if (compareTarget) onOpenCompareTarget();
  };
  const gateDiffValue = workspaceGateDiffMetricValue(gate);
  const gateDiffAvailable = isActionableWorkspaceDiffValue(gateDiffValue);
  const displayDiffValue = gateDiffValue ?? (runDiffAvailable ? runDiffValue : null);
  const displayDiffAvailable = gateDiffAvailable || runDiffAvailable;
  const openPrimaryEvidence = () => onOpenAllArtifacts(gate.primaryArtifactPath ?? undefined);
  return (
    <View style={[styles.workspaceGateCard, { borderColor: toneColor + '66' }]}>
      <View style={styles.workspaceGateHeader}>
        <View style={[styles.workspaceGateBadge, { backgroundColor: toneColor + '20' }]}>
          <Text style={[styles.workspaceGateBadgeText, { color: toneColor }]}>{gate.label}</Text>
        </View>
        <View style={styles.workspaceGateStatusWrap}>
          <Text style={styles.workspaceGateStatus}>{gate.resolved ? 'resolved' : 'pending'}</Text>
          {gate.artifactPaths.length > 0 ? (
            <Pressable style={styles.workspaceGateOpenButton} onPress={openPrimaryEvidence}>
              <Text style={[styles.workspaceGateOpenText, { color: toneColor }]}>Evidence</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.workspaceGateOpenButton} onPress={onOpenDecision}>
            <Text style={[styles.workspaceGateOpenText, { color: toneColor }]}>Open gate</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.workspaceGateTitle} numberOfLines={1}>
        {gate.title}
      </Text>
      {gate.primaryArtifactPath ? (
        <Text style={styles.workspaceGateEvidence} numberOfLines={1}>
          Evidence: {gate.primaryArtifactPath}
          {gate.artifactPaths.length > 1 ? ` +${gate.artifactPaths.length - 1}` : ''}
        </Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceActions}
      >
        <WorkspaceAction
          label="Open gate"
          value={gate.resolved ? 'resolved' : 'pending'}
          primary
          onPress={onOpenDecision}
        />
        <WorkspaceAction
          label="Evidence files"
          value={String(gate.artifactPaths.length)}
          onPress={openPrimaryEvidence}
          disabled={gate.artifactPaths.length === 0}
        />
        <WorkspaceAction
          label={primaryVisualPair || !compareTarget ? 'Before→After' : 'Recipe compare'}
          value={String(comparePairCount)}
          onPress={openCompareEvidence}
          disabled={comparePairCount === 0}
        />
        <WorkspaceAction
          label="Diff view"
          value={displayDiffValue ?? '-'}
          onPress={onOpenDiff}
          disabled={!displayDiffAvailable}
        />
        <WorkspaceAction label="Recipe files" value="context" onPress={onOpenRecipe} />
        <WorkspaceAction label="Terminal" value="live" onPress={onOpenTerminal} />
      </ScrollView>
      {gate.artifactPaths.length > 0 ? (
        <View style={styles.workspaceGateEvidenceList}>
          {gate.artifactPaths.slice(0, 4).map((artifactPath) => (
            <Pressable
              key={artifactPath}
              style={styles.workspaceGateEvidenceChip}
              onPress={() => onOpenArtifacts(artifactPath)}
            >
              <Text style={styles.workspaceGateEvidenceChipText} numberOfLines={1}>
                {artifactPath.split('/').pop() ?? artifactPath}
              </Text>
            </Pressable>
          ))}
          {gate.artifactPaths.length > 4 ? (
            <Pressable
              style={styles.workspaceGateEvidenceChip}
              onPress={() => onOpenAllArtifacts()}
            >
              <Text style={styles.workspaceGateEvidenceChipText}>
                +{gate.artifactPaths.length - 4} more
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {primaryVisualPair ? (
        <BeforeAfterPreview
          pair={primaryVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={onOpenArtifacts}
          title={`${gate.label} difference`}
          hint="Tap to inspect"
          imageHeight={70}
        />
      ) : null}
      {fallbackVisualPair ? (
        <BeforeAfterPreview
          pair={fallbackVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={onOpenCompareFallbackArtifact}
          eyebrow={compareFallbackPairIsRecipe ? 'Recipe compare' : 'Run compare'}
          title={
            compareFallbackPairIsRecipe
              ? 'Recipe before → after fallback'
              : 'Run before → after fallback'
          }
          hint="Gate has no visual pair"
          imageHeight={70}
        />
      ) : null}
      {previewArtifacts.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.workspaceGatePreviewStrip}
        >
          {previewArtifacts.map((artifact) => {
            const mediaType = classifyArtifact(artifact);
            return (
              <Pressable
                key={artifact.path}
                style={styles.recipePreviewButton}
                onPress={() => onOpenArtifacts(artifact.path)}
              >
                {mediaType === 'image' ? (
                  <Image
                    source={artifactSource(
                      artifactUrlForEntry(gatewayUrl, runId, artifact),
                      artifactAuthHeaders,
                    )}
                    style={styles.recipePreviewImage}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.runEvidenceDocumentTile}>
                    <Text style={styles.runEvidenceDocumentKind}>{mediaType.toUpperCase()}</Text>
                    <Text style={styles.runEvidenceDocumentPath} numberOfLines={2}>
                      {artifact.path.split('/').pop() ?? artifact.path}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      <Text style={styles.workspaceGateSummary} numberOfLines={2}>
        {gate.summary}
      </Text>
      <View style={styles.workspaceMetricRow}>
        {gate.metrics.map((metric) => (
          <WorkspaceMetric
            key={metric.label}
            label={metric.label}
            value={metric.value}
            onPress={workspaceGateMetricAction(
              metric.label,
              openPrimaryEvidence,
              comparePairCount > 0 ? openCompareEvidence : undefined,
              displayDiffAvailable ? onOpenDiff : undefined,
            )}
          />
        ))}
      </View>
    </View>
  );
}

function workspaceGateMetricAction(
  label: string,
  onOpenAllArtifacts: () => void,
  onOpenCompare?: () => void,
  onOpenDiff?: () => void,
): (() => void) | undefined {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'evidence') return onOpenAllArtifacts;
  if (normalized === 'diff') return onOpenDiff;
  if (normalized === 'before→after' || normalized === 'before/after') return onOpenCompare;
  return undefined;
}

function recipeStatusColor(status: RecipeRunArtifactGroup['status']): string {
  if (status === 'pass') return colors.statusOk;
  if (status === 'fail') return colors.statusFail;
  return colors.textMuted;
}

function HistoryRunCard({
  entry,
  slotId,
  onFocusRun,
  onOpenRun,
  onOpenArtifacts,
  onOpenCompare,
  recipeEvidence,
  runVisualEvidence,
  artifactAuthHeaders,
  onOpenCompareArtifact,
  onOpenRecipe,
  onOpenDiff,
  onOpenFamily,
  onOpenFamilyRetros,
  onOpenTerminal,
  onOpenPR,
}: {
  entry: SlotHistoryWorkspaceEntry;
  slotId: string;
  onFocusRun: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenCompare: () => void;
  recipeEvidence?: HistoryRecipeEvidenceSummary;
  runVisualEvidence?: HistoryRunVisualEvidenceSummary;
  artifactAuthHeaders: ArtifactHttpHeaders;
  onOpenCompareArtifact: (artifactPath: string, source: 'run' | 'recipe') => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenFamily: () => void;
  onOpenFamilyRetros: () => void;
  onOpenTerminal: () => void;
  onOpenPR: () => void;
}) {
  const statusColor = RUN_STATUS_COLORS[entry.status] ?? colors.textMuted;
  const modelLabel = entry.actualModel ?? entry.model ?? entry.runner ?? '-';
  const recipeKnown = recipeEvidence != null;
  const recipeArtifactCount = recipeEvidence?.artifactCount ?? 0;
  const recipeDisabled = !recipeKnown || recipeArtifactCount <= 0;
  const runPairCount = runVisualEvidence?.pairCount ?? entry.visualPairCount;
  const recipePairCount = recipeEvidence?.pairCount ?? 0;
  const comparePairCount = Math.max(runPairCount, recipePairCount);
  const previewPair = runVisualEvidence?.primaryPair ?? recipeEvidence?.primaryPair ?? null;
  const previewPairSource: 'run' | 'recipe' = runVisualEvidence?.primaryPair ? 'run' : 'recipe';
  const diffValue = entry.diffStat.available
    ? `+${entry.diffStat.additions} -${entry.diffStat.deletions}`
    : slotId
      ? 'workspace'
      : '-';
  return (
    <View style={styles.historyRunCard}>
      <View style={styles.row}>
        <View style={styles.historyRunTitleWrap}>
          <Text style={styles.historyRunTitle} numberOfLines={1}>
            {entry.ticketOrPr}
          </Text>
          <Text style={baseStyles.textMuted} numberOfLines={1}>
            {entry.flowType} · {relativeTime(entry.updatedAt)}
          </Text>
        </View>
        <Text style={[styles.historyRunStatus, { color: statusColor }]}>{entry.status}</Text>
      </View>
      {entry.summary ? (
        <Text style={baseStyles.textSecondary} numberOfLines={2}>
          {entry.summary}
        </Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceMetricRail}
      >
        <WorkspaceMetric compact label="Branch" value={entry.branch ?? '-'} />
        <WorkspaceMetric compact label="Duration" value={formatDuration(entry.durationMs)} />
        <WorkspaceMetric compact label="Model" value={modelLabel} />
        <WorkspaceMetric
          compact
          label="Evidence files"
          value={entry.artifactDir ? 'available' : '-'}
        />
        <WorkspaceMetric compact label="Before→After" value={String(comparePairCount)} />
        <WorkspaceMetric compact label="PR" value={entry.prNumber ? `#${entry.prNumber}` : '-'} />
      </ScrollView>
      {previewPair ? (
        <View style={styles.historyComparePreview}>
          <BeforeAfterPreview
            pair={previewPair}
            authHeaders={artifactAuthHeaders}
            onOpenArtifact={(artifactPath) =>
              onOpenCompareArtifact(artifactPath, previewPairSource)
            }
            eyebrow={previewPairSource === 'recipe' ? 'Recipe evidence' : 'Run evidence'}
            title={previewPairSource === 'recipe' ? 'Recipe before → after' : 'Run before → after'}
            hint="Tap side"
            imageHeight={58}
          />
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceActions}
      >
        <WorkspaceAction label="Focus" value="slot" primary onPress={onFocusRun} />
        <WorkspaceAction label="Run detail" value="open" onPress={onOpenRun} />
        <WorkspaceAction
          label="Evidence files"
          value={entry.artifactDir ? 'available' : '-'}
          onPress={onOpenArtifacts}
        />
        <WorkspaceAction
          label="Before→After"
          value={String(comparePairCount)}
          onPress={onOpenCompare}
          disabled={comparePairCount === 0}
        />
        <WorkspaceAction
          label="Recipe files"
          value={recipeKnown ? String(recipeArtifactCount) : '…'}
          onPress={onOpenRecipe}
          disabled={recipeDisabled}
        />
        <WorkspaceAction
          label="Diff view"
          value={diffValue}
          onPress={onOpenDiff}
          disabled={diffValue === '-'}
        />
        <WorkspaceAction label="Family" value={shortId(entry.familyId)} onPress={onOpenFamily} />
        <WorkspaceAction
          label="Retros"
          value={entry.familyId ? 'family' : '-'}
          onPress={onOpenFamilyRetros}
          disabled={!entry.familyId}
        />
        {entry.prNumber ? (
          <WorkspaceAction label="PR" value={`#${entry.prNumber}`} onPress={onOpenPR} />
        ) : null}
        <WorkspaceAction label="Terminal" value="slot" onPress={onOpenTerminal} />
      </ScrollView>
    </View>
  );
}

function WorkspaceMetric({
  label,
  value,
  compact,
  onPress,
  disabled,
}: {
  label: string;
  value: string;
  compact?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Text style={styles.workspaceMetricLabel}>{label}</Text>
      <Text style={styles.workspaceMetricValue} numberOfLines={1}>
        {value}
        {onPress && !disabled ? ' ›' : ''}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        style={[
          styles.workspaceMetric,
          compact && styles.workspaceMetricCompact,
          disabled && styles.workspaceActionButtonDisabled,
        ]}
        onPress={onPress}
        disabled={disabled}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View style={[styles.workspaceMetric, compact && styles.workspaceMetricCompact]}>
      {content}
    </View>
  );
}

function WorkspaceAction({
  label,
  value,
  primary,
  onPress,
  disabled,
}: {
  label: string;
  value?: string;
  primary?: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.workspaceActionButton,
        primary && styles.workspaceActionButtonPrimary,
        disabled && styles.workspaceActionButtonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.workspaceActionText, primary && styles.workspaceActionTextPrimary]}>
        {label}
      </Text>
      {value ? (
        <Text style={styles.workspaceActionValue} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
    </Pressable>
  );
}

function healthColor(val: string): string {
  if (val.includes('OK') || val === 'LOCAL' || val.includes('Wallet')) return colors.statusOk;
  if (val.includes('FAIL') || val.includes('OFF')) return colors.statusFail;
  if (val === '-') return colors.textMuted;
  return colors.statusWarn;
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center' },
  scrollContent: { padding: spacing.xl, paddingBottom: spacing.xxxl * 2 },
  stickyWorkspaceNav: {
    backgroundColor: colors.bgSurface,
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
    left: 0,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 20,
  },
  headerCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.lg,
    padding: spacing.xl,
    marginBottom: spacing.xl,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  slotName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXl,
    fontWeight: '700',
  },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 4,
  },
  badgeText: { fontSize: fonts.sizeSm, fontWeight: '600' },
  section: {
    marginBottom: spacing.xl,
  },
  errorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
  },
  healthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  healthItem: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.lg,
    minWidth: 90,
    alignItems: 'center',
  },
  healthLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  healthValue: {
    fontSize: fonts.sizeSm,
    fontWeight: '600',
  },
  infoRow: { gap: spacing.sm },
  workspaceCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  readyWorkspaceCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.statusOk + '44',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  focusedArtifactCard: {
    backgroundColor: colors.accent + '12',
    borderColor: colors.accent + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  focusedArtifactTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  focusedArtifactEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  focusedArtifactPath: {
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  focusedArtifactMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  workspaceBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  workspaceBadgeText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flex: 1,
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  workspaceFocusBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  workspaceFocusText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  workspaceCurrentButton: {
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  workspaceCurrentText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  workspaceMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
  },
  workspaceMetricRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  workspaceMetricRail: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  workspaceMetric: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    flexGrow: 1,
    minWidth: 92,
    padding: spacing.md,
  },
  workspaceMetricCompact: {
    flexGrow: 0,
    minWidth: 112,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  workspaceMetricLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  workspaceMetricValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    marginTop: spacing.xs,
  },
  cockpitPanel: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '30',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  slotCompareFocusPanel: {
    backgroundColor: colors.accent + '10',
    borderColor: colors.accent + '66',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  slotBeforeAfterPriorityPanel: {
    backgroundColor: colors.accent + '10',
    borderColor: colors.accent + '44',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  slotBeforeAfterPriorityActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  slotBeforeAfterPriorityCopy: {
    color: colors.textMuted,
    flex: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  slotBeforeAfterPriorityButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  slotBeforeAfterPriorityButtonText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  slotBeforeAfterPriorityRail: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  cockpitHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  cockpitTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  cockpitMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  cockpitTerminalButton: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  cockpitTerminalText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  cockpitRail: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  cockpitTile: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 104,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  cockpitTileDisabled: {
    opacity: 0.45,
  },
  cockpitTileLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  cockpitTileValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  cockpitTileHint: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 2,
    maxWidth: 110,
  },
  pendingDecisionBlock: {
    gap: spacing.sm,
  },
  workspaceFocusedGateBlock: {
    gap: spacing.sm,
  },
  workspaceFocusedGateTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  slotDiffFocusPanel: {
    backgroundColor: colors.accent + '10',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  slotMissingGateFocusPanel: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  slotTerminalFocusPanel: {
    backgroundColor: colors.lifecycleWorking + '10',
    borderColor: colors.lifecycleWorking + '66',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  slotRetroFocusPanel: {
    backgroundColor: colors.statusWarn + '10',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  slotRetroFocusTitleBlock: {
    flex: 1,
    gap: spacing.sm,
  },
  slotRetroVisualPreview: {
    marginTop: spacing.xs,
  },
  workspaceGateCard: {
    backgroundColor: colors.statusWarn + '10',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  workspaceGateList: {
    gap: spacing.md,
  },
  workspaceGateHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  workspaceGateStatusWrap: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  workspaceGateStatus: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceGateBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  workspaceGateBadgeText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceGateOpenButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  workspaceGateOpenText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  workspaceGateTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  workspaceGateSummary: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 19,
  },
  workspaceGateEvidence: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  workspaceGateEvidenceList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  workspaceGateEvidenceChip: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '44',
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 160,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  workspaceGateEvidenceChipText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  workspaceGatePreviewStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  pendingDecisionTitle: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  pendingDecisionCard: {
    alignItems: 'center',
    backgroundColor: colors.statusWarn + '14',
    borderColor: colors.statusWarn + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  pendingDecisionText: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  pendingDecisionCta: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  decisionSignalsPanel: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  decisionSignalCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderLeftWidth: 3,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  decisionSignalBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  decisionSignalBadgeText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  decisionSignalSummary: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
  decisionSignalChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  decisionSignalChip: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  decisionSignalChipText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  recipeEvidencePanel: {
    backgroundColor: colors.accent + '14',
    borderColor: colors.accent + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  runEvidencePanel: {
    backgroundColor: colors.statusOk + '12',
    borderColor: colors.statusOk + '44',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  familyContextPanel: {
    backgroundColor: colors.statusWarn + '10',
    borderColor: colors.statusWarn + '44',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  familyContextOpenButton: {
    borderColor: colors.statusWarn + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  familyContextOpenText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  familyContextRail: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  familyContextMetric: {
    backgroundColor: colors.bgInput,
    borderColor: colors.statusWarn + '22',
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 112,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  familyContextMetricDisabled: {
    opacity: 0.55,
  },
  familyContextMetricLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  familyContextMetricValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  familyRetroSignalList: {
    gap: spacing.sm,
  },
  familyRetroSignalCard: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  familyRetroSignalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  familyRetroStatusBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  familyRetroStatusText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  familyRetroTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  familyRetroMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  familyRetroVisualPreview: {
    marginTop: spacing.xs,
  },
  familyRetroSignalActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  familyRetroSignalAction: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.sm,
    borderWidth: 1,
    minWidth: 78,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  familyRetroSignalActionLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  familyRetroSignalActionValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: 1,
  },
  runEvidenceOpenButton: {
    borderColor: colors.statusOk + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  runEvidenceOpenText: {
    color: colors.statusOk,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  recipeEvidenceHeaderActions: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  recipeEvidenceOpenButton: {
    borderColor: colors.accent + '77',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  recipeEvidenceOpenText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  runEvidenceEmptyText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
  },
  recipeEvidenceTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  recipeEvidenceMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  recipeEvidenceSelected: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  recipePreviewStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  recipePreviewButton: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  recipeRunPickerHeader: {
    gap: spacing.xs,
  },
  recipeRunPickerTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  recipeRunPickerHint: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  recipePreviewImage: {
    backgroundColor: colors.bgInput,
    height: 56,
    width: 76,
  },
  runEvidenceDocumentTile: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    gap: spacing.xs,
    height: 56,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    width: 86,
  },
  runEvidenceDocumentKind: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  runEvidenceDocumentPath: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 14,
    textAlign: 'center',
  },
  recipeRunChip: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    marginRight: spacing.sm,
    minWidth: 144,
    padding: spacing.md,
  },
  recipeRunChipActive: {
    backgroundColor: colors.accent + '20',
    borderColor: colors.accent,
  },
  recipeRunChipHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  recipeRunStatus: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  recipeRunPromoted: {
    color: colors.statusOk,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  recipeRunChipTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: spacing.xs,
  },
  recipeRunChipTitleActive: {
    color: colors.accent,
  },
  recipeRunChipMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  workspaceActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  workspaceActionButton: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 104,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  workspaceActionButtonPrimary: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
  },
  workspaceActionButtonDisabled: {
    opacity: 0.45,
  },
  workspaceActionText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceActionTextPrimary: {
    color: colors.accent,
  },
  workspaceActionValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  recentRunsBlock: {
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  recentRunsTitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  historyRunCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    gap: spacing.md,
    padding: spacing.lg,
  },
  historyComparePreview: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '24',
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.xs,
  },
  historyRunTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  historyRunTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
  historyRunStatus: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  phaseCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  phaseName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '600',
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
    paddingLeft: spacing.md,
  },
  stepIcon: {
    color: colors.statusOk,
    fontSize: fonts.sizeSm,
    width: 16,
  },
  stepName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    flex: 1,
  },
});
