import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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
  type DecisionListResult,
  Events,
  Methods,
  type PendingDecision,
  type RecipeRunArtifactGroup,
  type Run,
  type RunDecision,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import { BeforeAfterPreview } from '../../components/BeforeAfterPreview';
import { DocumentViewer } from '../../components/DocumentViewer';
import { EvidenceReviewWorkspace } from '../../components/EvidenceReviewWorkspace';
import { MediaViewer } from '../../components/MediaViewer';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { TaskProgressFallbackPanel, TaskProgressPanel } from '../../components/TaskProgressPanel';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactSource,
  artifactUrlForEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
  type VisualArtifactPair,
} from '../../lib/artifact-url';
import {
  type DecisionPresentation,
  documentTitle,
  presentDecision,
} from '../../lib/decision-presentation';
import { decisionRunId, enrichDecisionWithRunContext } from '../../lib/decision-run-context';
import { diffArtifactCandidate } from '../../lib/diff';
import { runRefreshEventMatches } from '../../lib/run-refresh';
import {
  hasRunWorkspaceDiff,
  selectSlotRecipeArtifactsForPreviewScope,
  summarizeSlotWorkspaceGates,
  summarizeSlotWorkspaceRetro,
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
import {
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
} from '../../lib/workspace-decisions';
import {
  decisionWorkspaceNavMeta,
  workspaceGateNavMeta,
  workspaceRetroNavMeta,
} from '../../lib/workspace-nav-meta';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceRouteContextParams,
  workspaceSignalTargetForDecisionLabel,
} from '../../lib/workspace-navigation';
import {
  type WorkspaceStickyNavLayout,
  workspaceStickyNavThreshold,
} from '../../lib/workspace-sticky-nav';
import { useConnectionStore } from '../../store/connection';
import { useDecisionStore } from '../../store/decisions';

const TONE_COLORS = {
  ok: colors.statusOk,
  warn: colors.statusWarn,
  fail: colors.statusFail,
  info: colors.accent,
} as const;

type DecisionDetail = PendingDecision & {
  resolvedAction?: string;
  resolvedAt?: string;
};

type DecisionSectionKey = 'signals' | 'evidence' | 'reports' | 'progress' | 'terminal' | 'actions';

