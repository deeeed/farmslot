import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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
  isTerminalRunStatus,
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  type RunDecision,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type RunReplayStepResult,
  type RunStep,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import { BeforeAfterPreview } from '../../components/BeforeAfterPreview';
import { RecipeRunControls } from '../../components/RecipeRunControls';
import { RunPipelineFull } from '../../components/RunPipeline';
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
import type { GatewayClient } from '../../lib/gateway-client';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { runRefreshEventMatches } from '../../lib/run-refresh';
import {
  hasRunWorkspaceDiff,
  isActionableWorkspaceDiffValue,
  runWorkspaceDiffValue,
  selectSlotCompareTarget,
  selectSlotGatePreviewArtifacts,
  selectSlotRecipeArtifactsForPreviewScope,
  type SlotCompareTarget,
  type SlotWorkspaceGateSummary,
  type SlotWorkspaceRetroSummary,
  summarizeSlotWorkspaceGates,
  summarizeSlotWorkspaceRetro,
  workspaceGateDiffMetricValue,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
  taskProgressPercent,
  taskProgressTitle,
} from '../../lib/task-progress';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';
import { buildFailedStepDiagnosticDraft } from '../../lib/workspace-copilot';
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
import { useRunStore } from '../../store/runs';

const STATUS_COLORS: Record<string, string> = {
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
// Gateway artifact text cache TTL is 5s; delayed refresh lets typed manifests written
// at completion replace the initial live-run placeholder/missing-file cache entry.
const RECIPE_COMPLETION_REFRESH_DELAY_MS = 5500;

function formatDuration(ms: number | undefined): string {
  if (!ms) return '-';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export default function RunDetailScreen() {
  const { id, recipeRun, artifact, workspace, decisionKind } = useLocalSearchParams<{
    id: string;
    recipeRun?: string | string[];
    artifact?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const connectionStatus = useConnectionStore((s) => s.status);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const storeRun = useRunStore((s) => s.runs.find((r) => r.id === id));
  const upsertRun = useRunStore((s) => s.upsertRun);
  const [run, setRun] = useState<Run | null>(storeRun ?? null);
  const [recipeRuns, setRecipeRuns] = useState<RecipeRunArtifactGroup[]>([]);
  const [recipeRunsLoaded, setRecipeRunsLoaded] = useState(false);
  const [selectedRecipeRunId, setSelectedRecipeRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [replayingStepName, setReplayingStepName] = useState<string | null>(null);
  const recipeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [navLayout, setNavLayout] = useState<WorkspaceStickyNavLayout | null>(null);
  const [stickyNavVisible, setStickyNavVisibleState] = useState(false);
  const stickyNavVisibleRef = useRef(false);
  const scrollY = useSharedValue(0);

  const requestedRecipeRunId = Array.isArray(recipeRun)
    ? (recipeRun[0] ?? null)
    : (recipeRun ?? null);
  const requestedRecipeRunIdRef = useRef<string | null>(requestedRecipeRunId);
  const requestedArtifactPath = Array.isArray(artifact) ? (artifact[0] ?? '') : (artifact ?? '');
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        'run',
      ),
    [decisionKind, workspace],
  );
  const diffRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('diff', workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );
  const targetRouteContext = useCallback(
    (targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0]) =>
      targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );

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

  useEffect(() => {
    requestedRecipeRunIdRef.current = requestedRecipeRunId;
  }, [requestedRecipeRunId]);

  useEffect(
    () => () => {
      if (recipeRefreshTimerRef.current) clearTimeout(recipeRefreshTimerRef.current);
    },
    [],
  );

  const loadRecipeRuns = useCallback(
    (selectionHint: string | null) => {
      if (!client || !id) {
        setRecipeRunsLoaded(false);
        return Promise.resolve();
      }
      setRecipeRunsLoaded(false);
      return client
        .request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', { runId: id })
        .then((result) => {
          setRecipeRuns(result.recipeRuns);
          setSelectedRecipeRunId(
            selectionHint === DECISION_EVIDENCE_RECIPE_RUN_PARAM
              ? null
              : resolveRecipeRunSelection(
                  result.recipeRuns,
                  selectionHint,
                  result.selectedRecipeRunId,
                ),
          );
        })
        .finally(() => setRecipeRunsLoaded(true));
    },
    [client, id],
  );

  const loadRun = useCallback(() => {
    if (!client || !id) return Promise.resolve();
    setError(null);
    return client
      .request<RunGetResult>('run.get', { runId: id })
      .then((r) => setRun(r.run))
      .catch((err: Error) => setError(`Failed to load run: ${err.message}`));
  }, [client, id]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  const refreshRecipeState = useCallback(
    (recipeRequestId?: string) => {
      // Prefer the live group for the completed request, then let
      // resolveRecipeRunSelection fall back to the gateway-selected group if the
      // live group was promoted/renamed while the delayed refresh waited out the
      // artifact text cache.
      const selectionHint = recipeRequestId ? `live-run:${recipeRequestId}` : null;
      void loadRun();
      void loadRecipeRuns(selectionHint).catch((err: Error) =>
        setError(`Failed to load recipe runs: ${err.message}`),
      );
      if (recipeRefreshTimerRef.current) clearTimeout(recipeRefreshTimerRef.current);
      recipeRefreshTimerRef.current = setTimeout(() => {
        recipeRefreshTimerRef.current = null;
        void loadRun();
        void loadRecipeRuns(selectionHint).catch((err: Error) =>
          setError(`Failed to load recipe runs: ${err.message}`),
        );
      }, RECIPE_COMPLETION_REFRESH_DELAY_MS);
    },
    [loadRecipeRuns, loadRun],
  );

  useEffect(() => {
    loadRecipeRuns(requestedRecipeRunId).catch((err: Error) =>
      setError(`Failed to load recipe runs: ${err.message}`),
    );
  }, [loadRecipeRuns, requestedRecipeRunId]);

  useEffect(() => {
    if (!client || !id) return;
    const handleRunEvent = (payload: unknown, reason: string) => {
      const event = payload as { run?: Run; runId?: string };
      if (!runRefreshEventMatches(id, event)) return;
      if (event.run?.id === id) {
        setRun(event.run);
        upsertRun(event.run);
      } else {
        void loadRun();
      }
      loadRecipeRuns(requestedRecipeRunIdRef.current).catch((err: Error) =>
        setError(`Failed to refresh recipe runs after ${reason}: ${err.message}`),
      );
    };
    const unsubscribers = [
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
  }, [client, id, loadRecipeRuns, loadRun, upsertRun]);

  const fetchTaskProgress = useCallback(() => {
    if (!client || !run?.slotId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, { slotId: run.slotId, runId: run.id })
      .then((result) => {
        setTaskProgress(result.structured ?? null);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [client, run?.id, run?.slotId]);

  useEffect(() => {
    if (!client || !run) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(run, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, run]);

  useEffect(() => {
    if (!isWorkerProgressActive(run)) {
      setTaskProgress(null);
      setTaskProgressError(null);
      return;
    }
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTaskProgress, run]);

  const handleSelectRecipeRun = useCallback(
    (recipeRunId: string | null) => {
      setSelectedRecipeRunId(recipeRunId);
      router.setParams({ recipeRun: recipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM });
    },
    [router],
  );

  const goBackOrRuns = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/runs');
  }, [router]);

  const replayStep = useCallback(
    async (stepName: string, skipPrepare?: boolean) => {
      if (!client || !run) return;
      setReplayingStepName(stepName);
      setError(null);
      try {
        const result = await client.request<RunReplayStepResult>(Methods.RUN_REPLAY_STEP, {
          runId: run.id,
          stepName,
          ...(skipPrepare ? { skipPrepare: true } : {}),
        });
        setRun(result.run);
        upsertRun(result.run);
        setExpandedStep(null);
      } catch (err) {
        setError(`Failed to retry from ${stepName}: ${(err as Error).message}`);
      } finally {
        setReplayingStepName(null);
      }
    },
    [client, run, upsertRun],
  );

  const confirmReplayStep = useCallback(
    (stepName: string, skipPrepare?: boolean) => {
      if (!run) return;
      Alert.alert(
        skipPrepare ? 'Warm retry from here?' : 'Retry from here?',
        skipPrepare
          ? `Replay "${stepName}" and subsequent steps for ${run.ticketOrPr}, reusing the warm slot.`
          : `Replay "${stepName}" and all subsequent steps for ${run.ticketOrPr}.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: skipPrepare ? 'Warm retry' : 'Retry',
            style: 'destructive',
            onPress: () => void replayStep(stepName, skipPrepare),
          },
        ],
      );
    },
    [replayStep, run],
  );

  const openFailedStepDiagnosis = useCallback(
    (step: RunStep) => {
      if (!run) return;
      router.push({
        pathname: '/(tabs)/copilot',
        params: {
          draft: buildFailedStepDiagnosticDraft({
            runId: run.id,
            ticketOrPr: run.ticketOrPr,
            flowType: run.flowType,
            slotId: run.slotId,
            stepName: step.name,
            stepDetail: step.detail,
          }),
        },
      });
    },
    [router, run],
  );

  const activeTaskProgress = useMemo(
    () => effectiveTaskProgressForRun(run, taskProgress) ?? null,
    [run, taskProgress],
  );
  const workspaceGates = useMemo(() => (run ? summarizeSlotWorkspaceGates(run) : []), [run]);
  const activeDiffValue = useMemo(
    () => (run ? runWorkspaceDiffValue(run, workspaceGates[0] ?? null) : '-'),
    [run, workspaceGates],
  );
  const selectedRecipeRun = useMemo(
    () => recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null,
    [recipeRuns, selectedRecipeRunId],
  );
  const workspaceRecipeRunId =
    requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : selectedRecipeRunId;
  const selectedRecipeArtifactCount = selectedRecipeRun
    ? artifactsForRecipeRun(selectedRecipeRun).length
    : 0;
  const runArtifactCount = run ? extractRunArtifactManifest(run).length : null;
  const totalRecipeArtifactCount = useMemo(
    () => recipeRuns.reduce((sum, group) => sum + artifactsForRecipeRun(group).length, 0),
    [recipeRuns],
  );
  const recipeAvailable = recipeRunsLoaded ? totalRecipeArtifactCount > 0 : undefined;
  const visibleRecipeArtifactCount = recipeRunsLoaded
    ? totalRecipeArtifactCount || selectedRecipeArtifactCount
    : null;
  const compareTarget = useMemo(
    () =>
      run
        ? selectSlotCompareTarget({
            runArtifacts: extractRunArtifactManifest(run),
            recipeRuns,
            selectedRecipeRunId,
          })
        : null,
    [recipeRuns, run, selectedRecipeRunId],
  );

  if (!run) {
    return (
      <View
        style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        <Text style={baseStyles.textSecondary}>
          {client && connectionStatus === 'connected'
            ? 'Loading run...'
            : 'Connect to the gateway to load this run.'}
        </Text>
        <Pressable style={styles.backFallbackButton} onPress={goBackOrRuns}>
          <Text style={styles.backFallbackText}>Back to runs</Text>
        </Pressable>
      </View>
    );
  }

  const statusColor = STATUS_COLORS[run.status] ?? colors.textMuted;
  const replayAllowed =
    ['failed', 'done', 'cancelled'].includes(run.status) &&
    Boolean(client) &&
    connectionStatus === 'connected';
  const primaryDecision = selectPrimaryWorkspaceDecision(run);
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const readyGateForNav = workspaceGates.find((gate) => gate.label === 'Ready workspace') ?? null;
  const reviewGateForNav =
    workspaceGates.find(
      (gate) => gate.label === 'Review workspace' || gate.label === 'No-change review',
    ) ?? null;
  const retroSummaryForNav = summarizeSlotWorkspaceRetro(run);
  const focusedArtifactPath = requestedArtifactPath.trim() || null;
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const workspaceNavProps = {
    dense: true,
    current: workspaceNavCurrentForRoute('run', workspaceRouteContext.workspace),
    routeWorkspace: workspaceRouteContext.workspace,
    routeDecisionKind: workspaceRouteContext.decisionKind,
    decisionId: primaryDecision?.id ?? null,
    decisionKind: workspaceDecisionKind(primaryDecision),
    readyDecisionId: readyDecision?.id ?? null,
    reviewDecisionId: reviewGateDecision?.id ?? null,
    retroDecisionId: retroDecision?.id ?? null,
    readyMeta: workspaceGateNavMeta(readyGateForNav),
    reviewMeta: workspaceGateNavMeta(reviewGateForNav),
    retroMeta: workspaceRetroNavMeta(retroSummaryForNav),
    familyId: run.familyId,
    project: run.project,
    prNumber: run.prNumber,
    prRepo: prRepoFromWorkspaceSource(run, run.prNumber ?? null),
    recipeRunId: workspaceRecipeRunId,
    recipeAvailable,
    recipeArtifactCount: visibleRecipeArtifactCount,
    diffAvailable: activeDiffValue !== '-',
    artifactCount: runArtifactCount,
    visualPairCount: compareTarget?.pairCount ?? 0,
    compareArtifactPath: compareTarget?.artifactPath ?? null,
    compareRecipeRunId: compareTarget?.recipeRunId,
    artifactPath: focusedArtifactPath,
    slotId: run.slotId,
    runId: run.id,
  };
  const openRunEvidenceArtifact = (
    artifactPath?: string,
    recipeRunId?: string | null,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => {
    const recipeRunParam = recipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM;
    if (artifactPath && diffArtifactCandidate([{ path: artifactPath }])) {
      router.push({
        pathname: '/diff/[runId]',
        params: {
          runId: run.id,
          ...diffRouteContext,
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
        : artifactPath
          ? (artifactFilterParamForArtifactPath(artifactPath) ??
            artifactFilterParamForWorkspaceNav('review'))
          : artifactFilterParamForWorkspaceNav('review'));
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: run.id,
        ...targetRouteContext(targetWorkspaceForArtifactRoute(recipeRunParam, targetFilter)),
        recipeRun: recipeRunParam,
        ...(targetFilter ? { filter: targetFilter } : {}),
        ...(artifactPath ? { artifact: artifactPath } : {}),
      },
    });
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
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: styles.scrollContent.paddingBottom + insets.bottom },
        ]}
      >
        <View style={styles.headerCard}>
          <View style={styles.row}>
            <View style={[styles.flowBadge, { backgroundColor: colors.accent + '30' }]}>
              <Text style={[styles.flowText, { color: colors.accent }]}>{run.flowType}</Text>
            </View>
            <View style={[styles.statusBadge, { backgroundColor: statusColor + '30' }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>{run.status}</Text>
            </View>
          </View>
          <Text style={styles.ticketText}>{run.ticketOrPr}</Text>
          {run.summary && <Text style={baseStyles.textSecondary}>{run.summary}</Text>}
          <View style={[styles.row, { marginTop: spacing.lg }]}>
            {run.slotId && <Text style={baseStyles.textMuted}>Slot: {run.slotId}</Text>}
            <Text style={baseStyles.textMuted}>{formatDuration(run.metrics?.durationMs)}</Text>
          </View>
        </View>

        <View onLayout={rememberNavLayout}>
          <RunWorkspaceNav {...workspaceNavProps} />
        </View>

        {focusedArtifactPath ? (
          <RunFocusedArtifactCard
            artifactPath={focusedArtifactPath}
            recipeRunId={workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM}
            slotId={run.slotId}
            familyId={run.familyId}
            prNumber={run.prNumber}
            recipeAvailable={recipeAvailable}
            diffAvailable={activeDiffValue !== '-' || Boolean(run.slotId)}
            diffValue={activeDiffValue !== '-' ? activeDiffValue : run.slotId ? 'workspace' : '-'}
            comparePairCount={compareTarget?.pairCount ?? 0}
            onOpenArtifact={() =>
              openRunEvidenceArtifact(
                focusedArtifactPath,
                workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
              )
            }
            onOpenFiles={() =>
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: run.id,
                  ...targetRouteContext(
                    targetWorkspaceForArtifactRoute(
                      workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      artifactFilterParamForArtifactPath(focusedArtifactPath) ??
                        (workspaceRecipeRunId &&
                        workspaceRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? artifactFilterParamForWorkspaceNav('recipe')
                          : artifactFilterParamForWorkspaceNav('review')),
                    ),
                  ),
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: focusedArtifactPath,
                  filter:
                    artifactFilterParamForArtifactPath(focusedArtifactPath) ??
                    (workspaceRecipeRunId &&
                    workspaceRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                      ? artifactFilterParamForWorkspaceNav('recipe')
                      : artifactFilterParamForWorkspaceNav('review')),
                },
              })
            }
            onOpenRecipe={() => {
              const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: run.id,
                  ...targetRouteContext('recipe'),
                  recipeRun: recipeTarget,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                  ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
                    ? { artifact: focusedArtifactPath }
                    : {}),
                },
              });
            }}
            onOpenDiff={() =>
              activeDiffValue === '-' && run.slotId
                ? router.push({
                    pathname: '/diff/slot/[slotId]',
                    params: {
                      slotId: run.slotId,
                      ...diffRouteContext,
                      ...(focusedArtifactIsDiff ? { path: focusedArtifactPath } : {}),
                    },
                  })
                : router.push({
                    pathname: '/diff/[runId]',
                    params: {
                      runId: run.id,
                      ...diffRouteContext,
                      ...(focusedArtifactIsDiff ? { path: focusedArtifactPath } : {}),
                      recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
            }
            onOpenCompare={() => {
              if (!compareTarget) return;
              openRunEvidenceArtifact(
                compareTarget.artifactPath,
                compareTarget.recipeRunId,
                artifactFilterParamForWorkspaceNav('compare'),
              );
            }}
            onOpenSlot={() => {
              if (!run.slotId) return;
              router.push({
                pathname: '/slot/[id]',
                params: {
                  id: run.slotId,
                  ...targetRouteContext('slot'),
                  runId: run.id,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: focusedArtifactPath,
                },
              });
            }}
            onOpenTerminal={() => {
              if (!run.slotId) return;
              router.push({
                pathname: '/terminal/[slotId]',
                params: {
                  slotId: run.slotId,
                  ...targetRouteContext('terminal'),
                  runId: run.id,
                  details: '1',
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: focusedArtifactPath,
                },
              });
            }}
            onOpenFamily={() => {
              if (!run.familyId) return;
              router.push({
                pathname: '/family/[familyId]',
                params: {
                  familyId: run.familyId,
                  project: run.project,
                  ...familySectionRouteContextParams('focus', workspaceRouteContext.decisionKind),
                  runId: run.id,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
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

        <RunReviewWorkspaceSummary
          run={run}
          gates={workspaceGates}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          recipeArtifactCount={visibleRecipeArtifactCount}
          recipeAvailable={recipeAvailable}
          recipeRuns={recipeRuns}
          selectedRecipeRunId={selectedRecipeRunId}
          compareTarget={compareTarget}
          activeTaskProgress={isWorkerProgressActive(run) ? activeTaskProgress : null}
          taskProgressError={taskProgressError}
          onOpenDecision={(decisionId) =>
            router.push({
              pathname: '/decision/[id]',
              params: {
                id: decisionId,
                ...decisionWorkspaceRouteParams(
                  workspaceDecisionKind(
                    run.decisions.find((decision) => decision.id === decisionId),
                  ),
                ),
                runId: run.id,
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            })
          }
          onOpenArtifacts={(artifactPath) =>
            openRunEvidenceArtifact(artifactPath, DECISION_EVIDENCE_RECIPE_RUN_PARAM)
          }
          onOpenRecipeArtifact={(artifactPath, recipeRunId) =>
            openRunEvidenceArtifact(
              artifactPath,
              recipeRunId,
              artifactFilterParamForWorkspaceNav('compare'),
            )
          }
          onOpenRecipe={() => {
            const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
            router.push({
              pathname: '/artifacts/[runId]',
              params: {
                runId: run.id,
                ...targetRouteContext('recipe'),
                recipeRun: recipeTarget,
                filter: artifactFilterParamForWorkspaceNav('recipe'),
                ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
                  ? { artifact: focusedArtifactPath }
                  : {}),
              },
            });
          }}
          onOpenDiff={() =>
            activeDiffValue === '-' && run.slotId
              ? router.push({
                  pathname: '/diff/slot/[slotId]',
                  params: { slotId: run.slotId, ...diffRouteContext },
                })
              : router.push({
                  pathname: '/diff/[runId]',
                  params: {
                    runId: run.id,
                    ...diffRouteContext,
                    ...(focusedArtifactIsDiff && focusedArtifactPath
                      ? { path: focusedArtifactPath }
                      : {}),
                    recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
          }
          onOpenFamily={() =>
            run.familyId
              ? router.push({
                  pathname: '/family/[familyId]',
                  params: {
                    familyId: run.familyId,
                    project: run.project,
                    ...familySectionRouteContextParams('focus', workspaceRouteContext.decisionKind),
                    runId: run.id,
                    ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                    ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                    section: 'focus',
                  },
                })
              : undefined
          }
          onOpenFamilyRetros={() =>
            run.familyId
              ? router.push({
                  pathname: '/family/[familyId]',
                  params: {
                    familyId: run.familyId,
                    project: run.project,
                    ...familySectionRouteContextParams(
                      'retros',
                      workspaceRouteContext.decisionKind,
                    ),
                    runId: run.id,
                    ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                    ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                    section: 'retros',
                  },
                })
              : undefined
          }
          onOpenTerminal={() =>
            run.slotId
              ? router.push({
                  pathname: '/terminal/[slotId]',
                  params: {
                    slotId: run.slotId,
                    ...targetRouteContext('terminal'),
                    runId: run.id,
                    details: '1',
                    ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                    ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                  },
                })
              : undefined
          }
          onOpenSlot={() =>
            run.slotId
              ? router.push({
                  pathname: '/slot/[id]',
                  params: {
                    id: run.slotId,
                    ...targetRouteContext('slot'),
                    runId: run.id,
                    recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                  },
                })
              : undefined
          }
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
          onOpenCompareTarget={() => {
            if (!compareTarget) return;
            openRunEvidenceArtifact(
              compareTarget.artifactPath,
              compareTarget.recipeRunId,
              artifactFilterParamForWorkspaceNav('compare'),
            );
          }}
        />

        {/* Decisions */}
        {(run.decisions ?? []).length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Decisions</Text>
            {(run.decisions ?? []).map((d) => (
              <DecisionSummaryCard
                key={d.id}
                presentation={decisionPresentationForRun(run, d)}
                resolvedAction={d.resolvedAction}
                resolvedAt={d.resolvedAt}
                onPress={() =>
                  router.push({
                    pathname: '/decision/[id]',
                    params: {
                      id: d.id,
                      ...decisionWorkspaceRouteParams(workspaceDecisionKind(d)),
                      runId: run.id,
                      ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                      ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                    },
                  })
                }
                onOpenArtifacts={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: run.id,
                      ...targetRouteContext(
                        workspaceRecipeRunId &&
                          workspaceRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? 'recipe'
                          : 'artifacts',
                      ),
                      recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter:
                        workspaceRecipeRunId &&
                        workspaceRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? artifactFilterParamForWorkspaceNav('recipe')
                          : artifactFilterParamForWorkspaceNav('review'),
                      ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                    },
                  })
                }
                onOpenDiff={() =>
                  activeDiffValue === '-' && run.slotId
                    ? router.push({
                        pathname: '/diff/slot/[slotId]',
                        params: {
                          slotId: run.slotId,
                          ...diffRouteContext,
                          ...(focusedArtifactIsDiff && focusedArtifactPath
                            ? { path: focusedArtifactPath }
                            : {}),
                        },
                      })
                    : router.push({
                        pathname: '/diff/[runId]',
                        params: {
                          runId: run.id,
                          ...diffRouteContext,
                          recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                          ...(focusedArtifactIsDiff && focusedArtifactPath
                            ? { path: focusedArtifactPath }
                            : {}),
                        },
                      })
                }
                onOpenCompare={(artifactPath) => {
                  if (artifactPath) {
                    openRunEvidenceArtifact(artifactPath, DECISION_EVIDENCE_RECIPE_RUN_PARAM);
                    return;
                  }
                  if (compareTarget) {
                    openRunEvidenceArtifact(
                      compareTarget.artifactPath,
                      compareTarget.recipeRunId,
                      artifactFilterParamForWorkspaceNav('compare'),
                    );
                    return;
                  }
                  openRunEvidenceArtifact(undefined, DECISION_EVIDENCE_RECIPE_RUN_PARAM);
                }}
              />
            ))}
          </View>
        )}

        {/* Step Timeline */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pipeline</Text>
          {(run.steps ?? []).length > 0 && (
            <RunPipelineFull
              steps={run.steps}
              runStatus={run.status}
              onStepPress={(_name, i) =>
                setExpandedStep((current) => {
                  const key = `${run.steps[i].name}-${i}`;
                  return current === key ? null : key;
                })
              }
            />
          )}
          {(run.steps ?? []).map((step, i) => (
            <PipelineStepCard
              key={`${step.name}-${i}`}
              step={step}
              index={i}
              expanded={expandedStep === `${step.name}-${i}`}
              allowReplay={replayAllowed && !replayingStepName}
              replaying={replayingStepName === step.name}
              onReplayStep={(skipPrepare) => confirmReplayStep(step.name, skipPrepare)}
              onDiagnoseFailure={() => openFailedStepDiagnosis(step)}
              onOpenArtifact={(artifactPath) => {
                if (diffArtifactCandidate([{ path: artifactPath }])) {
                  router.push({
                    pathname: '/diff/[runId]',
                    params: {
                      runId: run.id,
                      ...diffRouteContext,
                      path: artifactPath,
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  });
                  return;
                }
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: run.id,
                    ...targetRouteContext(
                      targetWorkspaceForArtifactRoute(
                        DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                        artifactFilterParamForArtifactPath(artifactPath) ??
                          artifactFilterParamForWorkspaceNav('review'),
                      ),
                    ),
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    artifact: artifactPath,
                    filter:
                      artifactFilterParamForArtifactPath(artifactPath) ??
                      artifactFilterParamForWorkspaceNav('review'),
                  },
                });
              }}
              onToggle={() =>
                setExpandedStep((current) =>
                  current === `${step.name}-${i}` ? null : `${step.name}-${i}`,
                )
              }
            />
          ))}
        </View>

        {/* Artifacts */}
        <RecipeRunsSection
          run={run}
          client={client}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          recipeRuns={recipeRuns}
          selectedRecipeRunId={selectedRecipeRunId}
          onSelectRecipeRun={handleSelectRecipeRun}
          onViewArtifacts={(recipeRunId) =>
            router.push({
              pathname: '/artifacts/[runId]',
              params: {
                runId: run.id,
                ...targetRouteContext('recipe'),
                recipeRun: recipeRunId,
                filter: artifactFilterParamForWorkspaceNav('recipe'),
              },
            })
          }
          onOpenRecipeArtifact={(recipeRunId, artifactPath, filter) =>
            openRunEvidenceArtifact(artifactPath, recipeRunId, filter)
          }
          onRecipeComplete={refreshRecipeState}
        />

        <ArtifactsSection
          run={run}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          onViewAll={() =>
            router.push({
              pathname: '/artifacts/[runId]',
              params: {
                runId: run.id,
                ...targetRouteContext('artifacts'),
                recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                filter: artifactFilterParamForWorkspaceNav('review'),
              },
            })
          }
          onOpenArtifact={(artifactPath) =>
            openRunEvidenceArtifact(artifactPath, DECISION_EVIDENCE_RECIPE_RUN_PARAM)
          }
        />

        {run.slotId && !isTerminalRunStatus(run.status) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Worker Terminal</Text>
            <Pressable
              style={styles.terminalButton}
              onPress={() =>
                router.push({
                  pathname: '/terminal/[slotId]',
                  params: {
                    slotId: run.slotId!,
                    ...targetRouteContext('terminal'),
                    runId: run.id,
                    details: '1',
                    ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                    ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                  },
                })
              }
            >
              <Text style={styles.terminalButtonText}>Observe / reply to {run.slotId}</Text>
            </Pressable>
          </View>
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}

        {/* Metrics */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Metrics</Text>
          <View style={styles.metricsGrid}>
            <MetricItem label="Nudges" value={String(run.metrics?.nudgeCount ?? 0)} />
            <MetricItem label="Model" value={run.metrics?.model ?? '-'} />
            <MetricItem label="Runner" value={run.metrics?.runner ?? '-'} />
            <MetricItem label="Outcome" value={run.metrics?.outcome ?? '-'} />
          </View>
        </View>
      </Animated.ScrollView>
    </View>
  );
}

function PipelineStepCard({
  step,
  index,
  expanded,
  allowReplay,
  replaying,
  onToggle,
  onOpenArtifact,
  onReplayStep,
  onDiagnoseFailure,
}: {
  step: RunStep;
  index: number;
  expanded: boolean;
  allowReplay: boolean;
  replaying: boolean;
  onToggle: () => void;
  onOpenArtifact: (artifactPath: string) => void;
  onReplayStep: (skipPrepare?: boolean) => void;
  onDiagnoseFailure: () => void;
}) {
  const statusColor = stepStatusColor(step.status);
  const artifacts = collectStepArtifacts(step);
  return (
    <View style={[styles.stepCard, expanded && styles.stepCardExpanded]}>
      <Pressable onPress={onToggle}>
        <View style={styles.row}>
          <View style={styles.stepLeft}>
            <Text style={[styles.stepIcon, { color: statusColor }]}>{stepIcon(step.status)}</Text>
            <View style={styles.stepTitleWrap}>
              <Text style={styles.stepName} numberOfLines={1}>
                {index + 1}. {step.name}
              </Text>
              {step.detail && (
                <Text style={styles.stepDetailPreview} numberOfLines={expanded ? 3 : 1}>
                  {step.detail}
                </Text>
              )}
            </View>
          </View>
          <View style={styles.stepRight}>
            {step.durationMs != null && (
              <Text style={styles.stepDurationText}>{formatDuration(step.durationMs)}</Text>
            )}
            <Text style={styles.expandGlyph}>{expanded ? '⌃' : '⌄'}</Text>
          </View>
        </View>
      </Pressable>

      {expanded && (
        <View style={styles.stepExpandedBody}>
          {(allowReplay || replaying) && (
            <View style={styles.stepReplayPanel}>
              <View style={styles.stepReplayTextWrap}>
                <Text style={styles.stepReplayTitle}>Retry controls</Text>
                <Text style={styles.stepReplayHint}>
                  Replay this step and every following step on the run engine.
                </Text>
              </View>
              <View style={styles.stepReplayActions}>
                <Pressable
                  style={[styles.stepReplayButton, replaying && styles.stepReplayButtonDisabled]}
                  disabled={!allowReplay}
                  onPress={() => onReplayStep()}
                >
                  <Text style={styles.stepReplayButtonText}>
                    {replaying ? 'Retrying…' : 'Retry from here'}
                  </Text>
                </Pressable>
                {step.name === 'prepare' ? (
                  <Pressable
                    style={[
                      styles.stepReplayButton,
                      styles.stepReplayButtonSecondary,
                      replaying && styles.stepReplayButtonDisabled,
                    ]}
                    disabled={!allowReplay}
                    onPress={() => onReplayStep(true)}
                  >
                    <Text style={styles.stepReplayButtonText}>Warm retry</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          )}
          {step.status === 'failed' && (
            <View style={styles.stepDiagnosePanel}>
              <View style={styles.stepReplayTextWrap}>
                <Text style={styles.stepReplayTitle}>Failure diagnosis</Text>
                <Text style={styles.stepReplayHint}>
                  Ask gateway intelligence to inspect the failed step and propose read-only recovery
                  evidence first.
                </Text>
              </View>
              <Pressable style={styles.stepDiagnoseButton} onPress={onDiagnoseFailure}>
                <Text style={styles.stepDiagnoseButtonText}>Diagnose in Co-Pilot</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.stepMetaGrid}>
            <StepMeta label="Status" value={step.status} tone={statusColor} />
            <StepMeta label="Started" value={formatTimestamp(step.startedAt)} />
            <StepMeta label="Completed" value={formatTimestamp(step.completedAt)} />
            <StepMeta label="Duration" value={formatDuration(step.durationMs)} />
          </View>
          {artifacts.length > 0 && (
            <View style={styles.stepBlock}>
              <Text style={styles.stepBlockTitle}>Evidence files</Text>
              {artifacts.slice(0, 8).map((artifact) => (
                <Pressable
                  key={artifact}
                  style={styles.stepArtifactButton}
                  onPress={() => onOpenArtifact(artifact)}
                >
                  <Text style={styles.stepArtifact} numberOfLines={1}>
                    {artifact}
                  </Text>
                  <Text style={styles.stepArtifactOpen}>Open file</Text>
                </Pressable>
              ))}
            </View>
          )}
          {step.inputs && <JsonBlock title="Inputs" value={step.inputs} />}
          {step.outputs && <JsonBlock title="Outputs" value={step.outputs} />}
        </View>
      )}
    </View>
  );
}

function RunFocusedArtifactCard({
  artifactPath,
  recipeRunId,
  slotId,
  familyId,
  prNumber,
  recipeAvailable,
  diffAvailable,
  diffValue,
  comparePairCount,
  onOpenArtifact,
  onOpenFiles,
  onOpenRecipe,
  onOpenDiff,
  onOpenCompare,
  onOpenSlot,
  onOpenTerminal,
  onOpenFamily,
  onOpenPR,
}: {
  artifactPath: string;
  recipeRunId: string;
  slotId?: string | null;
  familyId?: string | null;
  prNumber?: number | null;
  recipeAvailable?: boolean;
  diffAvailable: boolean;
  diffValue: string;
  comparePairCount: number;
  onOpenArtifact: () => void;
  onOpenFiles: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenCompare: () => void;
  onOpenSlot: () => void;
  onOpenTerminal: () => void;
  onOpenFamily: () => void;
  onOpenPR: () => void;
}) {
  const isDiff = Boolean(diffArtifactCandidate([{ path: artifactPath }]));
  const artifactKind = runFocusedArtifactKindLabel(artifactPath);
  const recipeScoped = recipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const recipeScopeLabel = recipeWorkspaceScopeLabel(recipeRunId);
  return (
    <View style={styles.focusedArtifactCard}>
      <View style={styles.workspaceHeader}>
        <View style={styles.focusedArtifactTitleBlock}>
          <Text style={styles.focusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.focusedArtifactPath} numberOfLines={2}>
            {artifactPath}
          </Text>
          <Text style={styles.focusedArtifactMeta} numberOfLines={1}>
            {artifactKind} · {recipeScoped ? 'recipe context' : 'decision evidence'}
          </Text>
        </View>
        <Pressable
          style={styles.focusedArtifactPrimaryButton}
          onPress={isDiff ? onOpenDiff : onOpenArtifact}
        >
          <Text style={styles.focusedArtifactPrimaryText}>{isDiff ? 'Open diff' : 'Open'}</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cockpitRail}
      >
        <CockpitTile label="Files" value="context" onPress={onOpenFiles} />
        <CockpitTile
          label="Recipe files"
          value={recipeAvailable === false ? '-' : recipeScopeLabel}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <CockpitTile
          label="Diff"
          value={isDiff ? 'focused' : diffValue}
          onPress={onOpenDiff}
          disabled={!diffAvailable}
        />
        <CockpitTile
          label="Before→After"
          value={String(comparePairCount)}
          onPress={onOpenCompare}
          disabled={comparePairCount === 0}
        />
        <CockpitTile label="Slot" value={slotId ?? '-'} onPress={onOpenSlot} disabled={!slotId} />
        <CockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <CockpitTile
          label="Family"
          value={shortId(familyId)}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
        <CockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}

function runFocusedArtifactKindLabel(artifactPath: string): string {
  if (diffArtifactCandidate([{ path: artifactPath }])) return 'diff';
  const filter = artifactFilterParamForArtifactPath(artifactPath);
  if (filter === 'recipes') return 'recipe file';
  if (filter === 'visual') return 'visual evidence';
  return 'evidence file';
}

function RunReviewWorkspaceSummary({
  run,
  gates,
  gatewayUrl,
  artifactAuthHeaders,
  recipeArtifactCount,
  recipeAvailable,
  recipeRuns,
  selectedRecipeRunId,
  compareTarget,
  activeTaskProgress,
  taskProgressError,
  onOpenDecision,
  onOpenArtifacts,
  onOpenRecipeArtifact,
  onOpenRecipe,
  onOpenDiff,
  onOpenFamily,
  onOpenFamilyRetros,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
  onOpenCompareTarget,
}: {
  run: Run;
  gates: SlotWorkspaceGateSummary[];
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string | null;
  compareTarget: SlotCompareTarget | null;
  activeTaskProgress: TaskProgressStructured | null;
  taskProgressError?: string | null;
  onOpenDecision: (decisionId: string) => void;
  onOpenArtifacts: (artifactPath?: string) => void;
  onOpenRecipeArtifact: (artifactPath: string, recipeRunId: string | null) => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenFamily: () => void | undefined;
  onOpenFamilyRetros: () => void | undefined;
  onOpenTerminal: () => void | undefined;
  onOpenSlot: () => void | undefined;
  onOpenPR: () => void;
  onOpenCompareTarget: () => void;
}) {
  const manifest = extractRunArtifactManifest(run);
  const manifestCount = manifest.length;
  const fallbackTaskProgress =
    !activeTaskProgress && isWorkerProgressActive(run) ? fallbackTaskProgressSummary(run) : null;
  const gate = gates[0] ?? null;
  const retroSummary = summarizeSlotWorkspaceRetro(run);
  const previewArtifacts = gate ? selectSlotGatePreviewArtifacts(gate, manifest, 4) : [];
  const visualPairSummary = groupVisualArtifactPairs(manifest, (artifact) =>
    artifactUrlForEntry(gatewayUrl, run.id, artifact),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const runVisualPairCount = visualPairSummary.pairs.length;
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
  const openPriorityVisualArtifact = (artifactPath: string) => {
    if (!priorityVisualPairIsRecipe) {
      onOpenArtifacts(artifactPath);
      return;
    }
    onOpenRecipeArtifact(artifactPath, priorityRecipeRunId);
  };
  const openPriorityCompare = () => {
    if (primaryVisualPair) {
      onOpenArtifacts(primaryVisualPair.after.path);
      return;
    }
    if (recipePrimaryVisualPair) {
      onOpenRecipeArtifact(recipePrimaryVisualPair.after.path, priorityRecipeRunId);
    }
  };
  const workspaceVisualPairCount = compareTarget?.pairCount ?? runVisualPairCount;
  const tone =
    gate?.tone === 'ready'
      ? colors.statusOk
      : gate?.tone === 'warning'
        ? colors.statusWarn
        : colors.accent;
  const diffValue = runWorkspaceDiffValue(run, gate);
  const diffAvailable = hasRunWorkspaceDiff(run, gate);

  return (
    <View style={styles.workspaceCard}>
      <View style={styles.workspaceHeader}>
        <View style={[styles.workspaceBadge, { backgroundColor: tone + '22' }]}>
          <Text style={[styles.workspaceBadgeText, { color: tone }]}>
            {gate?.label ?? 'Run workspace'}
          </Text>
        </View>
        {gate ? (
          <Pressable
            style={styles.workspaceGateButton}
            onPress={() => onOpenDecision(gate.decision.id)}
          >
            <Text style={[styles.workspaceGateButtonText, { color: tone }]}>Open gate</Text>
          </Pressable>
        ) : (
          <Text style={styles.workspaceRunMeta} numberOfLines={1}>
            {run.slotId ?? 'no slot'} · {run.status}
          </Text>
        )}
      </View>
      <Text style={styles.workspaceTitle} numberOfLines={2}>
        {gate?.title ?? run.summary ?? run.ticketOrPr}
      </Text>
      <Text style={styles.workspaceSummary} numberOfLines={4}>
        {gate?.summary ??
          'No pending ready/review gate. Use artifacts, diff, family, and terminal shortcuts to inspect this run.'}
      </Text>

      {gate?.artifactPaths.length ? (
        <>
          <View style={styles.workspaceEvidenceRow}>
            {gate.artifactPaths.slice(0, 4).map((artifactPath) => (
              <Pressable
                key={artifactPath}
                style={styles.workspaceEvidenceChip}
                onPress={() => onOpenArtifacts(artifactPath)}
              >
                <Text style={styles.workspaceEvidenceChipText} numberOfLines={1}>
                  {artifactPath.split('/').pop() ?? artifactPath}
                </Text>
              </Pressable>
            ))}
            {gate.artifactPaths.length > 4 ? (
              <Pressable style={styles.workspaceEvidenceChip} onPress={() => onOpenArtifacts()}>
                <Text style={styles.workspaceEvidenceChipText}>
                  +{gate.artifactPaths.length - 4} more
                </Text>
              </Pressable>
            ) : null}
          </View>
          {previewArtifacts.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.workspacePreviewStrip}
            >
              {previewArtifacts.map((artifact) => {
                const mediaType = classifyArtifact(artifact);
                return (
                  <Pressable
                    key={artifact.path}
                    style={styles.workspacePreviewButton}
                    onPress={() => onOpenArtifacts(artifact.path)}
                  >
                    {mediaType === 'image' ? (
                      <Image
                        source={artifactSource(
                          artifactUrlForEntry(gatewayUrl, run.id, artifact),
                          artifactAuthHeaders,
                        )}
                        style={styles.workspacePreviewImage}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={styles.workspacePreviewDocumentTile}>
                        <Text style={styles.workspacePreviewDocumentKind}>
                          {mediaType.toUpperCase()}
                        </Text>
                        <Text style={styles.workspacePreviewDocumentPath} numberOfLines={2}>
                          {artifact.path.split('/').pop() ?? artifact.path}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}
        </>
      ) : null}

      {priorityVisualPair ? (
        <RunBeforeAfterPriorityPanel
          pair={priorityVisualPair}
          pairCount={primaryVisualPair ? runVisualPairCount : recipeVisualPairSummary.pairs.length}
          authHeaders={artifactAuthHeaders}
          eyebrow={priorityVisualPairIsRecipe ? 'Recipe evidence' : 'Review first'}
          title={
            priorityVisualPairIsRecipe ? 'Recipe before → after' : 'Run before → after evidence'
          }
          copy={
            priorityVisualPairIsRecipe
              ? 'Recipe evidence has the clearest visible delta for this run.'
              : 'Confirm the visible change before using retry, review, or recipe controls.'
          }
          onOpenArtifact={openPriorityVisualArtifact}
          onOpenCompare={openPriorityCompare}
          onOpenArtifacts={() => onOpenArtifacts()}
          onOpenRecipe={onOpenRecipe}
          onOpenDiff={onOpenDiff}
          onOpenSlot={onOpenSlot}
          onOpenTerminal={onOpenTerminal}
          artifactCount={manifestCount}
          recipeArtifactCount={recipeArtifactCount}
          recipeAvailable={recipeAvailable}
          diffValue={diffValue}
          slotId={run.slotId}
        />
      ) : null}

      {gates.length > 1 ? (
        <RunWorkspaceGateRail
          gates={gates}
          runId={run.id}
          artifactManifest={manifest}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          compareTarget={compareTarget}
          compareFallbackPair={primaryVisualPair ?? recipePrimaryVisualPair}
          compareFallbackPairIsRecipe={!primaryVisualPair && Boolean(recipePrimaryVisualPair)}
          onOpenDecision={onOpenDecision}
          onOpenArtifacts={onOpenArtifacts}
          onOpenCompareTarget={onOpenCompareTarget}
          onOpenCompareFallbackArtifact={(artifactPath) => {
            if (primaryVisualPair) {
              onOpenArtifacts(artifactPath);
              return;
            }
            onOpenRecipeArtifact(artifactPath, priorityRecipeRunId);
          }}
          onOpenDiff={onOpenDiff}
        />
      ) : null}

      <RunWorkspaceCockpit
        diffValue={diffValue}
        diffAvailable={diffAvailable}
        manifestCount={manifestCount}
        recipeArtifactCount={recipeArtifactCount}
        recipeAvailable={recipeAvailable}
        recipeScopeLabel={recipeWorkspaceScopeLabel(selectedRecipeRunId)}
        familyId={run.familyId}
        gateCount={gates.length}
        readyGate={gates.find((workspaceGate) => workspaceGate.label === 'Ready workspace') ?? null}
        reviewGate={
          gates.find(
            (workspaceGate) =>
              workspaceGate.label === 'Review workspace' ||
              workspaceGate.label === 'No-change review',
          ) ?? null
        }
        retroSummary={retroSummary}
        visualPairCount={workspaceVisualPairCount}
        pendingCount={(run.decisions ?? []).filter((decision) => !decision.resolvedAt).length}
        activeTaskProgress={activeTaskProgress}
        fallbackTaskProgress={fallbackTaskProgress}
        run={run}
        terminalAvailable={Boolean(run.slotId)}
        slotId={run.slotId}
        prNumber={run.prNumber}
        onOpenTerminal={onOpenTerminal}
        onOpenSlot={onOpenSlot}
        onOpenPR={onOpenPR}
        onOpenArtifacts={() => onOpenArtifacts()}
        onOpenCompare={onOpenCompareTarget}
        onOpenRecipe={onOpenRecipe}
        onOpenDiff={onOpenDiff}
        onOpenFamily={onOpenFamily}
        onOpenFamilyRetros={onOpenFamilyRetros}
        onOpenGate={(workspaceGate) => onOpenDecision(workspaceGate.decision.id)}
        onOpenRetro={(retro) => onOpenDecision(retro.decision.id)}
      />

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

      {gate?.metrics.length ? (
        <View style={styles.workspaceSignalRow}>
          {gate.metrics.map((metric) => {
            const target = workspaceSignalTargetForDecisionLabel(metric.label);
            const content = (
              <>
                <Text style={styles.workspaceSignalLabel}>{metric.label}</Text>
                <Text style={styles.workspaceSignalValue} numberOfLines={1}>
                  {metric.value}
                  {target ? ' ›' : ''}
                </Text>
              </>
            );
            return target ? (
              <Pressable
                key={`${metric.label}:${metric.value}`}
                style={styles.workspaceSignalChip}
                onPress={
                  target === 'diff'
                    ? onOpenDiff
                    : target === 'compare'
                      ? onOpenCompareTarget
                      : () => onOpenArtifacts()
                }
              >
                {content}
              </Pressable>
            ) : (
              <View key={`${metric.label}:${metric.value}`} style={styles.workspaceSignalChip}>
                {content}
              </View>
            );
          })}
        </View>
      ) : null}

      {selectedRecipeRunId ? (
        <Text style={styles.workspaceRecipeContext} numberOfLines={1}>
          Recipe context: {selectedRecipeRunId}
        </Text>
      ) : null}
    </View>
  );
}

function RunWorkspaceGateRail({
  gates,
  runId,
  artifactManifest,
  gatewayUrl,
  artifactAuthHeaders,
  compareTarget,
  compareFallbackPair,
  compareFallbackPairIsRecipe,
  onOpenDecision,
  onOpenArtifacts,
  onOpenCompareTarget,
  onOpenCompareFallbackArtifact,
  onOpenDiff,
}: {
  gates: SlotWorkspaceGateSummary[];
  runId: string;
  artifactManifest: ArtifactManifestEntry[];
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  compareTarget: SlotCompareTarget | null;
  compareFallbackPair: VisualArtifactPair | null;
  compareFallbackPairIsRecipe: boolean;
  onOpenDecision: (decisionId: string) => void;
  onOpenArtifacts: (artifactPath?: string) => void;
  onOpenCompareTarget: () => void;
  onOpenCompareFallbackArtifact: (artifactPath: string) => void;
  onOpenDiff: () => void;
}) {
  return (
    <View style={styles.workspaceGateRailPanel}>
      <View style={styles.workspaceGateRailHeader}>
        <Text style={styles.workspaceGateRailTitle}>Ready / review gates</Text>
        <Text style={styles.workspaceGateRailMeta}>
          {gates.filter((gate) => !gate.resolved).length} pending / {gates.length}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceGateRail}
      >
        {gates.map((gate) => {
          const tone = workspaceGateToneColor(gate);
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
          const diffValue = workspaceGateDiffMetricValue(gate);
          const diffAvailable = isActionableWorkspaceDiffValue(diffValue);
          const openPrimaryEvidence = () => onOpenArtifacts(gate.primaryArtifactPath ?? undefined);
          return (
            <View
              key={gate.decision.id}
              style={[styles.workspaceGateRailCard, { borderColor: tone + '66' }]}
            >
              <Pressable onPress={() => onOpenDecision(gate.decision.id)}>
                <View style={styles.workspaceGateRailCardHeader}>
                  <Text style={[styles.workspaceGateRailLabel, { color: tone }]}>{gate.label}</Text>
                  <Text style={styles.workspaceGateRailStatus}>
                    {gate.resolved ? 'resolved' : 'pending'}
                  </Text>
                </View>
                <Text style={styles.workspaceGateRailCardTitle} numberOfLines={2}>
                  {gate.title}
                </Text>
              </Pressable>
              <View style={styles.workspaceGateRailActions}>
                <RunGateAction
                  label="Gate"
                  value={gate.resolved ? 'resolved' : 'pending'}
                  onPress={() => onOpenDecision(gate.decision.id)}
                />
                <RunGateAction
                  label="Evidence"
                  value={String(gate.artifactPaths.length)}
                  onPress={openPrimaryEvidence}
                  disabled={gate.artifactPaths.length === 0}
                />
                <RunGateAction
                  label="Before→After"
                  value={String(comparePairCount)}
                  onPress={() => {
                    if (primaryVisualPair) onOpenArtifacts(primaryVisualPair.after.path);
                    else onOpenCompareTarget();
                  }}
                  disabled={comparePairCount === 0}
                />
                <RunGateAction
                  label="Diff"
                  value={diffValue ?? '-'}
                  onPress={onOpenDiff}
                  disabled={!diffAvailable}
                />
              </View>
              <View style={styles.workspaceGateRailMetrics}>
                {gate.metrics.slice(0, 2).map((metric) => (
                  <Text
                    key={`${gate.decision.id}:${metric.label}`}
                    style={styles.workspaceGateRailMetric}
                    numberOfLines={1}
                  >
                    {metric.label}: {metric.value}
                  </Text>
                ))}
              </View>
              {primaryVisualPair ? (
                <BeforeAfterPreview
                  pair={primaryVisualPair}
                  authHeaders={artifactAuthHeaders}
                  onOpenArtifact={onOpenArtifacts}
                  eyebrow={gate.label}
                  title="Gate before → after"
                  hint="Tap to inspect"
                  imageHeight={58}
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
                  imageHeight={58}
                />
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function RunGateAction({
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
      style={[styles.workspaceGateRailAction, disabled && styles.cockpitTileDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.workspaceGateRailActionLabel}>{label}</Text>
      <Text style={styles.workspaceGateRailActionValue} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

function RunBeforeAfterPriorityPanel({
  pair,
  pairCount,
  authHeaders,
  artifactCount,
  recipeArtifactCount,
  recipeAvailable,
  diffValue,
  slotId,
  eyebrow = 'Review first',
  title = 'Run before → after evidence',
  copy = 'Confirm the visible change before using retry, review, or recipe controls.',
  onOpenArtifact,
  onOpenCompare,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenDiff,
  onOpenSlot,
  onOpenTerminal,
}: {
  pair: VisualArtifactPair;
  pairCount: number;
  authHeaders: ArtifactHttpHeaders;
  artifactCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffValue: string;
  slotId?: string | null;
  eyebrow?: string;
  title?: string;
  copy?: string;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenCompare: () => void;
  onOpenArtifacts: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenSlot: () => void | undefined;
  onOpenTerminal: () => void | undefined;
}) {
  return (
    <View style={styles.runBeforeAfterPriorityPanel}>
      <BeforeAfterPreview
        pair={pair}
        authHeaders={authHeaders}
        onOpenArtifact={onOpenArtifact}
        eyebrow={eyebrow}
        title={title}
        hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
        imageHeight={88}
      />
      <View style={styles.runBeforeAfterPriorityActions}>
        <Text style={styles.runBeforeAfterPriorityCopy}>{copy}</Text>
        <Pressable style={styles.runBeforeAfterPriorityButton} onPress={onOpenCompare}>
          <Text style={styles.runBeforeAfterPriorityButtonText}>Compare evidence</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.runBeforeAfterPriorityRail}
      >
        <CockpitTile label="Evidence" value={String(artifactCount)} onPress={onOpenArtifacts} />
        <CockpitTile
          label="Recipe"
          value={
            recipeArtifactCount === null
              ? 'loading'
              : recipeAvailable
                ? String(recipeArtifactCount)
                : '-'
          }
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <CockpitTile label="Diff" value={diffValue} onPress={onOpenDiff} />
        <CockpitTile label="Slot" value={slotId ?? '-'} onPress={onOpenSlot} disabled={!slotId} />
        <CockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
      </ScrollView>
    </View>
  );
}

function workspaceGateToneColor(gate: SlotWorkspaceGateSummary): string {
  if (gate.tone === 'ready') return colors.statusOk;
  if (gate.tone === 'warning') return colors.statusWarn;
  return colors.accent;
}

function RunWorkspaceCockpit({
  diffValue,
  diffAvailable,
  manifestCount,
  recipeArtifactCount,
  recipeAvailable,
  recipeScopeLabel,
  familyId,
  gateCount,
  readyGate,
  reviewGate,
  retroSummary,
  visualPairCount,
  pendingCount,
  activeTaskProgress,
  fallbackTaskProgress,
  run,
  terminalAvailable,
  slotId,
  prNumber,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
  onOpenArtifacts,
  onOpenCompare,
  onOpenRecipe,
  onOpenDiff,
  onOpenFamily,
  onOpenFamilyRetros,
  onOpenGate,
  onOpenRetro,
}: {
  diffValue: string;
  diffAvailable: boolean;
  manifestCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  recipeScopeLabel: ReturnType<typeof recipeWorkspaceScopeLabel>;
  familyId: string | null | undefined;
  gateCount: number;
  readyGate: SlotWorkspaceGateSummary | null;
  reviewGate: SlotWorkspaceGateSummary | null;
  retroSummary: SlotWorkspaceRetroSummary | null;
  visualPairCount: number;
  pendingCount: number;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  run: Run;
  terminalAvailable: boolean;
  slotId: string | null | undefined;
  prNumber: number | null | undefined;
  onOpenTerminal: () => void | undefined;
  onOpenSlot: () => void | undefined;
  onOpenPR: () => void;
  onOpenArtifacts: () => void;
  onOpenCompare: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenFamily: () => void | undefined;
  onOpenFamilyRetros: () => void | undefined;
  onOpenGate: (gate: SlotWorkspaceGateSummary) => void;
  onOpenRetro: (retro: SlotWorkspaceRetroSummary) => void;
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
        <Pressable
          style={[styles.cockpitTerminalButton, !terminalAvailable && styles.cockpitTileDisabled]}
          onPress={onOpenTerminal}
          disabled={!terminalAvailable}
        >
          <Text style={styles.cockpitTerminalText}>Terminal</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cockpitRail}
      >
        <CockpitTile label="Slot" value={slotId ?? '-'} onPress={onOpenSlot} disabled={!slotId} />
        <CockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
        <CockpitTile
          label="Ready"
          value={readyGate ? runGateStateLabel(readyGate) : '-'}
          hint={readyGate ? runGateCockpitHint(readyGate) : undefined}
          onPress={() => {
            if (readyGate) onOpenGate(readyGate);
          }}
          disabled={!readyGate}
        />
        <CockpitTile
          label="Review gate"
          value={reviewGate ? runGateStateLabel(reviewGate) : '-'}
          hint={reviewGate ? runGateCockpitHint(reviewGate) : undefined}
          onPress={() => {
            if (reviewGate) onOpenGate(reviewGate);
          }}
          disabled={!reviewGate}
        />
        <CockpitTile
          label="Retro gate"
          value={retroSummary?.statusLabel ?? '-'}
          hint={retroSummary ? runRetroCockpitHint(retroSummary) : undefined}
          onPress={() => {
            if (retroSummary) onOpenRetro(retroSummary);
          }}
          disabled={!retroSummary}
        />
        <CockpitTile
          label="Family retros"
          value={familyId ? 'open' : '-'}
          onPress={onOpenFamilyRetros}
          disabled={!familyId}
        />
        <CockpitTile
          label="Progress"
          value={progressValue}
          onPress={onOpenTerminal}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
          hint={progressMeta}
        />
        <CockpitTile
          label="Artifact files"
          value={String(manifestCount)}
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
          value={
            recipeArtifactCount === null
              ? 'loading'
              : recipeAvailable
                ? String(recipeArtifactCount)
                : '-'
          }
          hint={recipeAvailable ? `${recipeScopeLabel} recipe scope` : undefined}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <CockpitTile
          label="Diff view"
          value={diffAvailable ? diffValue : slotId ? 'workspace' : 'no diff'}
          onPress={onOpenDiff}
          disabled={!diffAvailable && !slotId}
        />
        <CockpitTile
          label="Family"
          value={shortId(familyId)}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
      </ScrollView>
    </View>
  );
}

function runGateStateLabel(gate: SlotWorkspaceGateSummary): string {
  if (!gate.resolved) return 'pending';
  if (gate.tone === 'ready') return 'ready';
  if (gate.tone === 'warning') return 'warning';
  return 'resolved';
}

function runGateCockpitHint(gate: SlotWorkspaceGateSummary): string {
  const diffValue = workspaceGateDiffMetricValue(gate);
  const artifactLabel = `${gate.artifactPaths.length} file${
    gate.artifactPaths.length === 1 ? '' : 's'
  }`;
  return diffValue ? `${artifactLabel} · ${diffValue}` : artifactLabel;
}

function runRetroCockpitHint(retro: SlotWorkspaceRetroSummary): string {
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
  onPress: () => void | undefined;
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

function StepMeta({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.stepMetaItem}>
      <Text style={styles.stepMetaLabel}>{label}</Text>
      <Text style={[styles.stepMetaValue, tone ? { color: tone } : undefined]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function JsonBlock({ title, value }: { title: string; value: Record<string, unknown> }) {
  const body = JSON.stringify(value, null, 2);
  return (
    <View style={styles.stepBlock}>
      <Text style={styles.stepBlockTitle}>{title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.stepJson}>{body}</Text>
      </ScrollView>
    </View>
  );
}

function stepIcon(status: RunStep['status']): string {
  if (status === 'done') return '✓';
  if (status === 'running') return '▶';
  if (status === 'failed') return '✗';
  if (status === 'skipped') return '↷';
  return '○';
}

function stepStatusColor(status: RunStep['status']): string {
  if (status === 'done') return colors.statusOk;
  if (status === 'running') return colors.statusWarn;
  if (status === 'failed') return colors.statusFail;
  if (status === 'skipped') return colors.textMuted;
  return colors.accent;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString();
}

function collectStepArtifacts(step: RunStep): string[] {
  const artifacts = new Set<string>();
  collectArtifactStrings(step.outputs, artifacts);
  return [...artifacts];
}

const STEP_ARTIFACT_PREVIEW_LIMIT = 24;

function collectArtifactStrings(value: unknown, artifacts: Set<string>) {
  // Preview cap keeps deeply nested step outputs bounded; add an expand affordance
  // if real step outputs routinely exceed this limit.
  if (!value || artifacts.size >= STEP_ARTIFACT_PREVIEW_LIMIT) return;
  if (typeof value === 'string') {
    if (
      /(\.png|\.jpe?g|\.webp|\.gif|\.mp4|\.mov|\.webm|\.md|\.json|\.txt|\.diff|\.patch)$/i.test(
        value,
      )
    ) {
      artifacts.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectArtifactStrings(item, artifacts));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectArtifactStrings(item, artifacts));
  }
}

function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}

function routeParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
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

function DecisionSummaryCard({
  presentation,
  resolvedAction,
  resolvedAt,
  onPress,
  onOpenArtifacts,
  onOpenDiff,
  onOpenCompare,
}: {
  presentation: DecisionPresentation;
  resolvedAction?: string;
  resolvedAt?: string;
  onPress: () => void;
  onOpenArtifacts: () => void;
  onOpenDiff: () => void;
  onOpenCompare: (artifactPath?: string) => void;
}) {
  const resolved = Boolean(resolvedAt);
  const tone = TONE_COLORS[resolved ? 'ok' : presentation.tone];
  const reviewLabel = presentation.kind === 'retrospective' ? 'Open retro' : 'Open review';
  const summary = presentation.summary || presentation.description;
  const statusText = resolved
    ? `Action: ${resolvedAction ?? 'resolved'}`
    : presentation.kind === 'retrospective'
      ? 'Pending retrospective review'
      : 'Pending operator review';
  const visualPairSummary = groupVisualArtifactPairs(
    presentation.artifactManifest,
    (artifact) => artifact.path,
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;

  return (
    <Pressable style={[styles.decisionCard, { borderLeftColor: tone }]} onPress={onPress}>
      <View style={styles.row}>
        <View style={[styles.decisionTypeBadge, { backgroundColor: tone + '22' }]}>
          <Text style={[styles.decisionTypeText, { color: tone }]}>
            {resolved ? 'Resolved' : presentation.kindLabel}
          </Text>
        </View>
        <Text style={styles.decisionOpenText}>{reviewLabel}</Text>
      </View>
      <Text style={styles.decisionTitle}>{presentation.title}</Text>
      <Text style={styles.decisionSummaryText} numberOfLines={3}>
        {summary}
      </Text>
      {presentation.highlights.length > 0 ? (
        <View style={styles.decisionSignalRow}>
          {presentation.highlights.slice(0, 4).map((item) => {
            const signalTone = TONE_COLORS[item.tone ?? 'info'];
            const target = workspaceSignalTargetForDecisionLabel(item.label);
            const content = (
              <>
                <Text style={[styles.decisionSignalLabel, { color: signalTone }]}>
                  {item.label}
                </Text>
                <Text style={styles.decisionSignalValue} numberOfLines={1}>
                  {item.value}
                  {target ? ' ›' : ''}
                </Text>
              </>
            );
            return target ? (
              <Pressable
                key={`${presentation.id}:${item.label}:${item.value}`}
                style={[styles.decisionSignalChip, { borderColor: signalTone + '66' }]}
                onPress={
                  target === 'diff'
                    ? onOpenDiff
                    : target === 'compare'
                      ? () => onOpenCompare(primaryVisualPair?.after.path)
                      : onOpenArtifacts
                }
              >
                {content}
              </Pressable>
            ) : (
              <View
                key={`${presentation.id}:${item.label}:${item.value}`}
                style={[styles.decisionSignalChip, { borderColor: signalTone + '66' }]}
              >
                {content}
              </View>
            );
          })}
        </View>
      ) : null}
      <Text style={baseStyles.textMuted}>{statusText}</Text>
    </Pressable>
  );
}

function RecipeRunsSection({
  run,
  client,
  gatewayUrl,
  artifactAuthHeaders,
  recipeRuns,
  selectedRecipeRunId,
  onSelectRecipeRun,
  onViewArtifacts,
  onOpenRecipeArtifact,
  onRecipeComplete,
}: {
  run: Run;
  client: GatewayClient | null;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string | null;
  onSelectRecipeRun: (id: string | null) => void;
  onViewArtifacts: (recipeRunId: string) => void;
  onOpenRecipeArtifact: (
    recipeRunId: string,
    artifactPath: string,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => void;
  onRecipeComplete: (requestId: string) => void;
}) {
  if (recipeRuns.length === 0) return null;
  const selected = recipeRuns.find((group) => group.id === selectedRecipeRunId);
  const previewGroup = selected ?? recipeRuns.find((group) => group.promoted) ?? recipeRuns[0];
  if (!previewGroup) return null;
  const artifacts = artifactsForRecipeRun(previewGroup);
  const previewArtifacts = artifacts.slice(0, 4);
  const visualPairSummary = groupVisualArtifactPairs(artifacts, (artifact) =>
    artifactUrlForEntry(gatewayUrl, run.id, artifact),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  // Recipe replay APIs resolve selected recipe roots by RecipeRunArtifactGroup.id,
  // matching the desktop helper. Current task artifacts omit recipeRunId; live
  // and promoted evidence groups intentionally pass ids such as "live-run:<id>".
  const selectedRecipeRunRequestId =
    previewGroup.groupKind === 'current-artifacts' ? null : previewGroup.id;
  const totalArtifactCount = recipeRuns.reduce(
    (sum, group) => sum + artifactsForRecipeRun(group).length,
    0,
  );
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.sectionTitle}>Recipe evidence</Text>
        <Text style={styles.recipeSummary}>
          {recipeRuns.length} run{recipeRuns.length === 1 ? '' : 's'} · {totalArtifactCount}{' '}
          artifact{totalArtifactCount === 1 ? '' : 's'}
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.recipeRunStrip}>
        {recipeRuns.map((group) => (
          <Pressable
            key={group.id}
            style={[styles.recipeRunCard, selected?.id === group.id && styles.recipeRunCardActive]}
            onPress={() => onSelectRecipeRun(group.id)}
          >
            <Text
              style={[
                styles.recipeRunLabel,
                selected?.id === group.id && styles.recipeRunLabelActive,
              ]}
              numberOfLines={1}
            >
              {group.label}
            </Text>
            <Text style={styles.recipeRunMeta}>
              {group.status} · {group.artifactManifest?.length ?? 0} artifact
              {(group.artifactManifest?.length ?? 0) === 1 ? '' : 's'}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {previewArtifacts.length > 0 ? (
        <View style={styles.thumbStrip}>
          {previewArtifacts.map((artifact) => {
            const mediaType = classifyArtifact(artifact);
            const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
            return (
              <Pressable
                key={`${previewGroup.id}:${artifact.path}`}
                style={mediaType === 'image' ? undefined : styles.recipeArtifactTile}
                onPress={() => onOpenRecipeArtifact(previewGroup.id, artifact.path)}
              >
                {mediaType === 'image' ? (
                  <Image
                    source={artifactSource(
                      artifactUrlForEntry(gatewayUrl, run.id, artifact),
                      artifactAuthHeaders,
                    )}
                    style={styles.artifactThumb}
                    resizeMode="cover"
                  />
                ) : (
                  <>
                    <Text style={styles.recipeArtifactTileKind}>
                      {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
                    </Text>
                    <Text style={styles.recipeArtifactTilePath} numberOfLines={2}>
                      {artifact.path.split('/').pop() ?? artifact.path}
                    </Text>
                  </>
                )}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {primaryVisualPair ? (
        <View style={styles.recipePairPreview}>
          <BeforeAfterPreview
            pair={primaryVisualPair}
            authHeaders={artifactAuthHeaders}
            onOpenArtifact={(artifactPath) => {
              const target = [primaryVisualPair.before, primaryVisualPair.after].find(
                (artifact) => artifact.path === artifactPath,
              );
              onOpenRecipeArtifact(
                target?.recipeRunId ?? previewGroup.id,
                artifactPath,
                artifactFilterParamForWorkspaceNav('compare'),
              );
            }}
            title="Recipe before → after"
            hint="Tap to inspect"
            imageHeight={74}
          />
        </View>
      ) : null}
      {!selected ? (
        <Text style={styles.recipeContextHint}>
          Decision evidence is selected. Pick a recipe run or open the current recipe artifacts.
        </Text>
      ) : null}
      <Pressable
        style={styles.viewAllButton}
        onPress={() => onViewArtifacts(selected?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM)}
      >
        <Text style={styles.viewAllText}>Open recipe artifacts</Text>
      </Pressable>
      <View style={styles.recipeControlsWrap}>
        <RecipeRunControls
          client={client}
          runId={run.id}
          slotId={run.slotId}
          recipeRunId={selectedRecipeRunRequestId}
          onComplete={onRecipeComplete}
        />
      </View>
    </View>
  );
}

function ArtifactsSection({
  run,
  gatewayUrl,
  artifactAuthHeaders,
  onViewAll,
  onOpenArtifact,
}: {
  run: Run;
  gatewayUrl: string;
  artifactAuthHeaders: ArtifactHttpHeaders;
  onViewAll: () => void;
  onOpenArtifact: (artifactPath: string) => void;
}) {
  const manifest = extractRunArtifactManifest(run);
  if (manifest.length === 0) return null;

  const images = manifest.filter((artifact) => classifyArtifact(artifact) === 'image');

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.sectionTitle}>Evidence files</Text>
        <View style={styles.artifactCountBadge}>
          <Text style={styles.artifactCountText}>{manifest.length}</Text>
        </View>
      </View>
      {images.length > 0 && (
        <View style={styles.thumbStrip}>
          {images.slice(0, 4).map((a) => (
            <Pressable key={a.path} onPress={() => onOpenArtifact(a.path)}>
              <Image
                source={artifactSource(
                  artifactUrl(gatewayUrl, run.id, a.path),
                  artifactAuthHeaders,
                )}
                style={styles.artifactThumb}
                resizeMode="cover"
              />
            </Pressable>
          ))}
        </View>
      )}
      <Pressable style={styles.viewAllButton} onPress={onViewAll}>
        <Text style={styles.viewAllText}>View evidence files</Text>
      </Pressable>
    </View>
  );
}

function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricItem}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center' },
  backFallbackButton: {
    backgroundColor: colors.accent + '20',
    borderRadius: radii.md,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  backFallbackText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
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
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  flowBadge: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: 4 },
  flowText: { fontSize: fonts.sizeSm, fontWeight: '600' },
  statusBadge: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: 4 },
  statusText: { fontSize: fonts.sizeSm, fontWeight: '600' },
  ticketText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '700',
    marginTop: spacing.lg,
  },
  section: { marginBottom: spacing.xl },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
  },
  workspaceCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    marginBottom: spacing.xl,
    padding: spacing.lg,
  },
  focusedArtifactCard: {
    backgroundColor: colors.accent + '12',
    borderColor: colors.accent + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.xl,
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
  focusedArtifactPrimaryButton: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  focusedArtifactPrimaryText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  workspaceHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
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
  workspaceRunMeta: {
    color: colors.textMuted,
    flex: 1,
    fontSize: fonts.sizeXs,
    textAlign: 'right',
    textTransform: 'uppercase',
  },
  workspaceGateButton: {
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  workspaceGateButtonText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  workspaceTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
  workspaceSummary: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 20,
  },
  runBeforeAfterPriorityPanel: {
    backgroundColor: colors.accent + '10',
    borderColor: colors.accent + '44',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  runBeforeAfterPriorityActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  runBeforeAfterPriorityCopy: {
    color: colors.textMuted,
    flex: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  runBeforeAfterPriorityButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  runBeforeAfterPriorityButtonText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  runBeforeAfterPriorityRail: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  workspaceSignalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  workspaceSignalChip: {
    backgroundColor: colors.accent + '12',
    borderColor: colors.accent + '33',
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  workspaceSignalLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  workspaceSignalValue: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: 2,
    maxWidth: 120,
  },
  workspaceEvidenceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  workspaceEvidenceChip: {
    backgroundColor: colors.accent + '12',
    borderColor: colors.accent + '44',
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 160,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  workspaceEvidenceChipText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  workspacePreviewStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  workspacePreviewButton: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  workspacePreviewImage: {
    backgroundColor: colors.bgInput,
    height: 64,
    width: 88,
  },
  workspacePreviewDocumentTile: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    gap: spacing.xs,
    height: 64,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    width: 96,
  },
  workspacePreviewDocumentKind: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  workspacePreviewDocumentPath: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 14,
    textAlign: 'center',
  },
  workspaceGateRailPanel: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  workspaceGateRailHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  workspaceGateRailTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceGateRailMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  workspaceGateRail: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  workspaceGateRailCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    minWidth: 184,
    padding: spacing.md,
  },
  workspaceGateRailCardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  workspaceGateRailLabel: {
    flex: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceGateRailStatus: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  workspaceGateRailCardTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    lineHeight: 16,
  },
  workspaceGateRailMetrics: {
    gap: 2,
  },
  workspaceGateRailMetric: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  workspaceGateRailActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  workspaceGateRailAction: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.sm,
    borderWidth: 1,
    minWidth: 72,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  workspaceGateRailActionLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceGateRailActionValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: 1,
  },
  cockpitPanel: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '30',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  cockpitHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  cockpitTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
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
    paddingVertical: spacing.sm,
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
    minWidth: 116,
    padding: spacing.md,
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
    marginTop: spacing.xs,
  },
  cockpitTileHint: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 2,
    maxWidth: 110,
  },
  workspaceRecipeContext: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  stepCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  stepCardExpanded: {
    borderWidth: 1,
    borderColor: colors.accent + '55',
  },
  stepLeft: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: spacing.md, minWidth: 0 },
  stepIcon: { fontSize: fonts.sizeMd, width: 20 },
  stepTitleWrap: { flex: 1, minWidth: 0 },
  stepName: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '700' },
  stepDetailPreview: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  stepRight: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: spacing.xs,
    marginLeft: spacing.sm,
  },
  stepDurationText: { color: colors.textMuted, fontSize: fonts.sizeSm },
  expandGlyph: {
    color: colors.accent,
    fontSize: fonts.sizeLg,
    fontWeight: '800',
  },
  stepExpandedBody: {
    borderTopWidth: 1,
    borderTopColor: colors.bgInput,
    gap: spacing.md,
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
  },
  stepReplayPanel: {
    backgroundColor: colors.statusWarn + '12',
    borderColor: colors.statusWarn + '44',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  stepReplayTextWrap: {
    gap: spacing.xs,
  },
  stepReplayTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  stepReplayHint: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
  },
  stepReplayActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  stepReplayButton: {
    backgroundColor: colors.statusWarn + '22',
    borderColor: colors.statusWarn + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  stepReplayButtonSecondary: {
    backgroundColor: colors.bgInput,
  },
  stepReplayButtonDisabled: {
    opacity: 0.45,
  },
  stepReplayButtonText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  stepDiagnosePanel: {
    backgroundColor: colors.accent + '12',
    borderColor: colors.accent + '44',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  stepDiagnoseButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  stepDiagnoseButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  stepMetaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  stepMetaItem: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    padding: spacing.md,
    width: '47%',
  },
  stepMetaLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  stepMetaValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  stepBlock: {
    gap: spacing.sm,
  },
  stepBlockTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  stepArtifactButton: {
    alignItems: 'center',
    backgroundColor: colors.accent + '18',
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  stepArtifact: {
    color: colors.accent,
    flex: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  stepArtifactOpen: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  stepJson: {
    color: colors.textSecondary,
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeXs,
    lineHeight: 16,
    padding: spacing.md,
  },
  decisionCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  decisionTypeBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  decisionTypeText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  decisionOpenText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  decisionTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  decisionSummaryText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 19,
  },
  decisionSignalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  decisionSignalChip: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    borderWidth: 1,
    maxWidth: '48%',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  decisionSignalLabel: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  decisionSignalValue: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: 2,
  },
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  metricItem: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.lg,
    minWidth: 100,
    alignItems: 'center',
  },
  metricLabel: { color: colors.textMuted, fontSize: fonts.sizeXs, marginBottom: spacing.xs },
  metricValue: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '600' },
  artifactCountBadge: {
    backgroundColor: colors.accent + '30',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 4,
  },
  artifactCountText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '600',
  },
  recipeSummary: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  recipeRunStrip: {
    marginBottom: spacing.md,
  },
  recipeRunCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    marginRight: spacing.sm,
    minWidth: 150,
    padding: spacing.md,
  },
  recipeRunCardActive: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent,
  },
  recipeRunLabel: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  recipeRunLabelActive: {
    color: colors.accent,
  },
  recipeRunMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  recipeContextHint: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
    marginBottom: spacing.md,
  },
  recipePairPreview: {
    marginBottom: spacing.md,
  },
  thumbStrip: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  artifactThumb: {
    width: 64,
    height: 48,
    borderRadius: radii.sm,
    backgroundColor: colors.bgInput,
  },
  recipeArtifactTile: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.sm,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    width: 78,
  },
  recipeArtifactTileKind: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  recipeArtifactTilePath: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: 2,
    textAlign: 'center',
  },
  viewAllButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.accent + '20',
    borderRadius: radii.sm,
  },
  viewAllText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
  },
  recipeControlsWrap: {
    marginTop: spacing.md,
  },
  terminalButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.accent + '20',
    borderRadius: radii.md,
  },
  terminalButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  errorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
    marginBottom: spacing.xl,
  },
});