export default function DecisionDetailScreen() {
  const {
    id,
    runId: routeRunId,
    recipeRun: routeRecipeRun,
    artifact: routeArtifactPath,
  } = useLocalSearchParams<{
    id: string;
    runId?: string | string[];
    recipeRun?: string | string[];
    artifact?: string | string[];
  }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const storeDecision = useDecisionStore((s) => s.decisions.find((d) => d.id === id));
  const setDecisions = useDecisionStore((s) => s.setDecisions);
  const removeDecision = useDecisionStore((s) => s.removeDecision);
  const [decision, setDecision] = useState<DecisionDetail | null>(storeDecision ?? null);
  const [error, setError] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [documentViewer, setDocumentViewer] = useState<{ title: string; body: string } | null>(
    null,
  );
  const [sourceRun, setSourceRun] = useState<Run | null>(null);
  const [recipeRuns, setRecipeRuns] = useState<RecipeRunArtifactGroup[]>([]);
  const [recipeArtifactCount, setRecipeArtifactCount] = useState<number | null>(null);
  const [recipeAvailabilityError, setRecipeAvailabilityError] = useState<string | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const [loadingDocument, setLoadingDocument] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const sectionOffsetsRef = useRef<Partial<Record<DecisionSectionKey, number>>>({});
  const documentAbortRef = useRef<AbortController | null>(null);
  const sourceRunRequestRef = useRef(0);
  const recipeRunsRequestRef = useRef(0);
  const [navLayout, setNavLayout] = useState<WorkspaceStickyNavLayout | null>(null);
  const [stickyNavVisible, setStickyNavVisibleState] = useState(false);
  const stickyNavVisibleRef = useRef(false);
  const scrollY = useSharedValue(0);
  const requestedArtifactPath = routeParamString(routeArtifactPath).trim();

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

  const refreshDecision = useCallback(() => {
    if (!client || !id) return;
    const fallbackRunId = routeParamString(routeRunId).trim();
    setError(null);
    client
      .request<DecisionListResult>('decision.list')
      .then((result) => {
        setDecisions(result.decisions);
        const next = result.decisions.find((d) => d.id === id) ?? null;
        if (next) {
          setDecision(next);
          return null;
        }
        if (!fallbackRunId) {
          setDecision(null);
          setError('Decision is no longer pending.');
          return null;
        }
        return client.request<RunGetResult>('run.get', { runId: fallbackRunId });
      })
      .then((result) => {
        if (!result) return;
        const runDecision = result.run.decisions?.find((d) => d.id === id) ?? null;
        if (!runDecision) {
          setDecision(null);
          setError('Decision is no longer pending.');
          return;
        }
        setDecision(decisionDetailFromRun(result.run, runDecision));
      })
      .catch((err: Error) => {
        setError(`Failed to refresh decision: ${err.message}`);
      });
  }, [client, id, routeRunId, setDecisions]);

  useEffect(() => {
    return () => {
      documentAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (storeDecision) {
      setDecision(storeDecision);
      return;
    }
    refreshDecision();
  }, [refreshDecision, storeDecision]);

  const sourceRunId = useMemo(() => {
    const routeFallbackRunId = routeParamString(routeRunId).trim();
    return decisionRunId(decision) ?? (routeFallbackRunId ? routeFallbackRunId : null);
  }, [decision, routeRunId]);
  const decisionWithRunContext = useMemo(
    () => enrichDecisionWithRunContext(decision, sourceRun),
    [decision, sourceRun],
  );
  const presentation = useMemo(
    () => (decisionWithRunContext ? presentDecision(decisionWithRunContext) : null),
    [decisionWithRunContext],
  );
  const decisionRouteContext = useMemo(
    () => decisionWorkspaceRouteParams(presentation?.kind),
    [presentation?.kind],
  );
  const diffRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('diff', decisionRouteContext.decisionKind),
    [decisionRouteContext.decisionKind],
  );
  const pairs = useMemo(
    () =>
      presentation?.runId
        ? groupArtifacts(presentation.artifactManifest, gatewayUrl, presentation.runId)
        : [],
    [gatewayUrl, presentation?.artifactManifest, presentation?.runId],
  );
  const diffArtifact = useMemo(
    () => (presentation ? diffArtifactCandidate(presentation.artifactManifest) : undefined),
    [presentation],
  );
  const refreshSourceRun = useCallback(
    async (reason: string) => {
      if (!client || !sourceRunId) return;
      const requestId = sourceRunRequestRef.current + 1;
      sourceRunRequestRef.current = requestId;
      try {
        const result = await client.request<RunGetResult>('run.get', { runId: sourceRunId });
        if (sourceRunRequestRef.current !== requestId) return;
        setSourceRun(result.run);
      } catch (err) {
        if (sourceRunRequestRef.current !== requestId) return;
        setSourceRun(null);
        setError(
          `Failed to refresh run workspace context after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, sourceRunId],
  );

  const refreshRecipeRuns = useCallback(
    async (reason: string, reset: boolean) => {
      if (!client || !sourceRunId) return;
      const requestId = recipeRunsRequestRef.current + 1;
      recipeRunsRequestRef.current = requestId;
      if (reset) {
        setRecipeRuns([]);
        setRecipeArtifactCount(null);
        setRecipeAvailabilityError(null);
      }
      try {
        const result = await client.request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
          runId: sourceRunId,
        });
        if (recipeRunsRequestRef.current !== requestId) return;
        setRecipeRuns(result.recipeRuns);
        setRecipeArtifactCount(
          result.recipeRuns.reduce(
            (count, group) => count + artifactsForRecipeRun(group).length,
            0,
          ),
        );
        setRecipeAvailabilityError(null);
      } catch (err) {
        if (recipeRunsRequestRef.current !== requestId) return;
        setRecipeRuns([]);
        setRecipeArtifactCount(null);
        setRecipeAvailabilityError(
          `Failed to refresh recipe evidence availability after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, sourceRunId],
  );

  useEffect(() => {
    if (!sourceRunId) {
      setSourceRun(null);
      return;
    }
    void refreshSourceRun('initial load');
  }, [refreshSourceRun, sourceRunId]);

  useEffect(() => {
    if (!sourceRunId) {
      setRecipeRuns([]);
      setRecipeArtifactCount(null);
      setRecipeAvailabilityError(null);
      return;
    }
    void refreshRecipeRuns('initial load', true);
  }, [refreshRecipeRuns, sourceRunId]);

  useEffect(() => {
    if (!client || !sourceRunId) return;
    const handleRunEvent = (payload: unknown, reason: string) => {
      const event = payload as { run?: Run; runId?: string };
      if (!runRefreshEventMatches(sourceRunId, event)) return;
      if (event.run?.id === sourceRunId) {
        sourceRunRequestRef.current += 1;
        setSourceRun(event.run);
      } else {
        void refreshSourceRun(reason);
      }
      void refreshRecipeRuns(reason, false);
      refreshDecision();
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
  }, [client, refreshDecision, refreshRecipeRuns, refreshSourceRun, sourceRunId]);

  const fetchTaskProgress = useCallback(() => {
    if (!client || !sourceRun?.slotId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, {
        slotId: sourceRun.slotId,
        runId: sourceRun.id,
      })
      .then((result) => {
        setTaskProgress(result.structured ?? null);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [client, sourceRun?.id, sourceRun?.slotId]);

  useEffect(() => {
    if (!client || !sourceRun) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(sourceRun, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, sourceRun]);

  useEffect(() => {
    if (!isWorkerProgressActive(sourceRun)) {
      setTaskProgress(null);
      setTaskProgressError(null);
      return;
    }
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTaskProgress, sourceRun]);
  const resolveAction = useCallback(
    (actionId: string) => {
      if (!client || !decision) return;
      const method = decision.runMeta ? 'run.resolveDecision' : 'decision.resolve';
      const params = decision.runMeta
        ? { runId: decision.runMeta.runId, decisionId: decision.id, actionId }
        : { decisionId: decision.id, actionId };

      Alert.alert('Confirm action', `Send "${actionId}" for ${decision.title}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          onPress: () => {
            client
              .request(method, params)
              .then(() => {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                removeDecision(decision.id);
                router.back();
              })
              .catch((err: Error) => Alert.alert('Failed to resolve', err.message));
          },
        },
      ]);
    },
    [client, decision, removeDecision, router],
  );

  const openDocumentArtifact = useCallback(
    (artifact: ArtifactManifestEntry) => {
      if (!presentation?.runId) return;
      const url = artifactUrlForEntry(gatewayUrl, presentation.runId, artifact);
      documentAbortRef.current?.abort();
      const controller = new AbortController();
      documentAbortRef.current = controller;
      setLoadingDocument(artifact.path);
      fetch(url, { signal: controller.signal, headers: artifactAuthHeaders })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((body) => setDocumentViewer({ title: documentTitle(artifact.path), body }))
        .catch((err: Error) => {
          // Abort is the expected cleanup path when the operator closes/navigates mid-fetch.
          if (err.name === 'AbortError') return;
          Alert.alert('Failed to load document', err.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingDocument(null);
        });
    },
    [artifactAuthHeaders, gatewayUrl, presentation?.runId],
  );

  const openDiffArtifact = useCallback(
    (path: string) => {
      if (!presentation?.runId) return;
      const routeRecipeRunId = routeParamString(routeRecipeRun).trim();
      router.push({
        pathname: '/diff/[runId]',
        params: {
          runId: presentation.runId,
          ...diffRouteContext,
          path,
          recipeRun: routeRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        },
      });
    },
    [diffRouteContext, presentation?.runId, routeRecipeRun, router],
  );

  const openArtifactWorkspaceForDecision = useCallback(
    (artifact: ArtifactManifestEntry) => {
      if (!presentation?.runId) return;
      if (diffArtifactCandidate([artifact])?.path === artifact.path) {
        openDiffArtifact(artifact.path);
        return;
      }
      router.push({
        pathname: '/artifacts/[runId]',
        params: {
          runId: presentation.runId,
          ...decisionRouteContext,
          recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
          artifact: artifact.path,
          filter:
            artifactFilterParamForArtifactPath(artifact.path) ??
            artifactFilterParamForWorkspaceNav('review'),
        },
      });
    },
    [decisionRouteContext, openDiffArtifact, presentation?.runId, router],
  );

  const rememberSection = useCallback(
    (section: DecisionSectionKey) => (event: LayoutChangeEvent) => {
      sectionOffsetsRef.current[section] = event.nativeEvent.layout.y;
    },
    [],
  );

  const scrollToSection = useCallback((section: DecisionSectionKey) => {
    const sectionOffset = sectionOffsetsRef.current[section];
    if (typeof sectionOffset !== 'number') return;
    scrollRef.current?.scrollTo({
      y: Math.max(0, sectionOffset - spacing.md),
      animated: true,
    });
  }, []);

  const recipeFallbackPairs = useMemo(
    () =>
      presentation?.runId && pairs.length === 0
        ? groupVisualArtifactPairs(
            selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
            (artifact) => artifactUrlForEntry(gatewayUrl, presentation.runId!, artifact),
          ).pairs
        : [],
    [gatewayUrl, pairs.length, presentation?.runId, recipeRuns],
  );
  const recipeScopedArtifacts = useMemo(
    () => selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
    [recipeRuns],
  );
  const recipePreviewArtifacts = useMemo(
    () => recipeScopedArtifacts.slice(0, 4),
    [recipeScopedArtifacts],
  );
  const recipeVisualPairs = useMemo(
    () =>
      presentation?.runId
        ? groupVisualArtifactPairs(recipeScopedArtifacts, (artifact) =>
            artifactUrlForEntry(gatewayUrl, presentation.runId!, artifact),
          ).pairs
        : [],
    [gatewayUrl, presentation?.runId, recipeScopedArtifacts],
  );
  const priorityPairs = pairs.length > 0 ? pairs : recipeFallbackPairs;
  const primaryPair = priorityPairs[0] ?? null;
  const primaryPairIsRecipeFallback = pairs.length === 0 && recipeFallbackPairs.length > 0;
  const priorityCompareRecipeRunId = primaryPairIsRecipeFallback
    ? recipeRunIdForVisualPair(recipeRuns, primaryPair)
    : DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const visualViewerItems = useMemo(() => {
    if (!presentation?.runId) return [];
    const runId = presentation.runId;
    const items = presentation.artifactManifest
      .filter((artifact) => ['image', 'video'].includes(classifyArtifact(artifact)))
      .map((artifact) => ({
        uri: artifactUrlForEntry(gatewayUrl, runId, artifact),
        title: artifact.label ?? artifact.path,
        mediaType: classifyArtifact(artifact),
        authHeaders: artifactAuthHeaders,
      }));

    for (const pair of recipeFallbackPairs) {
      for (const artifact of [pair.before, pair.after]) {
        items.push({
          uri: artifact.url,
          title: artifact.label ?? artifact.path,
          mediaType: classifyArtifact(artifact),
          authHeaders: artifactAuthHeaders,
        });
      }
    }

    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.uri)) return false;
      seen.add(item.uri);
      return true;
    });
  }, [
    artifactAuthHeaders,
    gatewayUrl,
    presentation?.artifactManifest,
    presentation?.runId,
    recipeFallbackPairs,
  ]);

  if (!decision || !presentation) {
    return (
      <View style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom }]}>
        <Text style={baseStyles.textSecondary}>{error ?? 'Loading decision...'}</Text>
        <Pressable style={styles.secondaryButton} onPress={refreshDecision}>
          <Text style={styles.secondaryButtonText}>Refresh</Text>
        </Pressable>
      </View>
    );
  }

  const toneColor = TONE_COLORS[presentation.tone];
  const viewerIndex = viewerUri
    ? visualViewerItems.findIndex((item) => item.uri === viewerUri)
    : -1;
  const canShowViewer = viewerUri != null && viewerIndex >= 0;
  const readyDecision = selectReadyWorkspaceDecision(sourceRun) ?? null;
  const reviewGateDecision = selectReviewGateWorkspaceDecision(sourceRun) ?? null;
  const retroDecision = selectRetrospectiveWorkspaceDecision(sourceRun) ?? null;
  const activeTaskProgress = isWorkerProgressActive(sourceRun)
    ? (effectiveTaskProgressForRun(sourceRun, taskProgress) ?? null)
    : null;
  const fallbackTaskProgress =
    !activeTaskProgress && isWorkerProgressActive(sourceRun)
      ? fallbackTaskProgressSummary(sourceRun)
      : null;
  const currentDecisionIsReady = presentation.kind === 'ready';
  const currentDecisionIsReview =
    presentation.kind === 'review' || presentation.kind === 'no-change';
  const currentDecisionIsRetro = presentation.kind === 'retrospective';
  const readyDecisionId = readyDecision?.id ?? (currentDecisionIsReady ? decision.id : null);
  const reviewDecisionId = reviewGateDecision?.id ?? (currentDecisionIsReview ? decision.id : null);
  const retroDecisionId = retroDecision?.id ?? (currentDecisionIsRetro ? decision.id : null);
  const recipeAvailable = recipeArtifactCount === null ? undefined : recipeArtifactCount > 0;
  const routeRecipeRunId = routeParamString(routeRecipeRun).trim();
  const workspaceRecipeRunId = presentation.runId
    ? routeRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM
    : null;
  const diffAvailable = Boolean(
    diffArtifact?.path || presentation.diffStat || (sourceRun && hasRunWorkspaceDiff(sourceRun)),
  );
  const decisionDiffValue = presentation.diffStat
    ? `+${presentation.diffStat.additions} -${presentation.diffStat.deletions}`
    : diffArtifact?.path
      ? 'artifact'
      : diffAvailable
        ? 'workspace'
        : presentation.terminalSlotId
          ? 'slot'
          : 'none';
  const workspaceGatesForNav = sourceRun ? summarizeSlotWorkspaceGates(sourceRun) : [];
  const readyGateForNav =
    workspaceGatesForNav.find((gate) => gate.label === 'Ready workspace') ?? null;
  const reviewGateForNav =
    workspaceGatesForNav.find(
      (gate) => gate.label === 'Review workspace' || gate.label === 'No-change review',
    ) ?? null;
  const retroSummaryForNav = sourceRun ? summarizeSlotWorkspaceRetro(sourceRun) : null;
  const currentDecisionMeta = decisionWorkspaceNavMeta({
    statusLabel: decision.resolvedAt ? 'resolved' : 'pending',
    artifactCount: presentation.artifactManifest.length,
    diffValue: decisionDiffValue,
    visualPairCount: priorityPairs.length,
  });
  const focusedArtifactPath = requestedArtifactPath || diffArtifact?.path || null;
  const workspaceNavProps = {
    dense: true,
    current:
      presentation.kind === 'retrospective'
        ? ('retro' as const)
        : presentation.kind === 'ready'
          ? ('ready' as const)
          : ('review' as const),
    decisionId: decision.id,
    decisionKind: presentation.kind,
    readyDecisionId,
    reviewDecisionId,
    retroDecisionId,
    readyMeta: currentDecisionIsReady ? currentDecisionMeta : workspaceGateNavMeta(readyGateForNav),
    reviewMeta: currentDecisionIsReview
      ? currentDecisionMeta
      : workspaceGateNavMeta(reviewGateForNav),
    retroMeta: currentDecisionIsRetro
      ? currentDecisionMeta
      : workspaceRetroNavMeta(retroSummaryForNav),
    familyId: presentation.familyId,
    project: sourceRun?.project ?? presentation.project,
    prNumber: presentation.prNumber,
    prRepo: presentation.repo,
    recipeRunId: workspaceRecipeRunId,
    recipeAvailable,
    recipeArtifactCount,
    diffAvailable,
    artifactCount: presentation.artifactManifest.length,
    visualPairCount: priorityPairs.length,
    compareArtifactPath: primaryPair?.after.path ?? null,
    compareRecipeRunId: priorityCompareRecipeRunId,
    slotId: presentation.slotId,
    runId: presentation.runId,
    artifactPath: focusedArtifactPath,
  };

  return (
    <View style={baseStyles.container}>
      <Stack.Screen
        options={{
          title:
            presentation.kind === 'retrospective'
              ? 'Retrospective'
              : presentation.kind === 'ready'
                ? 'Ready Gate'
                : 'Review Gate',
        }}
      />
      <Animated.View
        pointerEvents={stickyNavVisible && navLayout !== null ? 'auto' : 'none'}
        style={[styles.stickyWorkspaceNav, stickyNavStyle]}
      >
        <RunWorkspaceNav {...workspaceNavProps} />
      </Animated.View>
      <Animated.ScrollView
        ref={scrollRef}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: styles.scrollContent.paddingBottom + insets.bottom },
        ]}
      >
        <View style={[styles.headerCard, { borderLeftColor: toneColor }]}>
          <View style={styles.row}>
            <View style={[styles.kindBadge, { backgroundColor: toneColor + '25' }]}>
              <Text style={[styles.kindText, { color: toneColor }]}>{presentation.kindLabel}</Text>
            </View>
            <Text style={styles.ageText}>{new Date(decision.createdAt).toLocaleTimeString()}</Text>
          </View>
          <Text style={styles.title}>{presentation.title}</Text>
          <Text style={baseStyles.textSecondary}>
            {presentation.summary || presentation.description}
          </Text>
          <View style={styles.metaGrid}>
            <Meta label="Run" value={presentation.ticketOrPr ?? presentation.runId ?? '-'} />
            <Meta label="Slot" value={presentation.slotId ?? '-'} />
            <Meta label="Branch" value={presentation.branch ?? '-'} />
            <Meta label="Model" value={presentation.model ?? presentation.runner ?? '-'} />
          </View>
        </View>

        <View onLayout={rememberNavLayout}>
          <RunWorkspaceNav {...workspaceNavProps} />
        </View>

        {requestedArtifactPath ? (
          <DecisionFocusedArtifactCard
            artifactPath={requestedArtifactPath}
            runId={presentation.runId}
            slotId={presentation.terminalSlotId}
            familyId={presentation.familyId}
            prNumber={presentation.prNumber}
            recipeAvailable={recipeAvailable}
            recipeRunId={workspaceRecipeRunId}
            contextLabel={
              presentation.kind === 'retrospective' ? 'retro context' : 'review context'
            }
            comparePairCount={priorityPairs.length}
            onOpenArtifact={() => {
              if (!presentation.runId) return;
              const artifactFilter = artifactFilterParamForArtifactPath(requestedArtifactPath);
              const artifactRecipeRun =
                artifactFilter === 'recipes'
                  ? recipeWorkspaceParam(workspaceRecipeRunId)
                  : (workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM);
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: artifactRecipeRun,
                  filter: artifactFilter ?? artifactFilterParamForWorkspaceNav('review'),
                  artifact: requestedArtifactPath,
                },
              });
            }}
            onOpenRecipe={() => {
              if (!presentation.runId || recipeAvailable === false) return;
              const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: recipeTarget,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                  ...(shouldPreserveArtifactForRecipeContext(recipeTarget, requestedArtifactPath)
                    ? { artifact: requestedArtifactPath }
                    : {}),
                },
              });
            }}
            onOpenDiff={() => openDiffArtifact(requestedArtifactPath)}
            onOpenCompare={() => {
              if (!presentation.runId || !primaryPair) return;
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: priorityCompareRecipeRunId,
                  filter: artifactFilterParamForWorkspaceNav('compare'),
                  artifact: primaryPair.after.path,
                },
              });
            }}
            onOpenRun={() => {
              if (!presentation.runId) return;
              router.push({
                pathname: '/run/[id]',
                params: {
                  id: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: requestedArtifactPath,
                },
              });
            }}
            onOpenSlot={() => {
              if (!presentation.terminalSlotId || !presentation.runId) return;
              router.push({
                pathname: '/slot/[id]',
                params: {
                  id: presentation.terminalSlotId,
                  ...decisionRouteContext,
                  runId: presentation.runId,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: requestedArtifactPath,
                },
              });
            }}
            onOpenTerminal={() => {
              if (!presentation.terminalSlotId || !presentation.runId) return;
              router.push({
                pathname: '/terminal/[slotId]',
                params: {
                  slotId: presentation.terminalSlotId,
                  ...decisionRouteContext,
                  runId: presentation.runId,
                  details: '1',
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: requestedArtifactPath,
                },
              });
            }}
            onOpenFamily={() => {
              if (!presentation.familyId || !presentation.runId) return;
              router.push({
                pathname: '/family/[familyId]',
                params: {
                  familyId: presentation.familyId,
                  ...((sourceRun?.project ?? presentation.project)
                    ? { project: sourceRun?.project ?? presentation.project }
                    : {}),
                  ...familySectionRouteContextParams(
                    presentation.kind === 'retrospective' ? 'retros' : 'focus',
                    decisionRouteContext.decisionKind,
                  ),
                  runId: presentation.runId,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: requestedArtifactPath,
                  section: presentation.kind === 'retrospective' ? 'retros' : 'focus',
                },
              });
            }}
            onOpenPR={() => {
              if (!presentation.prNumber) return;
              router.push({
                pathname: '/(tabs)/prs',
                params: {
                  pr: String(presentation.prNumber),
                  ...decisionRouteContext,
                  ...(presentation.repo ? { repo: presentation.repo } : {}),
                },
              });
            }}
          />
        ) : null}

        {primaryPair ? (
          <DecisionBeforeAfterPriorityPanel
            pair={primaryPair}
            pairCount={priorityPairs.length}
            kindLabel={presentation.kindLabel}
            recipeFallback={primaryPairIsRecipeFallback}
            authHeaders={artifactAuthHeaders}
            artifactCount={presentation.artifactManifest.length}
            recipeArtifactCount={recipeArtifactCount}
            recipeAvailable={recipeAvailable}
            diffValue={decisionDiffValue}
            slotId={presentation.terminalSlotId}
            familyId={presentation.familyId}
            prNumber={presentation.prNumber}
            onOpenArtifact={(artifactPath) => {
              const visualTarget = [primaryPair.before, primaryPair.after].find(
                (artifact) => artifact.path === artifactPath,
              );
              if (visualTarget && ['image', 'video'].includes(classifyArtifact(visualTarget))) {
                setViewerUri(visualTarget.url);
                return;
              }
              const target = presentation.artifactManifest.find(
                (artifact) => artifact.path === artifactPath,
              );
              if (target) {
                openArtifactWorkspaceForDecision(target);
                return;
              }
              if (!primaryPairIsRecipeFallback || !presentation.runId) return;
              const recipeTarget = [primaryPair.before, primaryPair.after].find(
                (artifact) => artifact.path === artifactPath,
              );
              if (!recipeTarget) return;
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: priorityCompareRecipeRunId,
                  filter: artifactFilterParamForWorkspaceNav('compare'),
                  artifact: recipeTarget.path,
                },
              });
            }}
            onOpenCompare={() => {
              if (!presentation.runId) return;
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: priorityCompareRecipeRunId,
                  filter: artifactFilterParamForWorkspaceNav('compare'),
                  artifact: primaryPair.after.path,
                },
              });
            }}
            onOpenEvidence={() => {
              if (!presentation.runId) return;
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  filter: artifactFilterParamForWorkspaceNav('review'),
                },
              });
            }}
            onOpenRecipe={() => {
              if (!presentation.runId || recipeAvailable === false) return;
              const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: recipeTarget,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                  ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
                    ? { artifact: focusedArtifactPath }
                    : {}),
                },
              });
            }}
            onOpenDiff={() => {
              if (diffArtifact?.path) {
                openDiffArtifact(diffArtifact.path);
                return;
              }
              if (presentation.runId && diffAvailable) {
                router.push({
                  pathname: '/diff/[runId]',
                  params: {
                    runId: presentation.runId,
                    ...diffRouteContext,
                    recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                });
                return;
              }
              if (presentation.terminalSlotId) {
                router.push({
                  pathname: '/diff/slot/[slotId]',
                  params: {
                    slotId: presentation.terminalSlotId,
                    ...diffRouteContext,
                  },
                });
              }
            }}
            onOpenRun={() => {
              if (!presentation.runId) return;
              router.push({
                pathname: '/run/[id]',
                params: {
                  id: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                },
              });
            }}
            onOpenFamily={() => {
              if (!presentation.familyId || !presentation.runId) return;
              router.push({
                pathname: '/family/[familyId]',
                params: {
                  familyId: presentation.familyId,
                  ...((sourceRun?.project ?? presentation.project)
                    ? { project: sourceRun?.project ?? presentation.project }
                    : {}),
                  ...familySectionRouteContextParams(
                    presentation.kind === 'retrospective' ? 'retros' : 'focus',
                    decisionRouteContext.decisionKind,
                  ),
                  runId: presentation.runId,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                  section: presentation.kind === 'retrospective' ? 'retros' : 'focus',
                },
              });
            }}
            onOpenTerminal={() => {
              if (!presentation.terminalSlotId || !presentation.runId) return;
              router.push({
                pathname: '/terminal/[slotId]',
                params: {
                  slotId: presentation.terminalSlotId,
                  ...decisionRouteContext,
                  runId: presentation.runId,
                  details: '1',
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                },
              });
            }}
            onOpenPR={() => {
              if (!presentation.prNumber) return;
              router.push({
                pathname: '/(tabs)/prs',
                params: {
                  pr: String(presentation.prNumber),
                  ...decisionRouteContext,
                  ...(presentation.repo ? { repo: presentation.repo } : {}),
                },
              });
            }}
          />
        ) : null}

        <DecisionWorkspaceCockpit
          presentation={presentation}
          currentDecisionId={decision.id}
          readyDecisionId={readyDecisionId}
          reviewDecisionId={reviewDecisionId}
          retroDecisionId={retroDecisionId}
          diffPath={diffArtifact?.path}
          recipeArtifactCount={recipeArtifactCount}
          recipeAvailable={recipeAvailable}
          diffAvailable={diffAvailable}
          visualPairCount={priorityPairs.length}
          compareArtifactPath={primaryPair?.after.path ?? null}
          compareRecipeRunId={priorityCompareRecipeRunId}
          focusedArtifactPath={focusedArtifactPath}
          workspaceRecipeRunId={workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM}
          onJumpSignals={() => scrollToSection('signals')}
          onJumpEvidence={() => scrollToSection('evidence')}
          onJumpReports={() => scrollToSection('reports')}
          activeTaskProgress={activeTaskProgress}
          fallbackTaskProgress={fallbackTaskProgress}
          sourceRun={sourceRun}
          decisionRouteContext={decisionRouteContext}
          onJumpProgress={() => scrollToSection('progress')}
          onJumpTerminal={() => scrollToSection('terminal')}
          onJumpActions={() => scrollToSection('actions')}
        />

        {error && <Text style={styles.errorText}>{error}</Text>}
        {recipeAvailabilityError && <Text style={styles.errorText}>{recipeAvailabilityError}</Text>}

        {activeTaskProgress ? (
          <View style={styles.section} onLayout={rememberSection('progress')}>
            <Text style={styles.sectionTitle}>Worker progress</Text>
            <TaskProgressPanel
              run={sourceRun}
              progress={activeTaskProgress}
              error={taskProgressError}
              compact
            />
          </View>
        ) : fallbackTaskProgress ? (
          <View style={styles.section} onLayout={rememberSection('progress')}>
            <Text style={styles.sectionTitle}>Worker progress</Text>
            <TaskProgressFallbackPanel
              summary={fallbackTaskProgress}
              error={taskProgressError}
              compact
            />
          </View>
        ) : null}

        {presentation.highlights.length > 0 && (
          <View style={styles.section} onLayout={rememberSection('signals')}>
            <Text style={styles.sectionTitle}>Gate signals</Text>
            <View style={styles.chipWrap}>
              {presentation.highlights.map((item) => {
                const color = TONE_COLORS[item.tone ?? 'info'];
                const target = signalTarget(
                  item.label,
                  presentation.runId,
                  diffArtifact?.path,
                  primaryPair?.after.path,
                  priorityCompareRecipeRunId,
                  decisionRouteContext,
                );
                const content = (
                  <>
                    <Text style={[styles.signalLabel, { color }]}>{item.label}</Text>
                    <View style={styles.signalValueRow}>
                      <Text style={styles.signalValue}>{item.value}</Text>
                      {target && <Text style={[styles.signalArrow, { color }]}>›</Text>}
                    </View>
                  </>
                );
                if (target) {
                  return (
                    <Pressable
                      key={`${item.label}-${item.value}`}
                      style={[
                        styles.signalChip,
                        styles.signalChipPressable,
                        { borderColor: color + '80' },
                      ]}
                      onPress={() => router.push(target)}
                    >
                      {content}
                    </Pressable>
                  );
                }
                return (
                  <View
                    key={`${item.label}-${item.value}`}
                    style={[styles.signalChip, { borderColor: color + '80' }]}
                  >
                    {content}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {presentation.criteria.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Acceptance criteria</Text>
            {presentation.criteria.map((criterion) => (
              <Text key={criterion} style={styles.bullet}>
                • {criterion}
              </Text>
            ))}
          </View>
        )}

        {presentation.artifactManifest.length > 0 && presentation.runId && (
          <View style={styles.section} onLayout={rememberSection('evidence')}>
            <Text style={styles.sectionTitle}>Evidence</Text>
            <EvidenceReviewWorkspace
              runId={presentation.runId}
              gatewayUrl={gatewayUrl}
              artifacts={presentation.artifactManifest}
              pairs={pairs}
              authHeaders={artifactAuthHeaders}
              onOpenVisual={setViewerUri}
              onOpenDocument={openDocumentArtifact}
              onOpenDiff={openDiffArtifact}
              onOpenArtifactWorkspace={openArtifactWorkspaceForDecision}
            />
            {loadingDocument && (
              <Text style={baseStyles.textMuted}>Loading {loadingDocument}...</Text>
            )}
          </View>
        )}

        {presentation.runId && recipeRuns.length > 0 ? (
          <DecisionRecipeEvidenceSection
            runId={presentation.runId}
            recipeArtifactCount={recipeArtifactCount}
            recipeAvailable={recipeAvailable}
            previewArtifacts={recipePreviewArtifacts}
            primaryPair={recipeVisualPairs[0] ?? null}
            authHeaders={artifactAuthHeaders}
            gatewayUrl={gatewayUrl}
            onOpenRecipeArtifacts={() =>
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: presentation.runId!,
                  ...decisionRouteContext,
                  recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                },
              })
            }
            onOpenRecipeArtifact={(
              artifactPath,
              recipeRunId,
              filter = artifactFilterParamForWorkspaceNav('recipe'),
            ) => {
              if (diffArtifactCandidate([{ path: artifactPath }])) {
                router.push({
                  pathname: '/diff/[runId]',
                  params: {
                    runId: presentation.runId!,
                    ...diffRouteContext,
                    recipeRun: recipeRunId,
                    path: artifactPath,
                  },
                });
                return;
              }
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: presentation.runId!,
                  ...decisionRouteContext,
                  recipeRun: recipeRunId,
                  filter,
                  artifact: artifactPath,
                },
              });
            }}
          />
        ) : null}

        {presentation.textSections.length > 0 && (
          <View style={styles.section} onLayout={rememberSection('reports')}>
            <Text style={styles.sectionTitle}>Reports</Text>
            {presentation.textSections.map((section) => (
              <View key={section.title} style={styles.reportCard}>
                <Text style={styles.reportTitle}>{section.title}</Text>
                <Text style={styles.reportBody}>{section.body}</Text>
              </View>
            ))}
          </View>
        )}

        {(() => {
          const terminalSlotId = presentation.terminalSlotId;
          if (!terminalSlotId) return null;
          return (
            <View style={styles.section} onLayout={rememberSection('terminal')}>
              <Text style={styles.sectionTitle}>Worker terminal</Text>
              <Pressable
                style={styles.terminalButton}
                onPress={() =>
                  router.push({
                    pathname: '/terminal/[slotId]',
                    params: {
                      slotId: terminalSlotId,
                      ...decisionRouteContext,
                      details: '1',
                      ...(presentation.runId ? { runId: presentation.runId } : {}),
                      ...(presentation.runId
                        ? { recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM }
                        : {}),
                      ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                    },
                  })
                }
              >
                <Text style={styles.terminalButtonText}>Observe / reply to {terminalSlotId}</Text>
              </Pressable>
            </View>
          );
        })()}

        <View style={styles.section} onLayout={rememberSection('actions')}>
          <Text style={styles.sectionTitle}>Evidence-reviewed actions</Text>
          <View style={styles.safetyCard}>
            <Text style={styles.safetyTitle}>Resolve only from full context</Text>
            <Text style={styles.safetyText}>
              Mobile gate shortcuts route here first. Review the summary, criteria, visual evidence,
              reports, artifacts, and terminal context above before sending a response.
            </Text>
          </View>
          {decision.resolvedAt ? (
            <View style={styles.resolvedDecisionCard}>
              <Text style={styles.safetyTitle}>Already resolved</Text>
              <Text style={styles.safetyText}>
                Action: {decision.resolvedAction ?? 'resolved'} ·{' '}
                {new Date(decision.resolvedAt).toLocaleString()}
              </Text>
            </View>
          ) : (
            presentation.actions.map((action) => (
              <Pressable
                key={action.id}
                style={[
                  styles.actionButton,
                  action.style === 'primary' && { backgroundColor: colors.accent },
                  action.style === 'danger' && { backgroundColor: colors.statusFail },
                ]}
                onPress={() => resolveAction(action.id)}
              >
                <Text style={styles.actionText}>{action.label}</Text>
                {action.description && (
                  <Text style={styles.actionDescription}>{action.description}</Text>
                )}
              </Pressable>
            ))
          )}
        </View>

        <MediaViewer
          visible={canShowViewer}
          uri={viewerUri}
          items={visualViewerItems}
          authHeaders={artifactAuthHeaders}
          initialIndex={Math.max(0, viewerIndex)}
          onClose={() => setViewerUri(null)}
        />
        <DocumentViewer
          visible={!!documentViewer}
          title={documentViewer?.title ?? ''}
          body={documentViewer?.body ?? ''}
          onClose={() => setDocumentViewer(null)}
        />
      </Animated.ScrollView>
    </View>
  );
}

function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function DecisionFocusedArtifactCard({
  artifactPath,
  runId,
  slotId,
  familyId,
  prNumber,
  recipeAvailable,
  recipeRunId,
  contextLabel,
  comparePairCount,
  onOpenArtifact,
  onOpenRecipe,
  onOpenDiff,
  onOpenCompare,
  onOpenRun,
  onOpenSlot,
  onOpenTerminal,
  onOpenFamily,
  onOpenPR,
}: {
  artifactPath: string;
  runId?: string | null;
  slotId?: string | null;
  familyId?: string | null;
  prNumber?: number | null;
  recipeAvailable?: boolean;
  recipeRunId?: string | null;
  contextLabel: string;
  comparePairCount: number;
  onOpenArtifact: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenCompare: () => void;
  onOpenRun: () => void;
  onOpenSlot: () => void;
  onOpenTerminal: () => void;
  onOpenFamily: () => void;
  onOpenPR: () => void;
}) {
  const artifactFilter = artifactFilterParamForArtifactPath(artifactPath);
  const isDiff = Boolean(diffArtifactCandidate([{ path: artifactPath }]));
  const artifactKind =
    artifactFilter === 'recipes'
      ? 'recipe file'
      : artifactFilter === 'visual'
        ? 'visual evidence'
        : isDiff
          ? 'diff'
          : 'evidence file';
  const recipeValue =
    recipeRunId && recipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM ? 'selected' : 'current';
  return (
    <View style={styles.focusedArtifactCard}>
      <View style={styles.focusedArtifactHeader}>
        <View style={styles.focusedArtifactTitleBlock}>
          <Text style={styles.focusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.focusedArtifactPath} numberOfLines={2}>
            {artifactPath}
          </Text>
          <Text style={styles.focusedArtifactMeta} numberOfLines={1}>
            {artifactKind} · {contextLabel}
          </Text>
        </View>
        <DecisionCockpitAction
          label={isDiff ? 'Open diff' : 'Open'}
          onPress={isDiff ? onOpenDiff : onOpenArtifact}
          primary
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.focusedArtifactActions}
      >
        <DecisionCockpitTile label="Files" value="context" onPress={onOpenArtifact} />
        <DecisionCockpitTile
          label="Recipe files"
          value={recipeAvailable === false ? '-' : recipeValue}
          onPress={onOpenRecipe}
          disabled={!runId || recipeAvailable === false}
        />
        <DecisionCockpitTile
          label="Before→After"
          value={comparePairCount > 0 ? String(comparePairCount) : '-'}
          onPress={onOpenCompare}
          disabled={!runId || comparePairCount === 0}
        />
        <DecisionCockpitTile
          label="Diff"
          value={isDiff ? 'focused' : 'run'}
          onPress={onOpenDiff}
          disabled={!runId}
        />
        <DecisionCockpitTile
          label="Run"
          value={runId ? shortId(runId) : '-'}
          onPress={onOpenRun}
          disabled={!runId}
        />
        <DecisionCockpitTile
          label="Slot"
          value={slotId ? 'workspace' : '-'}
          onPress={onOpenSlot}
          disabled={!slotId}
        />
        <DecisionCockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <DecisionCockpitTile
          label="Family"
          value={familyId ? shortId(familyId) : '-'}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
        <DecisionCockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}

function DecisionBeforeAfterPriorityPanel({
  pair,
  pairCount,
  kindLabel,
  recipeFallback,
  authHeaders,
  artifactCount,
  recipeArtifactCount,
  recipeAvailable,
  diffValue,
  slotId,
  familyId,
  prNumber,
  onOpenArtifact,
  onOpenCompare,
  onOpenEvidence,
  onOpenRecipe,
  onOpenDiff,
  onOpenRun,
  onOpenFamily,
  onOpenTerminal,
  onOpenPR,
}: {
  pair: VisualArtifactPair;
  pairCount: number;
  kindLabel: string;
  recipeFallback: boolean;
  authHeaders: Record<string, string>;
  artifactCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffValue: string;
  slotId?: string | null;
  familyId?: string | null;
  prNumber?: number | null;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenCompare: () => void;
  onOpenEvidence: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenRun: () => void;
  onOpenFamily: () => void;
  onOpenTerminal: () => void;
  onOpenPR: () => void;
}) {
  return (
    <View style={styles.beforeAfterPriorityPanel}>
      <BeforeAfterPreview
        pair={pair}
        authHeaders={authHeaders}
        onOpenArtifact={onOpenArtifact}
        eyebrow={recipeFallback ? 'Recipe evidence' : 'Review first'}
        title={recipeFallback ? 'Recipe before → after' : `${kindLabel} before → after`}
        hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
        imageHeight={90}
      />
      <View style={styles.beforeAfterPriorityActions}>
        <Text style={styles.beforeAfterPriorityCopy}>
          {recipeFallback
            ? 'Recipe evidence has the clearest visible delta for this gate.'
            : 'Compare the visible delta before using the decision actions.'}
        </Text>
        <Pressable style={styles.beforeAfterPriorityButton} onPress={onOpenCompare}>
          <Text style={styles.beforeAfterPriorityButtonText}>Compare evidence</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.beforeAfterPriorityRail}
      >
        <DecisionCockpitTile
          label="Evidence"
          value={String(artifactCount)}
          onPress={onOpenEvidence}
        />
        <DecisionCockpitTile
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
        <DecisionCockpitTile label="Diff" value={diffValue} onPress={onOpenDiff} />
        <DecisionCockpitTile label="Run" value="detail" onPress={onOpenRun} />
        <DecisionCockpitTile
          label="Family"
          value={familyId ? shortId(familyId) : '-'}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
        <DecisionCockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <DecisionCockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}

function DecisionWorkspaceCockpit({
  presentation,
  currentDecisionId,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  diffPath,
  recipeArtifactCount,
  recipeAvailable,
  diffAvailable,
  visualPairCount,
  compareArtifactPath,
  compareRecipeRunId,
  focusedArtifactPath,
  workspaceRecipeRunId,
  activeTaskProgress,
  fallbackTaskProgress,
  sourceRun,
  decisionRouteContext,
  onJumpSignals,
  onJumpEvidence,
  onJumpReports,
  onJumpProgress,
  onJumpTerminal,
  onJumpActions,
}: {
  presentation: DecisionPresentation;
  currentDecisionId: string;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  diffPath?: string;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffAvailable: boolean;
  visualPairCount: number;
  compareArtifactPath: string | null;
  compareRecipeRunId: string;
  focusedArtifactPath: string | null;
  workspaceRecipeRunId: string;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  sourceRun: Run | null;
  decisionRouteContext: ReturnType<typeof decisionWorkspaceRouteParams>;
  onJumpSignals: () => void;
  onJumpEvidence: () => void;
  onJumpReports: () => void;
  onJumpProgress: () => void;
  onJumpTerminal: () => void;
  onJumpActions: () => void;
}) {
  const router = useRouter();
  if (!presentation.runId) return null;
  const diffRouteContext = targetWorkspaceRouteContextParams(
    'diff',
    decisionRouteContext.decisionKind,
  );

  const diffValue = presentation.diffStat
    ? `+${presentation.diffStat.additions} -${presentation.diffStat.deletions}`
    : diffPath
      ? 'artifact'
      : diffAvailable
        ? 'workspace'
        : presentation.slotId
          ? 'slot'
          : 'none';
  const hasTerminal = Boolean(presentation.terminalSlotId);
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';
  const progressMeta =
    activeTaskProgress && sourceRun
      ? taskProgressTitle(sourceRun, activeTaskProgress)
      : fallbackTaskProgress
        ? fallbackTaskProgress.meta
        : 'No progress';
  const recipeScopeLabel = recipeWorkspaceScopeLabel(workspaceRecipeRunId);
  const evidenceHint = `${visualPairCount} pair${visualPairCount === 1 ? '' : 's'} · ${diffValue}`;
  const gateHint = `${presentation.artifactManifest.length} file${
    presentation.artifactManifest.length === 1 ? '' : 's'
  } · ${diffValue}`;
  const openDecisionArtifacts = () =>
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: presentation.runId!,
        ...decisionRouteContext,
        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        filter: artifactFilterParamForWorkspaceNav('review'),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  const openCompareArtifacts = () =>
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: presentation.runId!,
        ...decisionRouteContext,
        recipeRun: compareRecipeRunId,
        filter: artifactFilterParamForWorkspaceNav('compare'),
        ...(compareArtifactPath ? { artifact: compareArtifactPath } : {}),
      },
    });
  const openRecipeArtifacts = () => {
    if (recipeAvailable === false) return;
    const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: presentation.runId!,
        ...decisionRouteContext,
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
          ? { artifact: focusedArtifactPath }
          : {}),
      },
    });
  };
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const openDiff = () => {
    if (!diffAvailable && presentation.slotId) {
      router.push({
        pathname: '/diff/slot/[slotId]',
        params: { slotId: presentation.slotId, ...diffRouteContext },
      });
      return;
    }
    router.push({
      pathname: '/diff/[runId]',
      params: {
        runId: presentation.runId!,
        ...diffRouteContext,
        ...(focusedArtifactIsDiff && focusedArtifactPath
          ? { path: focusedArtifactPath }
          : diffPath
            ? { path: diffPath }
            : {}),
        recipeRun: workspaceRecipeRunId,
      },
    });
  };
  const openSlot = () => {
    if (!presentation.slotId) return;
    router.push({
      pathname: '/slot/[id]',
      params: {
        id: presentation.slotId,
        ...decisionRouteContext,
        runId: presentation.runId!,
        recipeRun: workspaceRecipeRunId,
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openPR = () => {
    if (!presentation.prNumber) return;
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(presentation.prNumber),
        ...decisionRouteContext,
        ...(presentation.repo ? { repo: presentation.repo } : {}),
      },
    });
  };
  const openDecision = (decisionId: string | null) => {
    if (!decisionId) return;
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...decisionWorkspaceRouteParams(
          decisionId === readyDecisionId
            ? 'ready'
            : decisionId === retroDecisionId
              ? 'retrospective'
              : 'review',
        ),
        runId: presentation.runId!,
        recipeRun: workspaceRecipeRunId,
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };

  return (
    <View style={styles.workspaceCockpitPanel}>
      <View style={styles.workspaceCockpitHeader}>
        <View style={styles.workspaceCockpitTitleBlock}>
          <Text style={styles.workspaceCockpitTitle}>
            {presentation.kind === 'retrospective'
              ? 'Retro cockpit'
              : presentation.kind === 'ready'
                ? 'Ready cockpit'
                : 'Review cockpit'}
          </Text>
          <Text style={styles.workspaceCockpitMeta} numberOfLines={1}>
            {presentation.ticketOrPr ?? presentation.runId} · {presentation.kindLabel}
          </Text>
        </View>
        <DecisionCockpitAction
          label="Terminal"
          onPress={() => {
            if (!presentation.terminalSlotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: presentation.terminalSlotId,
                ...decisionRouteContext,
                runId: presentation.runId!,
                details: '1',
                recipeRun: workspaceRecipeRunId,
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
          disabled={!hasTerminal}
          primary
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.workspaceCockpitRail}
      >
        <DecisionCockpitTile
          label="Signals"
          value={String(presentation.highlights.length)}
          hint={presentation.kindLabel}
          onPress={onJumpSignals}
          disabled={presentation.highlights.length === 0}
        />
        <DecisionCockpitTile
          label="Evidence section"
          value={String(presentation.artifactManifest.length)}
          hint={evidenceHint}
          onPress={onJumpEvidence}
          disabled={presentation.artifactManifest.length === 0}
        />
        <DecisionCockpitTile
          label="Ready gate"
          value={
            readyDecisionId ? (readyDecisionId === currentDecisionId ? 'current' : 'open') : '-'
          }
          hint={readyDecisionId ? gateHint : undefined}
          onPress={() => openDecision(readyDecisionId)}
          disabled={!readyDecisionId || readyDecisionId === currentDecisionId}
        />
        <DecisionCockpitTile
          label="Review gate"
          value={
            reviewDecisionId ? (reviewDecisionId === currentDecisionId ? 'current' : 'open') : '-'
          }
          hint={reviewDecisionId ? gateHint : undefined}
          onPress={() => openDecision(reviewDecisionId)}
          disabled={!reviewDecisionId || reviewDecisionId === currentDecisionId}
        />
        <DecisionCockpitTile
          label="Retro gate"
          value={
            retroDecisionId ? (retroDecisionId === currentDecisionId ? 'current' : 'open') : '-'
          }
          hint={retroDecisionId ? gateHint : undefined}
          onPress={() => openDecision(retroDecisionId)}
          disabled={!retroDecisionId || retroDecisionId === currentDecisionId}
        />
        <DecisionCockpitTile
          label="PR"
          value={presentation.prNumber ? `#${presentation.prNumber}` : '-'}
          onPress={openPR}
          disabled={!presentation.prNumber}
        />
        <DecisionCockpitTile
          label="Slot"
          value={presentation.slotId ?? '-'}
          onPress={openSlot}
          disabled={!presentation.slotId}
        />
        <DecisionCockpitTile
          label="Progress"
          value={progressValue}
          onPress={onJumpProgress}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
          hint={progressMeta}
        />
        <DecisionCockpitTile
          label="Before→After"
          value={String(visualPairCount)}
          hint={diffValue}
          onPress={openCompareArtifacts}
          disabled={visualPairCount === 0}
        />
        <DecisionCockpitTile
          label="Diff view"
          value={diffValue}
          onPress={openDiff}
          disabled={!diffAvailable && !presentation.slotId}
        />
        <DecisionCockpitTile
          label="Report section"
          value={String(presentation.textSections.length)}
          onPress={onJumpReports}
          disabled={presentation.textSections.length === 0}
        />
        <DecisionCockpitTile
          label="Action section"
          value={String(presentation.actions.length)}
          onPress={onJumpActions}
          disabled={presentation.actions.length === 0}
        />
        <DecisionCockpitTile
          label="Artifact files"
          value={String(presentation.artifactManifest.length)}
          onPress={openDecisionArtifacts}
        />
        <DecisionCockpitTile
          label="Recipe files"
          value={
            recipeArtifactCount === null
              ? 'loading'
              : recipeAvailable
                ? String(recipeArtifactCount)
                : '-'
          }
          hint={recipeAvailable ? `${recipeScopeLabel} recipe scope` : undefined}
          onPress={openRecipeArtifacts}
          disabled={recipeAvailable === false}
        />
        <DecisionCockpitTile
          label="Terminal section"
          value={hasTerminal ? 'ready' : '-'}
          onPress={onJumpTerminal}
          disabled={!hasTerminal}
        />
        <DecisionCockpitTile
          label="Family"
          value={presentation.familyId ? shortId(presentation.familyId) : '-'}
          onPress={() =>
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: presentation.familyId!,
                ...((sourceRun?.project ?? presentation.project)
                  ? { project: sourceRun?.project ?? presentation.project }
                  : {}),
                ...familySectionRouteContextParams(
                  presentation.kind === 'retrospective' ? 'retros' : 'focus',
                  decisionRouteContext.decisionKind,
                ),
                runId: presentation.runId!,
                recipeRun: workspaceRecipeRunId,
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                section: presentation.kind === 'retrospective' ? 'retros' : 'focus',
              },
            })
          }
          disabled={!presentation.familyId}
        />
        <DecisionCockpitTile
          label="Run"
          value={shortId(presentation.runId)}
          onPress={() =>
            router.push({
              pathname: '/run/[id]',
              params: {
                id: presentation.runId!,
                ...decisionRouteContext,
                recipeRun: workspaceRecipeRunId,
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            })
          }
        />
      </ScrollView>
    </View>
  );
}

function DecisionRecipeEvidenceSection({
  runId,
  recipeArtifactCount,
  recipeAvailable,
  previewArtifacts,
  primaryPair,
  authHeaders,
  gatewayUrl,
  onOpenRecipeArtifacts,
  onOpenRecipeArtifact,
}: {
  runId: string;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  previewArtifacts: ArtifactManifestEntry[];
  primaryPair: VisualArtifactPair | null;
  authHeaders: Record<string, string>;
  gatewayUrl: string;
  onOpenRecipeArtifacts: () => void;
  onOpenRecipeArtifact: (
    artifactPath: string,
    recipeRunId: string,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => void;
}) {
  const recipeCountLabel =
    recipeArtifactCount === null ? 'loading' : recipeAvailable ? String(recipeArtifactCount) : '-';

  return (
    <View style={styles.section}>
      <View style={styles.recipeEvidenceHeader}>
        <View style={styles.recipeEvidenceTitleBlock}>
          <Text style={styles.sectionTitle}>Recipe evidence</Text>
          <Text style={styles.recipeEvidenceMeta}>
            {recipeCountLabel} recipe artifact{recipeArtifactCount === 1 ? '' : 's'} available from
            this gate.
          </Text>
        </View>
        <Pressable style={styles.recipeEvidenceOpenButton} onPress={onOpenRecipeArtifacts}>
          <Text style={styles.recipeEvidenceOpenText}>Recipe files</Text>
        </Pressable>
      </View>

      {primaryPair ? (
        <View style={styles.recipePairPreview}>
          <BeforeAfterPreview
            pair={primaryPair}
            authHeaders={authHeaders}
            onOpenArtifact={(artifactPath) => {
              const target = [primaryPair.before, primaryPair.after].find(
                (artifact) => artifact.path === artifactPath,
              );
              onOpenRecipeArtifact(
                artifactPath,
                target?.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                artifactFilterParamForWorkspaceNav('compare'),
              );
            }}
            eyebrow="Recipe evidence"
            title="Recipe before → after"
            hint="Tap side"
            imageHeight={72}
          />
        </View>
      ) : null}

      {previewArtifacts.length > 0 ? (
        <View style={styles.recipePreviewStrip}>
          {previewArtifacts.map((artifact) => {
            const mediaType = classifyArtifact(artifact);
            const recipeRunId = artifact.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
            const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
            return (
              <Pressable
                key={`${recipeRunId}:${artifact.path}`}
                style={styles.recipePreviewTile}
                onPress={() =>
                  onOpenRecipeArtifact(
                    artifact.path,
                    recipeRunId,
                    isDiffArtifact
                      ? artifactFilterParamForWorkspaceNav('compare')
                      : artifactFilterParamForWorkspaceNav('recipe'),
                  )
                }
              >
                {mediaType === 'image' ? (
                  <Image
                    source={artifactSource(
                      artifactUrlForEntry(gatewayUrl, runId, artifact),
                      authHeaders,
                    )}
                    style={styles.recipePreviewImage}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.recipePreviewDocument}>
                    <Text style={styles.recipePreviewKind}>
                      {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text style={styles.recipePreviewPath} numberOfLines={1}>
                  {artifact.path.split('/').pop() ?? artifact.path}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text style={baseStyles.textMuted}>
          Recipe runs are present, but no previewable recipe artifacts were found.
        </Text>
      )}
    </View>
  );
}

function DecisionCockpitTile({
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
      style={[styles.workspaceCockpitTile, disabled && styles.workspaceCockpitDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.workspaceCockpitTileLabel}>{label}</Text>
      <Text style={styles.workspaceCockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.workspaceCockpitTileHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

function DecisionCockpitAction({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.workspaceCockpitAction,
        primary && styles.workspaceCockpitActionPrimary,
        disabled && styles.workspaceCockpitDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text
        style={[
          styles.workspaceCockpitActionText,
          primary && styles.workspaceCockpitActionTextPrimary,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function decisionDetailFromRun(run: Run, decision: RunDecision): DecisionDetail {
  return {
    ...decision,
    slotId: run.slotId,
    context: {
      ...decision.context,
      runId: run.id,
      familyId: run.familyId,
      ticketOrPr: run.ticketOrPr,
      slotId: run.slotId,
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
  };
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function groupArtifacts(
  manifest: ArtifactManifestEntry[],
  gatewayUrl: string,
  runId: string | null,
): VisualArtifactPair[] {
  if (!runId) return [];
  return groupVisualArtifactPairs(manifest, (artifact) =>
    artifactUrlForEntry(gatewayUrl, runId, artifact),
  ).pairs;
}

function recipeRunIdForVisualPair(
  recipeRuns: RecipeRunArtifactGroup[],
  pair: VisualArtifactPair | null,
): string {
  if (!pair) return recipeRuns[0]?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
  const directRecipeRunId = pair.after.recipeRunId ?? pair.before.recipeRunId;
  if (directRecipeRunId) return directRecipeRunId;
  const sourceGroup = recipeRuns.find((group) => {
    const artifacts = artifactsForRecipeRun(group);
    return artifacts.some(
      (artifact) => artifact.path === pair.before.path || artifact.path === pair.after.path,
    );
  });
  return sourceGroup?.id ?? recipeRuns[0]?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
}

function signalTarget(
  label: string,
  runId: string | null,
  diffPath?: string,
  compareArtifactPath?: string,
  compareRecipeRunId = DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  decisionRouteContext: ReturnType<typeof decisionWorkspaceRouteParams> = {},
) {
  if (!runId) return null;
  const target = workspaceSignalTargetForDecisionLabel(label);
  if (target === 'diff') {
    return {
      pathname: '/diff/[runId]' as const,
      params: {
        runId,
        ...targetWorkspaceRouteContextParams('diff', decisionRouteContext.decisionKind),
        path: diffPath ?? '',
        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
      },
    };
  }
  if (target === 'artifacts' || target === 'compare') {
    return {
      pathname: '/artifacts/[runId]' as const,
      params: {
        runId,
        ...decisionRouteContext,
        recipeRun: target === 'compare' ? compareRecipeRunId : DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        filter:
          target === 'compare'
            ? artifactFilterParamForWorkspaceNav('compare')
            : artifactFilterParamForWorkspaceNav('review'),
        ...(target === 'compare' && compareArtifactPath ? { artifact: compareArtifactPath } : {}),
      },
    };
  }
  return null;
}

function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length <= 10 ? value : `${value.slice(0, 8)}…`;
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center', gap: spacing.lg },
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
    borderLeftWidth: 4,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kindBadge: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: 4 },
  kindText: { fontSize: fonts.sizeSm, fontWeight: '800', textTransform: 'uppercase' },
  ageText: { color: colors.textMuted, fontSize: fonts.sizeXs },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXl,
    fontWeight: '800',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.lg },
  metaItem: { flexBasis: '48%', flexGrow: 1 },
  metaLabel: { color: colors.textMuted, fontSize: fonts.sizeXs, marginBottom: spacing.xs },
  metaValue: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '600' },
  workspaceCockpitPanel: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '33',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.xl,
    padding: spacing.sm,
  },
  beforeAfterPriorityPanel: {
    backgroundColor: colors.accent + '10',
    borderColor: colors.accent + '44',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.xl,
    padding: spacing.sm,
  },
  beforeAfterPriorityActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  beforeAfterPriorityCopy: {
    color: colors.textMuted,
    flex: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  beforeAfterPriorityButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  beforeAfterPriorityButtonText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  beforeAfterPriorityRail: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  workspaceCockpitHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  workspaceCockpitTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  workspaceCockpitTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceCockpitMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  workspaceCockpitRail: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  workspaceCockpitTile: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 104,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  workspaceCockpitTileLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workspaceCockpitTileValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  workspaceCockpitTileHint: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 2,
    maxWidth: 110,
  },
  workspaceCockpitAction: {
    backgroundColor: colors.accent + '14',
    borderColor: colors.accent + '44',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  workspaceCockpitActionPrimary: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
  },
  workspaceCockpitActionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  workspaceCockpitActionTextPrimary: {
    color: colors.textPrimary,
  },
  workspaceCockpitDisabled: {
    opacity: 0.45,
  },
  focusedArtifactCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.statusWarn + '66',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    marginBottom: spacing.xl,
    padding: spacing.md,
  },
  focusedArtifactHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  focusedArtifactTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  focusedArtifactEyebrow: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  focusedArtifactPath: {
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  focusedArtifactMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  focusedArtifactActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  errorText: { color: colors.statusFail, marginBottom: spacing.lg },
  section: { marginBottom: spacing.xl },
  recipeEvidenceHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  recipeEvidenceTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  recipeEvidenceMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  recipeEvidenceOpenButton: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
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
  recipePairPreview: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '24',
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.md,
    padding: spacing.xs,
  },
  recipePreviewStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  recipePreviewTile: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing.xs,
    width: 92,
  },
  recipePreviewImage: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    height: 54,
    width: '100%',
  },
  recipePreviewDocument: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    height: 54,
    justifyContent: 'center',
    width: '100%',
  },
  recipePreviewKind: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  recipePreviewPath: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.md },
  signalChip: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.bgCard,
  },
  signalChipPressable: {
    backgroundColor: colors.bgCardHover,
  },
  signalLabel: { fontSize: fonts.sizeXs, fontWeight: '800', textTransform: 'uppercase' },
  signalValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  signalValue: { color: colors.textPrimary, fontSize: fonts.sizeSm },
  signalArrow: { fontSize: fonts.sizeMd, fontWeight: '900' },
  bullet: { color: colors.textPrimary, fontSize: fonts.sizeSm, marginBottom: spacing.sm },
  reportCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  reportTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  reportBody: {
    color: colors.textSecondary,
    fontFamily: 'Menlo',
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
  terminalButton: {
    backgroundColor: colors.accent + '25',
    borderRadius: radii.md,
    padding: spacing.lg,
  },
  terminalButtonText: { color: colors.accent, fontSize: fonts.sizeMd, fontWeight: '800' },
  actionButton: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  actionText: { color: '#fff', fontSize: fonts.sizeMd, fontWeight: '800' },
  actionDescription: { color: '#ffffffcc', fontSize: fonts.sizeSm, marginTop: spacing.sm },
  safetyCard: {
    backgroundColor: colors.statusWarn + '18',
    borderColor: colors.statusWarn + '55',
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  resolvedDecisionCard: {
    backgroundColor: colors.statusOk + '18',
    borderColor: colors.statusOk + '55',
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  safetyTitle: {
    color: colors.statusWarn,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    marginBottom: spacing.xs,
  },
  safetyText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
  secondaryButton: {
    backgroundColor: colors.accent + '25',
    borderRadius: radii.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  secondaryButtonText: { color: colors.accent, fontSize: fonts.sizeSm, fontWeight: '700' },
});
