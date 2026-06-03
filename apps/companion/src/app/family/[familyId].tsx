import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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
  type FamilyChangeLedgerEntry,
  type FamilyObservabilityArtifact,
  type FamilyObservabilityGetResult,
  type FamilyObservabilityRunSummary,
  type FamilyObservabilitySnapshot,
  Methods,
  type RecipeRunArtifactGroup,
  type RetrospectivePayload,
  type Run,
  type RunDecision,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import { ArtifactCard, ComparisonCard } from '../../components/ArtifactCard';
import { BeforeAfterPreview } from '../../components/BeforeAfterPreview';
import { DocumentViewer } from '../../components/DocumentViewer';
import { MediaViewer } from '../../components/MediaViewer';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { TaskProgressFallbackPanel, TaskProgressPanel } from '../../components/TaskProgressPanel';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrl,
  artifactUrlForEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
  type VisualArtifactPair,
} from '../../lib/artifact-url';
import { type DecisionPresentation, presentDecision } from '../../lib/decision-presentation';
import { diffArtifactCandidate } from '../../lib/diff';
import {
  buildFamilyEvidenceGroups,
  familyArtifactKind,
  type FamilyEvidenceFilter,
  type FamilyEvidenceGroup,
  familyEvidenceKindLabel,
  familyRunBadgeLabel,
  filterFamilyEvidenceGroups,
  MAX_ARTIFACTS_PER_FAMILY_EVIDENCE_GROUP,
} from '../../lib/family-evidence';
import { shouldRefreshFamilySnapshotForRunEvent } from '../../lib/family-refresh';
import { collectFamilyRetrospectives } from '../../lib/family-retrospectives';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { runRefreshEventRunId } from '../../lib/run-refresh';
import {
  selectSlotCompareTarget,
  selectSlotRecipeArtifactsForPreviewScope,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
  taskProgressPercent,
} from '../../lib/task-progress';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';
import {
  selectPrimaryWorkspaceDecision,
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  workspaceDecisionKind,
} from '../../lib/workspace-decisions';
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
  workspaceForFamilySection,
  workspaceNavCurrentForRoute,
  workspaceRouteContextParams,
  workspaceSignalTargetForDecisionLabel,
} from '../../lib/workspace-navigation';
import {
  type WorkspaceStickyNavLayout,
  workspaceStickyNavThreshold,
} from '../../lib/workspace-sticky-nav';
import { useConnectionStore } from '../../store/connection';

const STATUS_COLORS: Record<string, string> = {
  done: colors.statusOk,
  failed: colors.statusFail,
  cancelled: colors.statusWarn,
  monitoring: colors.lifecycleWorking,
  preparing: colors.lifecycleDispatching,
  dispatching: colors.lifecycleDispatching,
  paused: colors.statusWarn,
};

const TONE_COLORS: Record<DecisionPresentation['tone'], string> = {
  ok: colors.statusOk,
  warn: colors.statusWarn,
  fail: colors.statusFail,
  info: colors.accent,
};

const EVIDENCE_FILTERS: Array<{ id: FamilyEvidenceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
  { id: 'review', label: 'Review' },
  { id: 'diffs', label: 'Diffs' },
  { id: 'recipes', label: 'Recipes' },
  { id: 'setup', label: 'Setup' },
];

interface FamilyRecipeEvidenceSummary {
  artifactCount: number;
  pairCount: number;
  recipeRunId: string | null;
  artifactPath: string | null;
  primaryPair: VisualArtifactPair | null;
}

type FamilySectionKey = 'focus' | 'compare' | 'ledger' | 'retros' | 'evidence' | 'runs';
const FAMILY_SECTION_KEYS: readonly FamilySectionKey[] = [
  'focus',
  'compare',
  'ledger',
  'retros',
  'evidence',
  'runs',
];

function normalizeFamilySectionParam(
  value: string | string[] | undefined,
): FamilySectionKey | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  return FAMILY_SECTION_KEYS.includes(raw as FamilySectionKey) ? (raw as FamilySectionKey) : null;
}

function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default function FamilyDetailScreen() {
  const { familyId, project, runId, section, recipeRun, artifact, workspace, decisionKind } =
    useLocalSearchParams<{
      familyId: string;
      project?: string;
      runId?: string;
      section?: string;
      recipeRun?: string | string[];
      artifact?: string | string[];
      workspace?: string | string[];
      decisionKind?: string | string[];
    }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const [snapshot, setSnapshot] = useState<FamilyObservabilitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [documentViewer, setDocumentViewer] = useState<{ title: string; body: string } | null>(
    null,
  );
  const [evidenceFilter, setEvidenceFilter] = useState<FamilyEvidenceFilter>('all');
  const [selectedRecipeArtifactCount, setSelectedRecipeArtifactCount] = useState<number | null>(
    null,
  );
  const [selectedRecipeRuns, setSelectedRecipeRuns] = useState<RecipeRunArtifactGroup[]>([]);
  const [familyRecipeEvidence, setFamilyRecipeEvidence] = useState<
    Record<string, FamilyRecipeEvidenceSummary>
  >({});
  const [selectedFullRun, setSelectedFullRun] = useState<Run | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const [navLayout, setNavLayout] = useState<WorkspaceStickyNavLayout | null>(null);
  const [stickyNavVisible, setStickyNavVisibleState] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const sectionOffsetsRef = useRef<Partial<Record<FamilySectionKey, number>>>({});
  const pendingSectionRef = useRef<FamilySectionKey | null>(null);
  const documentAbortRef = useRef<AbortController | null>(null);
  const familyRefreshRequestRef = useRef(0);
  const familyRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRecipeRunsRequestRef = useRef(0);
  const selectedFullRunRequestRef = useRef(0);
  const scrollY = useSharedValue(0);
  const stickyNavVisibleRef = useRef(false);
  const requestedRecipeRunId = routeParamString(recipeRun).trim();
  const requestedArtifactPath = routeParamString(artifact).trim();
  const requestedSection = normalizeFamilySectionParam(section);
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        workspaceForFamilySection(requestedSection) ?? 'family',
      ),
    [decisionKind, requestedSection, workspace],
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
    return () => {
      documentAbortRef.current?.abort();
    };
  }, []);

  const refreshFamilySnapshot = useCallback(
    async (reason: string) => {
      if (!client || !familyId) return;
      const requestId = familyRefreshRequestRef.current + 1;
      familyRefreshRequestRef.current = requestId;
      try {
        const result = await client.request<FamilyObservabilityGetResult>(
          'family.observability.get',
          {
            familyId,
            ...(project ? { project } : {}),
          },
        );
        if (familyRefreshRequestRef.current !== requestId) return;
        setSnapshot(result.snapshot);
        setError(null);
      } catch (err) {
        if (familyRefreshRequestRef.current !== requestId) return;
        setError(`Failed to refresh family workspace after ${reason}: ${(err as Error).message}`);
      }
    },
    [client, familyId, project],
  );

  const scheduleFamilySnapshotRefresh = useCallback(
    (reason: string) => {
      if (familyRefreshTimerRef.current) clearTimeout(familyRefreshTimerRef.current);
      familyRefreshTimerRef.current = setTimeout(() => {
        familyRefreshTimerRef.current = null;
        void refreshFamilySnapshot(reason);
      }, 400);
    },
    [refreshFamilySnapshot],
  );

  useEffect(() => {
    setSnapshot(null);
    setFamilyRecipeEvidence({});
    setSelectedRecipeRuns([]);
    setSelectedRecipeArtifactCount(null);
    setSelectedFullRun(null);
    setTaskProgress(null);
    setTaskProgressError(null);
    void refreshFamilySnapshot('initial load');
  }, [refreshFamilySnapshot]);

  const familyRunIds = useMemo(
    () => (snapshot?.runs ?? []).map((run) => run.runId),
    [snapshot?.runs],
  );

  const selectedRun =
    snapshot?.runs.find((run) => run.runId === runId) ??
    snapshot?.runs.find((run) => run.runId === snapshot.latestRunId) ??
    snapshot?.runs[0] ??
    null;

  const refreshSelectedRecipeRuns = useCallback(
    async (
      reason: string,
      targetRunId: string | null = selectedRun?.runId ?? null,
      reset = false,
    ) => {
      const requestId = selectedRecipeRunsRequestRef.current + 1;
      selectedRecipeRunsRequestRef.current = requestId;
      if (!client || !targetRunId) {
        setSelectedRecipeArtifactCount(null);
        setSelectedRecipeRuns([]);
        return;
      }
      if (reset) {
        setSelectedRecipeArtifactCount(null);
        setSelectedRecipeRuns([]);
        setError(null);
      }
      try {
        const result = await client.request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
          runId: targetRunId,
        });
        if (selectedRecipeRunsRequestRef.current !== requestId) return;
        setSelectedRecipeRuns(result.recipeRuns);
        setSelectedRecipeArtifactCount(
          result.recipeRuns.reduce(
            (count, group) => count + artifactsForRecipeRun(group).length,
            0,
          ),
        );
      } catch (err) {
        if (selectedRecipeRunsRequestRef.current !== requestId) return;
        setSelectedRecipeArtifactCount(null);
        setSelectedRecipeRuns([]);
        setError(
          `Failed to refresh selected run recipe evidence after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, selectedRun?.runId],
  );

  const refreshSelectedFullRun = useCallback(
    async (
      reason: string,
      targetRunId: string | null = selectedRun?.runId ?? null,
      reset = false,
    ) => {
      const requestId = selectedFullRunRequestRef.current + 1;
      selectedFullRunRequestRef.current = requestId;
      if (!client || !targetRunId) {
        setSelectedFullRun(null);
        return;
      }
      if (reset) setSelectedFullRun(null);
      try {
        const result = await client.request<RunGetResult>('run.get', { runId: targetRunId });
        if (selectedFullRunRequestRef.current !== requestId) return;
        setSelectedFullRun(result.run);
      } catch (err) {
        if (selectedFullRunRequestRef.current !== requestId) return;
        setSelectedFullRun(null);
        setTaskProgress(null);
        setTaskProgressError(null);
        setError(
          `Failed to refresh selected run progress context after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, selectedRun?.runId],
  );

  useEffect(() => {
    if (!client || !familyId) return;
    const shouldRefresh = (payload: unknown) =>
      shouldRefreshFamilySnapshotForRunEvent(
        { familyId, project, runIds: familyRunIds },
        payload as { run?: Run; runId?: string },
      );
    const handleRunEvent = (payload: unknown, reason: string) => {
      if (!shouldRefresh(payload)) return;
      scheduleFamilySnapshotRefresh(reason);
      const event = payload as { run?: Run; runId?: string };
      const eventRunId = runRefreshEventRunId(event);
      if (!selectedRun?.runId || eventRunId !== selectedRun.runId) return;
      if (event.run?.id === selectedRun.runId) {
        selectedFullRunRequestRef.current += 1;
        setSelectedFullRun(event.run);
      } else {
        void refreshSelectedFullRun(reason, selectedRun.runId, false);
      }
      void refreshSelectedRecipeRuns(reason, selectedRun.runId, false);
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
      client.subscribe(Events.RUN_DECISION_UPDATED, (payload) =>
        handleRunEvent(payload, 'run.decision.updated'),
      ),
      client.subscribe(Events.RUN_DECISION_RESOLVED, (payload) =>
        handleRunEvent(payload, 'run.decision.resolved'),
      ),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      if (familyRefreshTimerRef.current) {
        clearTimeout(familyRefreshTimerRef.current);
        familyRefreshTimerRef.current = null;
      }
    };
  }, [
    client,
    familyId,
    familyRunIds,
    project,
    refreshSelectedFullRun,
    refreshSelectedRecipeRuns,
    scheduleFamilySnapshotRefresh,
    selectedRun?.runId,
  ]);

  useEffect(() => {
    if (!client || !familyId) return;
    const timer = setInterval(() => {
      void refreshFamilySnapshot('poll');
    }, 30_000);
    return () => clearInterval(timer);
  }, [client, familyId, refreshFamilySnapshot]);

  useEffect(() => {
    return () => {
      if (familyRefreshTimerRef.current) clearTimeout(familyRefreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const runs = snapshot?.runs ?? [];
    if (!client || runs.length === 0) {
      setFamilyRecipeEvidence({});
      return;
    }

    let disposed = false;
    const runIds = runs.map((run) => run.runId);
    Promise.allSettled(
      runIds.map((familyRunId) =>
        client
          .request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', { runId: familyRunId })
          .then((result) => [familyRunId, result.recipeRuns] as const),
      ),
    )
      .then((results) => {
        if (disposed) return;
        const nextEvidence: Record<string, FamilyRecipeEvidenceSummary> = {};
        const failed = results.find((result) => result.status === 'rejected');
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const [familyRunId, recipeRuns] = result.value;
          nextEvidence[familyRunId] = summarizeFamilyRecipeEvidence(
            recipeRuns,
            gatewayUrl,
            familyRunId,
          );
        }
        setFamilyRecipeEvidence(nextEvidence);
        if (failed) {
          setError(`Failed to load family recipe evidence: ${(failed.reason as Error).message}`);
        }
      })
      .catch((err: Error) => {
        if (!disposed) setError(`Failed to load family recipe evidence: ${err.message}`);
      });

    return () => {
      disposed = true;
    };
  }, [client, gatewayUrl, snapshot?.runs]);

  useEffect(() => {
    if (!selectedRun?.runId) {
      selectedRecipeRunsRequestRef.current += 1;
      setSelectedRecipeArtifactCount(null);
      setSelectedRecipeRuns([]);
      return;
    }
    void refreshSelectedRecipeRuns('initial load', selectedRun.runId, true);
  }, [refreshSelectedRecipeRuns, selectedRun?.runId]);

  useEffect(() => {
    if (!selectedRun?.runId) {
      selectedFullRunRequestRef.current += 1;
      setSelectedFullRun(null);
      return;
    }
    void refreshSelectedFullRun('initial load', selectedRun.runId, true);
  }, [refreshSelectedFullRun, selectedRun?.runId]);

  const fetchTaskProgress = useCallback(() => {
    if (!client || !selectedFullRun?.slotId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, {
        slotId: selectedFullRun.slotId,
        runId: selectedFullRun.id,
      })
      .then((result) => {
        setTaskProgress(result.structured ?? null);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [client, selectedFullRun?.id, selectedFullRun?.slotId]);

  useEffect(() => {
    if (!client || !selectedFullRun) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(selectedFullRun, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, selectedFullRun]);

  useEffect(() => {
    if (!isWorkerProgressActive(selectedFullRun)) {
      setTaskProgress(null);
      setTaskProgressError(null);
      return;
    }
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTaskProgress, selectedFullRun]);

  const runForArtifact = useCallback(
    (artifact: FamilyObservabilityArtifact) => {
      const runs = snapshot?.runs ?? [];
      const sourceRunId = artifact.sourceRunId ?? artifact.runId;
      return (
        runs.find((run) => run.runId === sourceRunId) ??
        runs.find((run) => run.runId === artifact.runId) ??
        null
      );
    },
    [snapshot?.runs],
  );
  const evidenceGroups = useMemo(
    () => buildFamilyEvidenceGroups(snapshot, runForArtifact),
    [runForArtifact, snapshot],
  );
  const filteredEvidenceGroups = useMemo(
    () => filterFamilyEvidenceGroups(evidenceGroups, evidenceFilter),
    [evidenceFilter, evidenceGroups],
  );
  const evidenceCounts = useMemo(
    () => ({
      all: snapshot?.evidence.length ?? 0,
      before: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'before',
      ).length,
      after: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'after',
      ).length,
      review: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'review',
      ).length,
      diffs: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'diffs',
      ).length,
      recipes: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'recipes',
      ).length,
      setup: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'setup',
      ).length,
    }),
    [snapshot?.evidence],
  );
  const visualPairs = useMemo(
    () =>
      groupVisualArtifactPairs(snapshot?.evidence ?? [], (artifact) =>
        familyArtifactUrl(gatewayUrl, artifact),
      ).pairs,
    [gatewayUrl, snapshot?.evidence],
  );
  const selectedRecipeVisualPairs = useMemo(() => {
    if (!selectedRun?.runId || visualPairs.length > 0) return [];
    return groupVisualArtifactPairs(
      selectSlotRecipeArtifactsForPreviewScope(selectedRecipeRuns, null),
      (artifact) => artifactUrlForEntry(gatewayUrl, selectedRun.runId, artifact),
    ).pairs;
  }, [gatewayUrl, selectedRecipeRuns, selectedRun?.runId, visualPairs.length]);
  const visualViewerItems = useMemo(() => {
    const items = (snapshot?.evidence ?? [])
      .filter((artifact) => ['image', 'video'].includes(classifyArtifact(artifact)))
      .map((artifact) => ({
        uri: familyArtifactUrl(gatewayUrl, artifact),
        title: artifact.path,
        mediaType: classifyArtifact(artifact),
        authHeaders: artifactAuthHeaders,
      }));
    for (const pair of selectedRecipeVisualPairs) {
      for (const artifact of [pair.before, pair.after]) {
        items.push({
          uri: artifact.url,
          title: artifact.path,
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
  }, [artifactAuthHeaders, gatewayUrl, selectedRecipeVisualPairs, snapshot?.evidence]);
  const viewerIndex = viewerUri
    ? Math.max(
        0,
        visualViewerItems.findIndex((item) => item.uri === viewerUri),
      )
    : 0;

  const openDocument = useCallback(
    (artifact: FamilyObservabilityArtifact) => {
      documentAbortRef.current?.abort();
      const controller = new AbortController();
      documentAbortRef.current = controller;
      const url = familyArtifactUrl(gatewayUrl, artifact);
      fetch(url, { signal: controller.signal, headers: artifactAuthHeaders })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((body) =>
          setDocumentViewer({ title: artifact.path.split('/').pop() ?? artifact.path, body }),
        )
        .catch((err: Error) => {
          // Abort is the expected cleanup path when navigating or opening another document.
          if (err.name === 'AbortError') return;
          setError(`Failed to load ${artifact.path}: ${err.message}`);
        });
    },
    [artifactAuthHeaders, gatewayUrl],
  );

  const diffRouteContext = useCallback(
    (routeContext = workspaceRouteContext) =>
      targetWorkspaceRouteContextParams('diff', routeContext.decisionKind),
    [workspaceRouteContext],
  );
  const artifactRouteContext = useCallback(
    (
      recipeRunId: string | null | undefined,
      filterParam: string | null | undefined,
      routeContext = workspaceRouteContext,
    ) =>
      targetWorkspaceRouteContextParams(
        targetWorkspaceForArtifactRoute(recipeRunId, filterParam),
        routeContext.decisionKind,
      ),
    [workspaceRouteContext],
  );
  const targetRouteContext = useCallback(
    (
      targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
      routeContext = workspaceRouteContext,
    ) => targetWorkspaceRouteContextParams(targetWorkspace, routeContext.decisionKind),
    [workspaceRouteContext],
  );

  const openDiffArtifact = useCallback(
    (artifact: FamilyObservabilityArtifact, routeContext = workspaceRouteContext) => {
      router.push({
        pathname: '/diff/[runId]',
        params: {
          runId: artifact.runId,
          ...diffRouteContext(routeContext),
          path: artifact.path,
          recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        },
      });
    },
    [diffRouteContext, router, workspaceRouteContext],
  );
  const openFamilyRecipeArtifact = useCallback(
    (
      runIdValue: string,
      recipeRunId: string,
      artifactPath: string,
      filterParam?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
      routeContext = workspaceRouteContext,
    ) => {
      if (diffArtifactCandidate([{ path: artifactPath }])) {
        router.push({
          pathname: '/diff/[runId]',
          params: {
            runId: runIdValue,
            ...diffRouteContext(routeContext),
            recipeRun: recipeRunId,
            path: artifactPath,
          },
        });
        return;
      }
      router.push({
        pathname: '/artifacts/[runId]',
        params: {
          runId: runIdValue,
          ...artifactRouteContext(
            recipeRunId,
            filterParam ?? artifactFilterParamForWorkspaceNav('recipe'),
            routeContext,
          ),
          recipeRun: recipeRunId,
          artifact: artifactPath,
          filter: filterParam ?? artifactFilterParamForWorkspaceNav('recipe'),
        },
      });
    },
    [artifactRouteContext, diffRouteContext, router, workspaceRouteContext],
  );
  const openFamilyArtifactWorkspace = useCallback(
    (runIdValue: string, artifactPath?: string, routeContext = workspaceRouteContext) => {
      const filter =
        (artifactPath ? artifactFilterParamForArtifactPath(artifactPath) : undefined) ??
        artifactFilterParamForWorkspaceNav('review');
      if (artifactPath && diffArtifactCandidate([{ path: artifactPath }])) {
        router.push({
          pathname: '/diff/[runId]',
          params: {
            runId: runIdValue,
            ...diffRouteContext(routeContext),
            recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
            path: artifactPath,
          },
        });
        return;
      }
      router.push({
        pathname: '/artifacts/[runId]',
        params: {
          runId: runIdValue,
          ...artifactRouteContext(DECISION_EVIDENCE_RECIPE_RUN_PARAM, filter, routeContext),
          recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
          filter,
          ...(artifactPath ? { artifact: artifactPath } : {}),
        },
      });
    },
    [artifactRouteContext, diffRouteContext, router, workspaceRouteContext],
  );

  const scrollToSection = useCallback((sectionKey: FamilySectionKey): boolean => {
    const sectionOffset = sectionOffsetsRef.current[sectionKey];
    if (typeof sectionOffset !== 'number' || !scrollRef.current) return false;
    scrollRef.current.scrollTo({
      y: Math.max(0, sectionOffset - spacing.md),
      animated: true,
    });
    return true;
  }, []);

  const requestSectionScroll = useCallback(
    (sectionKey: FamilySectionKey) => {
      pendingSectionRef.current = sectionKey;
      if (scrollToSection(sectionKey)) {
        pendingSectionRef.current = null;
      }
    },
    [scrollToSection],
  );

  const rememberSection = useCallback(
    (section: FamilySectionKey) => (event: LayoutChangeEvent) => {
      sectionOffsetsRef.current[section] = event.nativeEvent.layout.y;
      if (pendingSectionRef.current !== section) return;
      requestAnimationFrame(() => {
        if (scrollToSection(section)) {
          pendingSectionRef.current = null;
        }
      });
    },
    [scrollToSection],
  );

  useEffect(() => {
    if (!requestedSection || !snapshot) return;
    requestSectionScroll(requestedSection);
  }, [requestSectionScroll, requestedSection, snapshot]);

  const goBackOrRuns = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/runs');
  }, [router]);

  if (!snapshot) {
    return (
      <>
        <Stack.Screen options={{ title: 'Family Workspace' }} />
        <View
          style={[
            baseStyles.container,
            styles.center,
            { paddingBottom: insets.bottom + spacing.xl },
          ]}
        >
          <Text style={baseStyles.textSecondary}>
            {error ?? (client ? 'Loading family workspace…' : 'Connect to gateway to load family.')}
          </Text>
          <Pressable style={styles.backFallbackButton} onPress={goBackOrRuns}>
            <Text style={styles.backFallbackText}>Back to runs</Text>
          </Pressable>
        </View>
      </>
    );
  }

  const workflowColor = workflowStateColor(snapshot.workflowState);
  const familyRetrospectives = collectFamilyRetrospectives(snapshot.runs);
  const pendingRetrospectiveCount = familyRetrospectives.filter(
    (entry) => !entry.decision.resolvedAt,
  ).length;
  const retrospectiveRouteContext = familySectionRouteContextParams(
    'retros',
    workspaceRouteContext.decisionKind,
  );
  const openPRForRun = (
    run: FamilyObservabilityRunSummary,
    routeContext = workspaceRouteContext,
  ) => {
    if (!run.prNumber) return;
    const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(run.prNumber),
        ...targetRouteContext('pr', routeContext),
        ...(prRepo ? { repo: prRepo } : {}),
      },
    });
  };
  const selectedActiveTaskProgress = isWorkerProgressActive(selectedFullRun)
    ? (effectiveTaskProgressForRun(selectedFullRun, taskProgress) ?? null)
    : null;
  const selectedFallbackTaskProgress =
    !selectedActiveTaskProgress && isWorkerProgressActive(selectedFullRun)
      ? fallbackTaskProgressSummary(selectedFullRun)
      : null;
  const primaryDecision = selectPrimaryWorkspaceDecision(selectedRun);
  const readyDecision = selectReadyWorkspaceDecision(selectedRun);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(selectedRun);
  const retroDecision = selectRetrospectiveWorkspaceDecision(selectedRun);
  const selectedRecipeAvailable = selectedRun
    ? selectedRecipeArtifactCount === null
      ? hasRecipeArtifacts(selectedRun)
        ? true
        : undefined
      : selectedRecipeArtifactCount > 0
    : undefined;
  const selectedDiffValue = selectedRun?.diffStat.available
    ? `+${selectedRun.diffStat.additions} -${selectedRun.diffStat.deletions}`
    : selectedRun?.slotId
      ? 'workspace'
      : 'none';
  const requestedArtifactIsDiff = Boolean(
    requestedArtifactPath && diffArtifactCandidate([{ path: requestedArtifactPath }]),
  );
  const recipeEvidenceForRun = (
    run: FamilyObservabilityRunSummary,
  ): FamilyRecipeEvidenceSummary | null => familyRecipeEvidence[run.runId] ?? null;
  const recipeCountForRun = (run: FamilyObservabilityRunSummary): number | null =>
    recipeEvidenceForRun(run)?.artifactCount ?? null;
  const recipeAvailableForRun = (run: FamilyObservabilityRunSummary): boolean | undefined => {
    const count = recipeCountForRun(run);
    if (count !== null) return count > 0;
    if (run.runId === selectedRun?.runId) return selectedRecipeAvailable;
    return hasRecipeArtifacts(run) ? true : undefined;
  };
  const decisionRouteContextForRun = (run: FamilyObservabilityRunSummary, decisionId: string) =>
    decisionWorkspaceRouteParams(
      workspaceDecisionKind((run.decisions ?? []).find((decision) => decision.id === decisionId)),
    );
  const workspaceRecipeRunForRun = (runIdValue: string): string =>
    runIdValue === selectedRun?.runId
      ? requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const focusedArtifactForRun = (runIdValue: string): string | undefined =>
    runIdValue === selectedRun?.runId && requestedArtifactPath ? requestedArtifactPath : undefined;
  const focusedArtifactParamsForRun = (runIdValue: string): { artifact?: string } => {
    const focusedArtifact = focusedArtifactForRun(runIdValue);
    return focusedArtifact ? { artifact: focusedArtifact } : {};
  };
  const recipeWorkspaceParamsForRun = (
    run: FamilyObservabilityRunSummary,
  ): { recipeRun: string; artifact?: string } => {
    const recipeEvidence = recipeEvidenceForRun(run);
    const recipeTarget =
      recipeEvidence?.recipeRunId ?? recipeWorkspaceParam(workspaceRecipeRunForRun(run.runId));
    const focusedArtifact = focusedArtifactForRun(run.runId);
    const artifact = shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifact)
      ? focusedArtifact
      : recipeEvidence?.artifactPath;
    return artifact ? { recipeRun: recipeTarget, artifact } : { recipeRun: recipeTarget };
  };
  const openFamilyRunDiff = (
    run: Pick<FamilyObservabilityRunSummary, 'runId' | 'diffStat' | 'slotId'>,
    routeContext = workspaceRouteContext,
  ) => {
    if (!run.diffStat.available && run.slotId) {
      router.push({
        pathname: '/diff/slot/[slotId]',
        params: {
          slotId: run.slotId,
          ...diffRouteContext(routeContext),
          ...(run.runId === selectedRun?.runId && requestedArtifactIsDiff
            ? { path: requestedArtifactPath }
            : {}),
        },
      });
      return;
    }
    router.push({
      pathname: '/diff/[runId]',
      params: {
        runId: run.runId,
        ...diffRouteContext(routeContext),
        recipeRun: workspaceRecipeRunForRun(run.runId),
        ...(run.runId === selectedRun?.runId && requestedArtifactIsDiff
          ? { path: requestedArtifactPath }
          : {}),
      },
    });
  };
  const openSelectedRunDiff = () => {
    if (!selectedRun) return;
    openFamilyRunDiff(selectedRun);
  };
  const priorityVisualPairs = visualPairs.length > 0 ? visualPairs : selectedRecipeVisualPairs;
  const priorityVisualPair = priorityVisualPairs[0] ?? null;
  const priorityVisualPairIsRecipe =
    visualPairs.length === 0 && selectedRecipeVisualPairs.length > 0;
  const priorityCompareRunId = priorityVisualPairIsRecipe
    ? (selectedRun?.runId ?? null)
    : (visualPairs[0]?.after.runId ?? null);
  const priorityCompareRecipeRunId = priorityVisualPairIsRecipe
    ? recipeRunIdForVisualPair(selectedRecipeRuns, priorityVisualPair)
    : DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const selectedReadyMeta = familyRunDecisionNavMeta({
    run: selectedRun,
    decision: readyDecision,
    diffValue: selectedDiffValue,
    visualPairCount: priorityVisualPairs.length,
  });
  const selectedReviewMeta = familyRunDecisionNavMeta({
    run: selectedRun,
    decision: reviewGateDecision,
    diffValue: selectedDiffValue,
    visualPairCount: priorityVisualPairs.length,
  });
  const selectedRetroMeta = familyRunDecisionNavMeta({
    run: selectedRun,
    decision: retroDecision,
    diffValue: selectedDiffValue,
    visualPairCount: priorityVisualPairs.length,
  });
  const workspaceNavCurrent: React.ComponentProps<typeof RunWorkspaceNav>['current'] =
    requestedSection === 'retros'
      ? 'familyRetros'
      : workspaceNavCurrentForRoute('family', workspaceRouteContext.workspace);
  const workspaceNavProps = {
    dense: true,
    current: workspaceNavCurrent,
    routeWorkspace: workspaceRouteContext.workspace,
    routeDecisionKind: workspaceRouteContext.decisionKind,
    decisionId: primaryDecision?.id ?? null,
    decisionKind: workspaceDecisionKind(primaryDecision),
    readyDecisionId: readyDecision?.id ?? null,
    reviewDecisionId: reviewGateDecision?.id ?? null,
    retroDecisionId: retroDecision?.id ?? null,
    readyMeta: selectedReadyMeta,
    reviewMeta: selectedReviewMeta,
    retroMeta: selectedRetroMeta,
    familyRetrospectiveCount: familyRetrospectives.length,
    pendingFamilyRetrospectiveCount: pendingRetrospectiveCount,
    familyId: snapshot.familyId,
    project: snapshot.project ?? project,
    prNumber: selectedRun?.prNumber ?? snapshot.latestPrNumber,
    prRepo: prRepoFromWorkspaceSource(
      selectedRun,
      selectedRun?.prNumber ?? snapshot.latestPrNumber,
    ),
    recipeRunId: selectedRun ? requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM : null,
    recipeAvailable: selectedRecipeAvailable,
    recipeArtifactCount: selectedRecipeArtifactCount,
    diffAvailable: selectedRun
      ? selectedRun.diffStat.available || Boolean(selectedRun.slotId)
      : snapshot.diffStat.available,
    artifactCount: selectedRun ? selectedRun.artifacts.length : snapshot.evidence.length,
    visualPairCount: priorityVisualPairs.length,
    compareArtifactPath: priorityVisualPair?.after.path ?? null,
    compareRunId: priorityCompareRunId,
    compareRecipeRunId: priorityCompareRecipeRunId,
    artifactPath: requestedArtifactPath || null,
    slotId: selectedRun?.slotId,
    runId: selectedRun?.runId ?? snapshot.latestRunId,
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Family Workspace' }} />
      <View style={baseStyles.container}>
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
          <View style={styles.headerCard}>
            <View style={styles.headerRow}>
              <View style={[styles.statusBadge, { borderColor: workflowColor }]}>
                <Text style={[styles.statusText, { color: workflowColor }]}>
                  {snapshot.workflowState}
                </Text>
              </View>
              <Text style={styles.generatedText}>{formatDateTime(snapshot.generatedAt)}</Text>
            </View>
            <Text style={styles.title}>{snapshot.familyRootTicketOrPr}</Text>
            <Text style={baseStyles.textSecondary}>{snapshot.summary}</Text>
            <View style={styles.metricGrid}>
              <Metric label="Runs" value={String(snapshot.familyRunCount)} />
              <Metric label="Active" value={String(snapshot.activeRunCount)} />
              <Metric
                label="Evidence files"
                value={String(snapshot.evidence.length)}
                onPress={() => scrollToSection('evidence')}
              />
              <Metric
                label="Before→After"
                value={String(visualPairs.length)}
                onPress={() => scrollToSection('compare')}
                disabled={visualPairs.length === 0}
              />
              <Metric
                label="Diff view"
                value={
                  snapshot.diffStat.available
                    ? `+${snapshot.diffStat.additions} -${snapshot.diffStat.deletions}`
                    : 'none'
                }
                onPress={() => scrollToSection('ledger')}
                disabled={!snapshot.diffStat.available}
              />
              <Metric
                label="Retrospectives"
                value={`${pendingRetrospectiveCount}/${familyRetrospectives.length}`}
                onPress={() => scrollToSection('retros')}
                disabled={familyRetrospectives.length === 0}
              />
              <Metric
                label="Recipe quality"
                value={`${snapshot.recipeQuality.semantic}${
                  snapshot.recipeQuality.score != null ? ` · ${snapshot.recipeQuality.score}` : ''
                }`}
                onPress={() => {
                  if (!selectedRun) return;
                  const recipeTarget = recipeWorkspaceParam(
                    workspaceRecipeRunForRun(selectedRun.runId),
                  );
                  const focusedArtifact = focusedArtifactForRun(selectedRun.runId);
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...targetRouteContext('recipe'),
                      recipeRun: recipeTarget,
                      filter: artifactFilterParamForWorkspaceNav('recipe'),
                      ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifact)
                        ? { artifact: focusedArtifact }
                        : {}),
                    },
                  });
                }}
                disabled={!selectedRun || selectedRecipeAvailable === false}
              />
            </View>
          </View>

          <View onLayout={rememberNavLayout}>
            <RunWorkspaceNav {...workspaceNavProps} />
          </View>

          {selectedRun && requestedArtifactPath ? (
            <FamilyFocusedArtifactCard
              artifactPath={requestedArtifactPath}
              recipeRunId={requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM}
              prNumber={selectedRun.prNumber}
              onOpenRun={() =>
                router.push({
                  pathname: '/run/[id]',
                  params: {
                    id: selectedRun.runId,
                    ...targetRouteContext('run'),
                    recipeRun: requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    artifact: requestedArtifactPath,
                  },
                })
              }
              onOpenRecipe={() => {
                const recipeRunTarget = recipeWorkspaceParam(requestedRecipeRunId);
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('recipe'),
                    recipeRun: recipeRunTarget,
                    filter: artifactFilterParamForWorkspaceNav('recipe'),
                    ...(shouldPreserveArtifactForRecipeContext(
                      recipeRunTarget,
                      requestedArtifactPath,
                    )
                      ? { artifact: requestedArtifactPath }
                      : {}),
                  },
                });
              }}
              onOpenArtifact={() =>
                openFamilyArtifactWorkspace(selectedRun.runId, requestedArtifactPath)
              }
              onOpenFiles={() =>
                openFamilyArtifactWorkspace(selectedRun.runId, requestedArtifactPath)
              }
              onOpenDiff={() => openFamilyRunDiff(selectedRun)}
              comparePairCount={priorityVisualPairs.length}
              onOpenCompare={() => {
                if (!priorityVisualPair) return;
                if (!priorityVisualPairIsRecipe) {
                  scrollToSection('compare');
                  return;
                }
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('compare'),
                    recipeRun: priorityCompareRecipeRunId,
                    filter: artifactFilterParamForWorkspaceNav('compare'),
                    artifact: priorityVisualPair.after.path,
                  },
                });
              }}
              onOpenSlot={() => {
                if (!selectedRun.slotId) return;
                router.push({
                  pathname: '/slot/[id]',
                  params: {
                    id: selectedRun.slotId,
                    ...targetRouteContext('slot'),
                    runId: selectedRun.runId,
                    recipeRun: requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    artifact: requestedArtifactPath,
                  },
                });
              }}
              onOpenTerminal={() => {
                if (!selectedRun.slotId) return;
                router.push({
                  pathname: '/terminal/[slotId]',
                  params: {
                    slotId: selectedRun.slotId,
                    ...targetRouteContext('terminal'),
                    runId: selectedRun.runId,
                    details: '1',
                    recipeRun: requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    artifact: requestedArtifactPath,
                  },
                });
              }}
              onOpenPR={() => {
                if (!selectedRun.prNumber) return;
                const prRepo = prRepoFromWorkspaceSource(selectedRun, selectedRun.prNumber);
                router.push({
                  pathname: '/(tabs)/prs',
                  params: {
                    pr: String(selectedRun.prNumber),
                    ...targetRouteContext('pr'),
                    ...(prRepo ? { repo: prRepo } : {}),
                  },
                });
              }}
              slotAvailable={Boolean(selectedRun.slotId)}
            />
          ) : null}

          {priorityVisualPair ? (
            <FamilyBeforeAfterPriorityPanel
              pair={priorityVisualPair}
              pairCount={priorityVisualPairs.length}
              authHeaders={artifactAuthHeaders}
              recipeFallback={priorityVisualPairIsRecipe}
              artifactCount={snapshot.evidence.length}
              recipeArtifactCount={selectedRecipeArtifactCount}
              recipeAvailable={selectedRecipeAvailable}
              diffValue={
                selectedRun
                  ? selectedDiffValue
                  : snapshot.diffStat.available
                    ? `+${snapshot.diffStat.additions} -${snapshot.diffStat.deletions}`
                    : 'none'
              }
              slotId={selectedRun?.slotId}
              prNumber={selectedRun?.prNumber ?? snapshot.latestPrNumber}
              onOpenArtifact={(artifactPath) => {
                const target = [priorityVisualPair.before, priorityVisualPair.after].find(
                  (artifact) => artifact.path === artifactPath,
                );
                if (!target) return;
                if (priorityVisualPairIsRecipe) {
                  if (!selectedRun) return;
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...targetRouteContext('compare'),
                      recipeRun: priorityCompareRecipeRunId,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      artifact: target.path,
                    },
                  });
                  return;
                }
                openFamilyArtifactWorkspace(
                  (target as FamilyObservabilityArtifact).runId,
                  target.path,
                );
              }}
              onOpenCompare={() => {
                if (!priorityVisualPairIsRecipe) {
                  scrollToSection('compare');
                  return;
                }
                if (!selectedRun) return;
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('compare'),
                    recipeRun: priorityCompareRecipeRunId,
                    filter: artifactFilterParamForWorkspaceNav('compare'),
                    artifact: priorityVisualPair.after.path,
                  },
                });
              }}
              onOpenEvidence={() => {
                if (selectedRun) {
                  openFamilyArtifactWorkspace(selectedRun.runId);
                  return;
                }
                scrollToSection('evidence');
              }}
              onOpenRecipe={() => {
                if (!selectedRun) return;
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('recipe'),
                    ...recipeWorkspaceParamsForRun(selectedRun),
                    filter: artifactFilterParamForWorkspaceNav('recipe'),
                  },
                });
              }}
              onOpenDiff={() => {
                if (selectedRun) {
                  openSelectedRunDiff();
                  return;
                }
                scrollToSection('ledger');
              }}
              onOpenRun={() => {
                if (!selectedRun) return;
                router.push({
                  pathname: '/run/[id]',
                  params: {
                    id: selectedRun.runId,
                    ...targetRouteContext('run'),
                    recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                    ...focusedArtifactParamsForRun(selectedRun.runId),
                  },
                });
              }}
              onOpenRetros={() => scrollToSection('retros')}
              onOpenTerminal={() => {
                if (!selectedRun?.slotId) return;
                router.push({
                  pathname: '/terminal/[slotId]',
                  params: {
                    slotId: selectedRun.slotId,
                    ...targetRouteContext('terminal'),
                    runId: selectedRun.runId,
                    details: '1',
                    recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                    ...focusedArtifactParamsForRun(selectedRun.runId),
                  },
                });
              }}
              onOpenPR={() => {
                if (!selectedRun) return;
                openPRForRun(selectedRun);
              }}
            />
          ) : null}

          <FamilyWorkspaceCockpit
            selectedRun={selectedRun}
            readyDecisionId={readyDecision?.id ?? null}
            reviewDecisionId={reviewGateDecision?.id ?? null}
            retroDecisionId={retroDecision?.id ?? null}
            evidenceCount={snapshot.evidence.length}
            visualPairCount={priorityVisualPairs.length}
            ledgerEntryCount={snapshot.familyChangeLedger?.entries.length ?? 0}
            retrospectiveCount={familyRetrospectives.length}
            pendingRetrospectiveCount={pendingRetrospectiveCount}
            recipeArtifactCount={selectedRecipeArtifactCount}
            recipeAvailable={selectedRecipeAvailable}
            recipeScopeLabel={recipeWorkspaceScopeLabel(
              selectedRun ? workspaceRecipeRunForRun(selectedRun.runId) : null,
            )}
            diffValue={selectedRun ? selectedDiffValue : 'none'}
            onJumpFocus={() => scrollToSection('focus')}
            onJumpCompare={() => {
              if (!priorityVisualPairIsRecipe) {
                scrollToSection('compare');
                return;
              }
              if (!selectedRun || !priorityVisualPair) return;
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: selectedRun.runId,
                  ...targetRouteContext('compare'),
                  recipeRun: priorityCompareRecipeRunId,
                  filter: artifactFilterParamForWorkspaceNav('compare'),
                  artifact: priorityVisualPair.after.path,
                },
              });
            }}
            onJumpLedger={() => scrollToSection('ledger')}
            onJumpRetros={() => scrollToSection('retros')}
            onJumpEvidence={() => scrollToSection('evidence')}
            onJumpRuns={() => scrollToSection('runs')}
            onOpenRun={() => {
              if (!selectedRun) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/run/[id]',
                params: {
                  id: selectedRun.runId,
                  ...targetRouteContext('run'),
                  recipeRun: contextRecipeRun,
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
            onOpenArtifacts={() => {
              if (!selectedRun) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: selectedRun.runId,
                  ...artifactRouteContext(
                    contextRecipeRun,
                    contextRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                      ? artifactFilterParamForWorkspaceNav('recipe')
                      : artifactFilterParamForWorkspaceNav('review'),
                  ),
                  recipeRun: contextRecipeRun,
                  filter:
                    contextRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                      ? artifactFilterParamForWorkspaceNav('recipe')
                      : artifactFilterParamForWorkspaceNav('review'),
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
            onOpenRecipe={() => {
              if (!selectedRun) return;
              const recipeTarget = recipeWorkspaceParam(
                workspaceRecipeRunForRun(selectedRun.runId),
              );
              const focusedArtifact = focusedArtifactForRun(selectedRun.runId);
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: selectedRun.runId,
                  ...targetRouteContext('recipe'),
                  recipeRun: recipeTarget,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                  ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifact)
                    ? { artifact: focusedArtifact }
                    : {}),
                },
              });
            }}
            onOpenDiff={() => {
              openSelectedRunDiff();
            }}
            onOpenSlot={() => {
              if (!selectedRun?.slotId) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/slot/[id]',
                params: {
                  id: selectedRun.slotId,
                  ...targetRouteContext('slot'),
                  runId: selectedRun.runId,
                  recipeRun: contextRecipeRun,
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
            onOpenPR={() => {
              if (!selectedRun) return;
              openPRForRun(selectedRun);
            }}
            onOpenTerminal={() => {
              if (!selectedRun?.slotId) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/terminal/[slotId]',
                params: {
                  slotId: selectedRun.slotId,
                  ...targetRouteContext('terminal'),
                  runId: selectedRun.runId,
                  details: '1',
                  recipeRun: contextRecipeRun,
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
            onOpenDecision={(decisionId) => {
              if (!selectedRun) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/decision/[id]',
                params: {
                  id: decisionId,
                  ...decisionRouteContextForRun(selectedRun, decisionId),
                  runId: selectedRun.runId,
                  recipeRun: contextRecipeRun,
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
          />
          {selectedRun ? (
            <View onLayout={rememberSection('focus')}>
              <FamilyRunWorkspaceCard
                run={selectedRun}
                activeRunId={selectedRun.runId}
                onFocusRun={() =>
                  router.setParams({ familyId: snapshot.familyId, runId: selectedRun.runId })
                }
                onOpenRun={() =>
                  router.push({
                    pathname: '/run/[id]',
                    params: {
                      id: selectedRun.runId,
                      ...targetRouteContext('run'),
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  })
                }
                onOpenArtifacts={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...artifactRouteContext(
                        workspaceRecipeRunForRun(selectedRun.runId),
                        workspaceRecipeRunForRun(selectedRun.runId) !==
                          DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? artifactFilterParamForWorkspaceNav('recipe')
                          : artifactFilterParamForWorkspaceNav('review'),
                      ),
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      filter:
                        workspaceRecipeRunForRun(selectedRun.runId) !==
                        DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? artifactFilterParamForWorkspaceNav('recipe')
                          : artifactFilterParamForWorkspaceNav('review'),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  })
                }
                onOpenArtifact={(artifactPath) =>
                  openFamilyArtifactWorkspace(selectedRun.runId, artifactPath)
                }
                gatewayUrl={gatewayUrl}
                artifactAuthHeaders={artifactAuthHeaders}
                recipeArtifactCount={selectedRecipeArtifactCount}
                recipeAvailable={selectedRecipeAvailable}
                selectedFullRun={selectedFullRun}
                activeTaskProgress={selectedActiveTaskProgress}
                fallbackTaskProgress={selectedFallbackTaskProgress}
                taskProgressError={taskProgressError}
                recipeRuns={selectedRecipeRuns}
                onOpenVisual={setViewerUri}
                onOpenDocument={openDocument}
                onOpenDiffArtifact={openDiffArtifact}
                onOpenRecipe={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...targetRouteContext('recipe'),
                      recipeRun: recipeWorkspaceParam(workspaceRecipeRunForRun(selectedRun.runId)),
                      filter: artifactFilterParamForWorkspaceNav('recipe'),
                      ...(shouldPreserveArtifactForRecipeContext(
                        recipeWorkspaceParam(workspaceRecipeRunForRun(selectedRun.runId)),
                        focusedArtifactForRun(selectedRun.runId),
                      )
                        ? { artifact: focusedArtifactForRun(selectedRun.runId) }
                        : {}),
                    },
                  })
                }
                onOpenRecipeArtifact={(recipeRunId, artifactPath, filterParam) =>
                  openFamilyRecipeArtifact(
                    selectedRun.runId,
                    recipeRunId,
                    artifactPath,
                    filterParam,
                  )
                }
                onOpenDiff={() => openSelectedRunDiff()}
                onOpenTerminal={() => {
                  if (!selectedRun.slotId) return;
                  router.push({
                    pathname: '/terminal/[slotId]',
                    params: {
                      slotId: selectedRun.slotId,
                      ...targetRouteContext('terminal'),
                      runId: selectedRun.runId,
                      details: '1',
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  });
                }}
                onOpenSlot={() => {
                  if (!selectedRun.slotId) return;
                  router.push({
                    pathname: '/slot/[id]',
                    params: {
                      id: selectedRun.slotId,
                      ...targetRouteContext('slot'),
                      runId: selectedRun.runId,
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  });
                }}
                onOpenPR={() => openPRForRun(selectedRun)}
                onOpenDecision={(decisionId) =>
                  router.push({
                    pathname: '/decision/[id]',
                    params: {
                      id: decisionId,
                      ...decisionRouteContextForRun(selectedRun, decisionId),
                      runId: selectedRun.runId,
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  })
                }
              />
            </View>
          ) : null}

          <View onLayout={rememberSection('compare')}>
            <FamilyComparePanel
              pairs={priorityVisualPairs}
              recipeFallback={priorityVisualPairIsRecipe}
              artifactAuthHeaders={artifactAuthHeaders}
              onOpenVisual={setViewerUri}
              onOpenArtifactWorkspace={(artifactValue) => {
                if (priorityVisualPairIsRecipe) {
                  if (!selectedRun) return;
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...targetRouteContext('compare'),
                      recipeRun: priorityCompareRecipeRunId,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      artifact: artifactValue.path,
                    },
                  });
                  return;
                }
                if (!artifactValue.runId) return;
                openFamilyArtifactWorkspace(artifactValue.runId, artifactValue.path);
              }}
              onOpenArtifacts={() => {
                if (!selectedRun) return;
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('compare'),
                    recipeRun: priorityVisualPairIsRecipe
                      ? priorityCompareRecipeRunId
                      : DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    filter: artifactFilterParamForWorkspaceNav('compare'),
                    ...(priorityVisualPairIsRecipe && priorityVisualPair
                      ? { artifact: priorityVisualPair.after.path }
                      : {}),
                  },
                });
              }}
            />
          </View>

          <View onLayout={rememberSection('ledger')}>
            <FamilyChangeLedgerPanel
              snapshot={snapshot}
              onOpenRun={(runIdValue) =>
                router.push({
                  pathname: '/run/[id]',
                  params: {
                    id: runIdValue,
                    ...targetRouteContext('run'),
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              }
              onOpenArtifacts={openFamilyArtifactWorkspace}
              onOpenDiff={(entry, artifactPath) =>
                router.push({
                  pathname: '/diff/[runId]',
                  params: {
                    runId: entry.runId,
                    ...diffRouteContext(),
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    ...(artifactPath ? { path: artifactPath } : {}),
                  },
                })
              }
              onOpenSlot={(slotIdValue, runIdValue) =>
                router.push({
                  pathname: '/slot/[id]',
                  params: {
                    id: slotIdValue,
                    ...targetRouteContext('slot'),
                    runId: runIdValue,
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              }
              onOpenTerminal={(slotIdValue, runIdValue) =>
                router.push({
                  pathname: '/terminal/[slotId]',
                  params: {
                    slotId: slotIdValue,
                    ...targetRouteContext('terminal'),
                    runId: runIdValue,
                    details: '1',
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              }
            />
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.section} onLayout={rememberSection('retros')}>
            <View style={styles.sectionHeader}>
              <View>
                <Text style={styles.sectionTitle}>Retrospectives</Text>
                <Text style={styles.sectionMeta}>
                  {pendingRetrospectiveCount} pending · {familyRetrospectives.length} total
                </Text>
              </View>
            </View>
            <Text style={styles.evidenceNote}>
              Pending and recorded retrospectives across this family, newest first. Open the retro,
              artifacts, recipe, diff, slot, or terminal directly from each run.
            </Text>
            {familyRetrospectives.length === 0 ? (
              <Text style={baseStyles.textMuted}>
                No retrospectives have been recorded for this family yet.
              </Text>
            ) : (
              familyRetrospectives.map(({ run, decision }) => (
                <RetrospectiveCard
                  key={decision.id}
                  run={run}
                  decision={decision}
                  recipeEvidence={recipeEvidenceForRun(run)}
                  recipeArtifactCount={recipeCountForRun(run)}
                  recipeAvailable={recipeAvailableForRun(run)}
                  gatewayUrl={gatewayUrl}
                  artifactAuthHeaders={artifactAuthHeaders}
                  onOpenVisual={setViewerUri}
                  onOpenDocument={openDocument}
                  onOpenDiffArtifact={(artifact) =>
                    openDiffArtifact(artifact, retrospectiveRouteContext)
                  }
                  onOpenDecision={() =>
                    router.push({
                      pathname: '/decision/[id]',
                      params: {
                        id: decision.id,
                        ...decisionWorkspaceRouteParams('retrospective'),
                        runId: run.runId,
                        recipeRun: workspaceRecipeRunForRun(run.runId),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    })
                  }
                  onOpenRun={() =>
                    router.push({
                      pathname: '/run/[id]',
                      params: {
                        id: run.runId,
                        ...retrospectiveRouteContext,
                        recipeRun: workspaceRecipeRunForRun(run.runId),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    })
                  }
                  onOpenArtifacts={() =>
                    router.push({
                      pathname: '/artifacts/[runId]',
                      params: {
                        runId: run.runId,
                        ...retrospectiveRouteContext,
                        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                        filter:
                          artifactFilterParamForArtifactPath(focusedArtifactForRun(run.runId)) ??
                          artifactFilterParamForWorkspaceNav('review'),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    })
                  }
                  onOpenArtifact={(artifactPath) =>
                    openFamilyArtifactWorkspace(run.runId, artifactPath, retrospectiveRouteContext)
                  }
                  onOpenRecipe={() =>
                    router.push({
                      pathname: '/artifacts/[runId]',
                      params: {
                        runId: run.runId,
                        ...retrospectiveRouteContext,
                        ...recipeWorkspaceParamsForRun(run),
                        filter: artifactFilterParamForWorkspaceNav('recipe'),
                      },
                    })
                  }
                  onOpenRecipeCompare={(artifactPath) => {
                    const recipeEvidence = recipeEvidenceForRun(run);
                    router.push({
                      pathname: '/artifacts/[runId]',
                      params: {
                        runId: run.runId,
                        ...retrospectiveRouteContext,
                        recipeRun:
                          recipeEvidence?.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                        filter: artifactFilterParamForWorkspaceNav('compare'),
                        ...((artifactPath ?? recipeEvidence?.artifactPath)
                          ? { artifact: artifactPath ?? recipeEvidence?.artifactPath }
                          : {}),
                      },
                    });
                  }}
                  onOpenDiff={() => openFamilyRunDiff(run, retrospectiveRouteContext)}
                  onOpenTerminal={() => {
                    if (!run.slotId) return;
                    router.push({
                      pathname: '/terminal/[slotId]',
                      params: {
                        slotId: run.slotId,
                        ...retrospectiveRouteContext,
                        runId: run.runId,
                        details: '1',
                        recipeRun: workspaceRecipeRunForRun(run.runId),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    });
                  }}
                  onOpenSlot={() => {
                    if (!run.slotId) return;
                    router.push({
                      pathname: '/slot/[id]',
                      params: {
                        id: run.slotId,
                        ...retrospectiveRouteContext,
                        runId: run.runId,
                        recipeRun: workspaceRecipeRunForRun(run.runId),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    });
                  }}
                  onOpenPR={() => openPRForRun(run, retrospectiveRouteContext)}
                />
              ))
            )}
          </View>

          <View style={styles.section} onLayout={rememberSection('evidence')}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Evidence workspace</Text>
              <Text style={styles.sectionMeta}>
                {filteredEvidenceGroups.length} groups · {snapshot.evidence.length} artifacts
                {visualPairs.length > 0
                  ? ` · ${visualPairs.length} pair${visualPairs.length === 1 ? '' : 's'}`
                  : ''}
              </Text>
            </View>
            <View style={styles.filterRow}>
              {EVIDENCE_FILTERS.map((filter) => (
                <Pressable
                  key={filter.id}
                  style={[
                    styles.filterChip,
                    evidenceFilter === filter.id && styles.filterChipActive,
                  ]}
                  onPress={() => setEvidenceFilter(filter.id)}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      evidenceFilter === filter.id && styles.filterChipTextActive,
                    ]}
                  >
                    {filter.label} {evidenceCounts[filter.id]}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.evidenceNote}>
              Grouped by producing run and capture batch. Before/after, review, diff, and recipe
              filters mirror the Command Center family evidence workspace.
            </Text>
            {snapshot.evidence.length === 0 ? (
              <Text style={baseStyles.textMuted}>No family evidence artifacts found.</Text>
            ) : filteredEvidenceGroups.length === 0 ? (
              <Text style={baseStyles.textMuted}>No evidence files match this filter.</Text>
            ) : (
              filteredEvidenceGroups.map((group) => (
                <EvidenceGroupCard
                  key={group.key}
                  group={group}
                  gatewayUrl={gatewayUrl}
                  artifactAuthHeaders={artifactAuthHeaders}
                  onOpenDocument={openDocument}
                  onOpenDiffArtifact={openDiffArtifact}
                  onOpenVisual={setViewerUri}
                  onOpenRun={(runIdValue) =>
                    router.push({
                      pathname: '/run/[id]',
                      params: {
                        id: runIdValue,
                        ...targetRouteContext('run'),
                        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      },
                    })
                  }
                  onOpenArtifacts={openFamilyArtifactWorkspace}
                  onOpenRecipe={(runIdValue) =>
                    router.push({
                      pathname: '/artifacts/[runId]',
                      params: {
                        runId: runIdValue,
                        ...targetRouteContext('recipe'),
                        recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                        filter: artifactFilterParamForWorkspaceNav('recipe'),
                      },
                    })
                  }
                  onOpenDiff={(sourceRun) => openFamilyRunDiff(sourceRun)}
                  onOpenTerminal={(slotIdValue, runIdValue) =>
                    router.push({
                      pathname: '/terminal/[slotId]',
                      params: {
                        slotId: slotIdValue,
                        ...targetRouteContext('terminal'),
                        runId: runIdValue,
                        details: '1',
                        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      },
                    })
                  }
                  onOpenSlot={(slotIdValue, runIdValue) =>
                    router.push({
                      pathname: '/slot/[id]',
                      params: {
                        id: slotIdValue,
                        ...targetRouteContext('slot'),
                        runId: runIdValue,
                        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      },
                    })
                  }
                />
              ))
            )}
          </View>

          <View style={styles.section} onLayout={rememberSection('runs')}>
            <Text style={styles.sectionTitle}>Family runs</Text>
            {snapshot.runs.map((run) => (
              <RunCard
                key={run.runId}
                run={run}
                active={run.runId === selectedRun?.runId}
                recipeEvidence={recipeEvidenceForRun(run)}
                recipeArtifactCount={recipeCountForRun(run)}
                recipeAvailable={recipeAvailableForRun(run)}
                gatewayUrl={gatewayUrl}
                artifactAuthHeaders={artifactAuthHeaders}
                onFocusRun={() =>
                  router.setParams({ familyId: snapshot.familyId, runId: run.runId })
                }
                onOpenRun={() =>
                  router.push({
                    pathname: '/run/[id]',
                    params: {
                      id: run.runId,
                      ...targetRouteContext('run'),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
                }
                onOpenArtifacts={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: run.runId,
                      ...targetRouteContext('artifacts'),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('review'),
                    },
                  })
                }
                onOpenCompare={(artifactPath) =>
                  openFamilyArtifactWorkspace(run.runId, artifactPath)
                }
                onOpenRecipeCompare={() => {
                  const recipeEvidence = recipeEvidenceForRun(run);
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: run.runId,
                      ...targetRouteContext('compare'),
                      recipeRun: recipeEvidence?.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      ...(recipeEvidence?.artifactPath
                        ? { artifact: recipeEvidence.artifactPath }
                        : {}),
                    },
                  });
                }}
                onOpenRecipe={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: run.runId,
                      ...targetRouteContext('recipe'),
                      recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('recipe'),
                    },
                  })
                }
                onOpenDiff={() => openFamilyRunDiff(run)}
                onOpenDecision={(decisionId) =>
                  router.push({
                    pathname: '/decision/[id]',
                    params: {
                      id: decisionId,
                      ...decisionRouteContextForRun(run, decisionId),
                      runId: run.runId,
                    },
                  })
                }
                onOpenTerminal={() => {
                  if (!run.slotId) return;
                  router.push({
                    pathname: '/terminal/[slotId]',
                    params: {
                      slotId: run.slotId,
                      ...targetRouteContext('terminal'),
                      runId: run.runId,
                      details: '1',
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  });
                }}
                onOpenSlot={() => {
                  if (!run.slotId) return;
                  router.push({
                    pathname: '/slot/[id]',
                    params: {
                      id: run.slotId,
                      ...targetRouteContext('slot'),
                      runId: run.runId,
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  });
                }}
                onOpenPR={() => openPRForRun(run)}
              />
            ))}
          </View>

          {snapshot.learnings.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Learnings</Text>
              {snapshot.learnings.slice(0, 6).map((learning) => (
                <View key={learning.id} style={styles.learningCard}>
                  <Text style={styles.learningTitle}>{learning.title}</Text>
                  <Text style={baseStyles.textSecondary}>{learning.summary}</Text>
                </View>
              ))}
            </View>
          )}
        </Animated.ScrollView>
        <MediaViewer
          visible={!!viewerUri}
          uri={viewerUri}
          items={visualViewerItems}
          authHeaders={artifactAuthHeaders}
          initialIndex={viewerIndex}
          onClose={() => setViewerUri(null)}
        />
        <DocumentViewer
          visible={!!documentViewer}
          title={documentViewer?.title ?? ''}
          body={documentViewer?.body ?? ''}
          onClose={() => setDocumentViewer(null)}
        />
      </View>
    </>
  );
}

function familyArtifactUrl(gatewayUrl: string, artifact: FamilyObservabilityArtifact): string {
  return artifactUrl(gatewayUrl, artifact.runId, artifact.path);
}

function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}

function familyRunDecisionNavMeta({
  run,
  decision,
  diffValue,
  visualPairCount,
}: {
  run: FamilyObservabilityRunSummary | null;
  decision: RunDecision | null | undefined;
  diffValue: string;
  visualPairCount: number;
}): string | null {
  if (!run || !decision) return null;
  const parts = [
    decision.resolvedAt ? 'resolved' : 'pending',
    `${run.artifacts.length} file${run.artifacts.length === 1 ? '' : 's'}`,
  ];
  if (diffValue && diffValue !== 'none') parts.push(diffValue);
  if (visualPairCount > 0) parts.push(`${visualPairCount} before→after`);
  return parts.join(' · ');
}

function summarizeFamilyRecipeEvidence(
  recipeRuns: RecipeRunArtifactGroup[],
  gatewayUrl: string,
  runId: string,
): FamilyRecipeEvidenceSummary {
  const compareTarget = selectSlotCompareTarget({
    runArtifacts: [],
    recipeRuns,
    selectedRecipeRunId: null,
  });
  const recipeVisualPairSummary = groupVisualArtifactPairs(
    selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
    (artifact) => artifactUrlForEntry(gatewayUrl, runId, artifact),
  );
  const primaryPair = recipeVisualPairSummary.pairs[0] ?? null;
  return {
    artifactCount: recipeRuns.reduce(
      (count, group) => count + artifactsForRecipeRun(group).length,
      0,
    ),
    pairCount: compareTarget?.pairCount ?? recipeVisualPairSummary.pairs.length,
    recipeRunId:
      compareTarget?.recipeRunId ??
      (primaryPair ? recipeRunIdForVisualPair(recipeRuns, primaryPair) : null),
    artifactPath: compareTarget?.artifactPath ?? primaryPair?.after.path ?? null,
    primaryPair,
  };
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

function FamilyWorkspaceCockpit({
  selectedRun,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  evidenceCount,
  visualPairCount,
  ledgerEntryCount,
  retrospectiveCount,
  pendingRetrospectiveCount,
  recipeArtifactCount,
  recipeAvailable,
  recipeScopeLabel,
  diffValue,
  onJumpFocus,
  onJumpCompare,
  onJumpLedger,
  onJumpRetros,
  onJumpEvidence,
  onJumpRuns,
  onOpenRun,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenDiff,
  onOpenSlot,
  onOpenPR,
  onOpenTerminal,
  onOpenDecision,
}: {
  selectedRun: FamilyObservabilityRunSummary | null;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  evidenceCount: number;
  visualPairCount: number;
  ledgerEntryCount: number;
  retrospectiveCount: number;
  pendingRetrospectiveCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  recipeScopeLabel: ReturnType<typeof recipeWorkspaceScopeLabel>;
  diffValue: string;
  onJumpFocus: () => void;
  onJumpCompare: () => void;
  onJumpLedger: () => void;
  onJumpRetros: () => void;
  onJumpEvidence: () => void;
  onJumpRuns: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenSlot: () => void;
  onOpenPR: () => void;
  onOpenTerminal: () => void;
  onOpenDecision: (decisionId: string) => void;
}) {
  return (
    <View style={styles.familyCockpit}>
      <View style={styles.familyCockpitHeader}>
        <View style={styles.familyCockpitTitleBlock}>
          <Text style={styles.familyCockpitTitle}>Family cockpit</Text>
          <Text style={styles.familyCockpitMeta} numberOfLines={1}>
            {selectedRun?.ticketOrPr ?? 'No selected run'}
          </Text>
        </View>
        <FamilyCockpitAction
          label="Terminal"
          onPress={onOpenTerminal}
          disabled={!selectedRun?.slotId}
          primary
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.familyCockpitRail}
      >
        <FamilyCockpitTile label="Focus" value={selectedRun?.status ?? '-'} onPress={onJumpFocus} />
        <FamilyCockpitTile
          label="Run"
          value={selectedRun ? shortId(selectedRun.runId) : '-'}
          hint={selectedRun?.flowType}
          onPress={onOpenRun}
          disabled={!selectedRun}
        />
        <FamilyCockpitTile
          label="Ready gate"
          value={readyDecisionId ? shortId(readyDecisionId) : '-'}
          hint={selectedRun ? `${selectedRun.artifacts.length} files · ${diffValue}` : undefined}
          onPress={() => {
            if (readyDecisionId) onOpenDecision(readyDecisionId);
          }}
          disabled={!readyDecisionId}
        />
        <FamilyCockpitTile
          label="Review gate"
          value={reviewDecisionId ? shortId(reviewDecisionId) : '-'}
          hint={selectedRun ? `${selectedRun.artifacts.length} files · ${diffValue}` : undefined}
          onPress={() => {
            if (reviewDecisionId) onOpenDecision(reviewDecisionId);
          }}
          disabled={!reviewDecisionId}
        />
        <FamilyCockpitTile
          label="Retro gate"
          value={retroDecisionId ? shortId(retroDecisionId) : '-'}
          hint={`${pendingRetrospectiveCount} pending · ${retrospectiveCount} total`}
          onPress={() => {
            if (retroDecisionId) onOpenDecision(retroDecisionId);
          }}
          disabled={!retroDecisionId}
        />
        <FamilyCockpitTile
          label="Artifact files"
          value={selectedRun ? String(selectedRun.artifacts.length) : '-'}
          onPress={onOpenArtifacts}
          disabled={!selectedRun}
        />
        <FamilyCockpitTile
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
          disabled={!selectedRun || recipeAvailable === false}
        />
        <FamilyCockpitTile
          label="PR"
          value={selectedRun?.prNumber ? `#${selectedRun.prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!selectedRun?.prNumber}
        />
        <FamilyCockpitTile
          label="Slot"
          value={selectedRun?.slotId ?? '-'}
          onPress={onOpenSlot}
          disabled={!selectedRun?.slotId}
        />
        <FamilyCockpitTile
          label="Before→After"
          value={String(visualPairCount)}
          hint={diffValue !== 'none' ? diffValue : undefined}
          onPress={onJumpCompare}
          disabled={visualPairCount === 0}
        />
        <FamilyCockpitTile
          label="Ledger"
          value={String(ledgerEntryCount)}
          onPress={onJumpLedger}
          disabled={ledgerEntryCount === 0}
        />
        <FamilyCockpitTile
          label="Evidence section"
          value={String(evidenceCount)}
          onPress={onJumpEvidence}
        />
        <FamilyCockpitTile
          label="Retro section"
          value={`${pendingRetrospectiveCount}/${retrospectiveCount}`}
          hint="pending / total"
          onPress={onJumpRetros}
        />
        <FamilyCockpitTile
          label="Diff view"
          value={diffValue}
          onPress={onOpenDiff}
          disabled={!selectedRun}
        />
        <FamilyCockpitTile label="Runs" value={selectedRun ? 'family' : '-'} onPress={onJumpRuns} />
      </ScrollView>
    </View>
  );
}

function FamilyCockpitTile({
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
      style={[styles.familyCockpitTile, disabled && styles.familyCockpitDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.familyCockpitTileLabel}>{label}</Text>
      <Text style={styles.familyCockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.familyCockpitTileHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

function FamilyCockpitAction({
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
        styles.familyCockpitAction,
        primary && styles.familyCockpitActionPrimary,
        disabled && styles.familyCockpitDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text
        style={[styles.familyCockpitActionText, primary && styles.familyCockpitActionTextPrimary]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function FamilyFocusedArtifactCard({
  artifactPath,
  recipeRunId,
  prNumber,
  onOpenRun,
  onOpenRecipe,
  onOpenArtifact,
  onOpenFiles,
  onOpenDiff,
  comparePairCount,
  onOpenCompare,
  onOpenSlot,
  onOpenTerminal,
  onOpenPR,
  slotAvailable,
}: {
  artifactPath: string;
  recipeRunId: string;
  prNumber?: number | null;
  onOpenRun: () => void;
  onOpenRecipe: () => void;
  onOpenArtifact: () => void;
  onOpenFiles: () => void;
  onOpenDiff: () => void;
  comparePairCount: number;
  onOpenCompare: () => void;
  onOpenSlot: () => void;
  onOpenTerminal: () => void;
  onOpenPR: () => void;
  slotAvailable: boolean;
}) {
  const artifactKind = familyFocusedArtifactKindLabel(artifactPath);
  const isDiff = shouldOpenFamilyFocusedArtifactAsDiff(artifactPath);
  const recipeScoped = recipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const recipeScopeLabel = recipeWorkspaceScopeLabel(recipeRunId);
  return (
    <View style={styles.familyFocusedArtifactCard}>
      <View style={styles.familyCockpitHeader}>
        <View style={styles.familyCockpitTitleBlock}>
          <Text style={styles.familyFocusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.familyFocusedArtifactPath} numberOfLines={2}>
            {artifactPath}
          </Text>
          <Text style={styles.familyFocusedArtifactMeta} numberOfLines={1}>
            {artifactKind} · {recipeScoped ? 'recipe context' : 'decision evidence'}
          </Text>
        </View>
        <FamilyCockpitAction
          label={isDiff ? 'Open diff' : 'Open'}
          onPress={isDiff ? onOpenDiff : onOpenArtifact}
          primary
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.familyCockpitRail}
      >
        <FamilyCockpitTile label="Files" value="context" onPress={onOpenFiles} />
        <FamilyCockpitTile label="Recipe files" value={recipeScopeLabel} onPress={onOpenRecipe} />
        <FamilyCockpitTile
          label="Before→After"
          value={comparePairCount > 0 ? String(comparePairCount) : '-'}
          onPress={onOpenCompare}
          disabled={comparePairCount === 0}
        />
        <FamilyCockpitTile label="Diff" value={isDiff ? 'focused' : 'run'} onPress={onOpenDiff} />
        <FamilyCockpitTile label="Run" value="detail" onPress={onOpenRun} />
        <FamilyCockpitTile
          label="Slot"
          value={slotAvailable ? 'workspace' : '-'}
          onPress={onOpenSlot}
          disabled={!slotAvailable}
        />
        <FamilyCockpitTile
          label="Terminal"
          value={slotAvailable ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotAvailable}
        />
        <FamilyCockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}

function familyFocusedArtifactKindLabel(artifactPath: string): string {
  if (shouldOpenFamilyFocusedArtifactAsDiff(artifactPath)) return 'diff';
  const filter = artifactFilterParamForArtifactPath(artifactPath);
  if (filter === 'recipes') return 'recipe file';
  if (filter === 'visual') return 'visual evidence';
  return 'evidence file';
}

function shouldOpenFamilyFocusedArtifactAsDiff(artifactPath: string): boolean {
  return Boolean(diffArtifactCandidate([{ path: artifactPath }]));
}

type FamilyCompareArtifact = ArtifactManifestEntry & { runId?: string } & { url: string };
type FamilyComparePair = VisualArtifactPair<ArtifactManifestEntry & { runId?: string }>;

function FamilyBeforeAfterPriorityPanel({
  pair,
  pairCount,
  authHeaders,
  recipeFallback,
  artifactCount,
  recipeArtifactCount,
  recipeAvailable,
  diffValue,
  slotId,
  prNumber,
  onOpenArtifact,
  onOpenCompare,
  onOpenEvidence,
  onOpenRecipe,
  onOpenDiff,
  onOpenRun,
  onOpenRetros,
  onOpenTerminal,
  onOpenPR,
}: {
  pair: VisualArtifactPair;
  pairCount: number;
  authHeaders: Record<string, string>;
  recipeFallback: boolean;
  artifactCount: number;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  diffValue: string;
  slotId?: string | null;
  prNumber?: number | null;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenCompare: () => void;
  onOpenEvidence: () => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenRun: () => void;
  onOpenRetros: () => void;
  onOpenTerminal: () => void;
  onOpenPR: () => void;
}) {
  return (
    <View style={styles.familyBeforeAfterPriorityPanel}>
      <BeforeAfterPreview
        pair={pair}
        authHeaders={authHeaders}
        onOpenArtifact={onOpenArtifact}
        eyebrow={recipeFallback ? 'Recipe evidence' : 'Review first'}
        title={recipeFallback ? 'Recipe before → after' : 'Family before → after evidence'}
        hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
        imageHeight={88}
      />
      <View style={styles.familyBeforeAfterPriorityActions}>
        <Text style={styles.familyBeforeAfterPriorityCopy}>
          {recipeFallback
            ? 'Recipe evidence has the clearest visible delta for the selected family run.'
            : 'Start from the visible delta, then drill into runs, artifacts, retros, or the ledger.'}
        </Text>
        <Pressable style={styles.familyBeforeAfterPriorityButton} onPress={onOpenCompare}>
          <Text style={styles.familyBeforeAfterPriorityButtonText}>Compare evidence</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.familyBeforeAfterPriorityRail}
      >
        <FamilyCockpitTile
          label="Evidence"
          value={String(artifactCount)}
          onPress={onOpenEvidence}
        />
        <FamilyCockpitTile
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
        <FamilyCockpitTile label="Diff" value={diffValue} onPress={onOpenDiff} />
        <FamilyCockpitTile label="Run" value="detail" onPress={onOpenRun} />
        <FamilyCockpitTile label="Retros" value="family" onPress={onOpenRetros} />
        <FamilyCockpitTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <FamilyCockpitTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}

function FamilyComparePanel({
  pairs,
  recipeFallback,
  artifactAuthHeaders,
  onOpenVisual,
  onOpenArtifactWorkspace,
  onOpenArtifacts,
}: {
  pairs: FamilyComparePair[];
  recipeFallback: boolean;
  artifactAuthHeaders: Record<string, string>;
  onOpenVisual: (uri: string) => void;
  onOpenArtifactWorkspace: (artifact: FamilyCompareArtifact) => void;
  onOpenArtifacts: () => void;
}) {
  if (pairs.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.sectionTitle}>
            {recipeFallback ? 'Recipe before → after compare' : 'Before → After compare'}
          </Text>
          <Text style={styles.sectionMeta}>
            {pairs.length} visual difference pair{pairs.length === 1 ? '' : 's'}
            {recipeFallback ? ' · recipe fallback' : ''}
          </Text>
        </View>
        <Pressable style={styles.compactOpenButton} onPress={onOpenArtifacts}>
          <Text style={styles.compactOpenText}>
            {recipeFallback ? 'Recipe compare' : 'Evidence files'}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {pairs.slice(0, 6).map((pair) => (
          <View key={`${pair.before.path}:${pair.after.path}`} style={styles.comparePairCard}>
            <ComparisonCard
              pair={pair}
              authHeaders={artifactAuthHeaders}
              onOpenBefore={() => onOpenVisual(pair.before.url)}
              onOpenAfter={() => onOpenVisual(pair.after.url)}
            />
            <View style={styles.comparePairActions}>
              <Pressable
                style={styles.comparePairAction}
                onPress={() => onOpenArtifactWorkspace(pair.before)}
              >
                <Text style={styles.comparePairActionText}>Before artifacts</Text>
              </Pressable>
              <Pressable
                style={styles.comparePairAction}
                onPress={() => onOpenArtifactWorkspace(pair.after)}
              >
                <Text style={styles.comparePairActionText}>After artifacts</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
      {pairs.length > 6 ? (
        <Text style={styles.compareMoreText}>+{pairs.length - 6} more pairs in artifacts</Text>
      ) : null}
    </View>
  );
}

function FamilyChangeLedgerPanel({
  snapshot,
  onOpenRun,
  onOpenArtifacts,
  onOpenDiff,
  onOpenSlot,
  onOpenTerminal,
}: {
  snapshot: FamilyObservabilitySnapshot;
  onOpenRun: (runId: string) => void;
  onOpenArtifacts: (runId: string, artifactPath?: string) => void;
  onOpenDiff: (entry: FamilyChangeLedgerEntry, artifactPath?: string) => void;
  onOpenSlot: (slotId: string, runId: string) => void;
  onOpenTerminal: (slotId: string, runId: string) => void;
}) {
  const ledger = snapshot.familyChangeLedger;
  if (!ledger) return null;

  const summary = ledger.summary;
  const missingEntries = ledger.entries.filter((entry) => entry.missingData.length > 0);
  const visibleEntries = ledger.entries.slice(0, 5);
  const runById = new Map(snapshot.runs.map((run) => [run.runId, run]));
  const contributionDelta = snapshot.diffStat.available
    ? `${snapshot.diffStat.files} files · +${snapshot.diffStat.additions} -${snapshot.diffStat.deletions}`
    : `${summary.totalContributionFiles} files · +${summary.totalContributionAdditions} -${summary.totalContributionDeletions}`;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.sectionTitle}>Change ledger</Text>
          <Text style={styles.sectionMeta}>
            Durable diff, review, and artifact signals from Command Center
          </Text>
        </View>
        <Pressable
          style={styles.compactOpenButton}
          onPress={() => onOpenArtifacts(snapshot.latestRunId)}
        >
          <Text style={styles.compactOpenText}>Evidence files</Text>
        </Pressable>
      </View>
      <View style={styles.ledgerMetricGrid}>
        <Metric
          label="Produced diffs"
          value={`${summary.runsWithContributionDiff}/${ledger.entries.length}`}
          compact
        />
        <Metric
          label="Reviewed input"
          value={`${summary.runsWithReviewInputDiff}/${ledger.entries.length}`}
          compact
        />
        <Metric label="Delta" value={contributionDelta} compact />
        <Metric
          label="Artifact data"
          value={`${summary.artifactFootprint.count} · ${formatBytes(
            summary.artifactFootprint.bytes,
          )}`}
          compact
        />
        <Metric label="Bugbots fixed" value={String(summary.bugbotFindingsAddressed)} compact />
        <Metric label="Human fixed" value={String(summary.humanCommentsAddressed)} compact />
        <Metric label="Missing data" value={String(missingEntries.length)} compact />
      </View>
      <View style={styles.ledgerEntries}>
        {visibleEntries.map((entry) => {
          const run = runById.get(entry.runId);
          const diffArtifactPath = primaryLedgerDiffPath(entry);
          return (
            <View key={entry.runId} style={styles.ledgerEntryCard}>
              <View style={styles.ledgerEntryHeader}>
                <View style={styles.ledgerEntryTitleWrap}>
                  <Text style={styles.ledgerEntryTitle} numberOfLines={1}>
                    {entry.ticketOrPr}
                  </Text>
                  <Text style={styles.ledgerEntryMeta} numberOfLines={1}>
                    {entry.flowType} · {entry.changeKind} · {entry.runId.slice(0, 8)}
                  </Text>
                </View>
                <Text style={styles.ledgerEntryPr}>
                  {entry.prNumber ? `#${entry.prNumber}` : entry.lane}
                </Text>
              </View>
              <View style={styles.ledgerEntryFacts}>
                <Text style={styles.ledgerFact}>
                  Diff:{' '}
                  {entry.contributionDiff.available
                    ? `${entry.contributionDiff.files} files · +${entry.contributionDiff.additions} -${entry.contributionDiff.deletions}`
                    : entry.inputDiff?.available
                      ? `${entry.inputDiff.files} reviewed files`
                      : (entry.contributionDiff.missingReason ?? 'none')}
                </Text>
                <Text style={styles.ledgerFact}>
                  Evidence files: {entry.artifactFootprint.count} ·{' '}
                  {formatBytes(entry.artifactFootprint.bytes)}
                </Text>
                {entry.reviewSignals ? (
                  <Text style={styles.ledgerFact}>
                    Review: bot {entry.reviewSignals.botAddressed} · human{' '}
                    {entry.reviewSignals.humanCommentsAddressed}
                  </Text>
                ) : null}
                {entry.missingData.length > 0 ? (
                  <Text style={styles.ledgerMissing} numberOfLines={2}>
                    Missing: {entry.missingData.join(', ')}
                  </Text>
                ) : null}
              </View>
              <View style={styles.runActions}>
                <Pressable style={styles.inlineButton} onPress={() => onOpenRun(entry.runId)}>
                  <Text style={styles.inlineButtonText}>Run detail</Text>
                </Pressable>
                <Pressable style={styles.inlineButton} onPress={() => onOpenArtifacts(entry.runId)}>
                  <Text style={styles.inlineButtonText}>Evidence files</Text>
                </Pressable>
                <Pressable
                  style={styles.inlineButton}
                  onPress={() => onOpenDiff(entry, diffArtifactPath)}
                >
                  <Text style={styles.inlineButtonText}>Diff view</Text>
                </Pressable>
                {run?.slotId ? (
                  <>
                    <Pressable
                      style={styles.inlineButton}
                      onPress={() => onOpenSlot(run.slotId!, entry.runId)}
                    >
                      <Text style={styles.inlineButtonText}>Slot</Text>
                    </Pressable>
                    <Pressable
                      style={styles.inlineButton}
                      onPress={() => onOpenTerminal(run.slotId!, entry.runId)}
                    >
                      <Text style={styles.inlineButtonText}>Terminal</Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
      {ledger.entries.length > visibleEntries.length ? (
        <Text style={styles.ledgerMoreText}>
          +{ledger.entries.length - visibleEntries.length} more ledger entr
          {ledger.entries.length - visibleEntries.length === 1 ? 'y' : 'ies'} in this family.
        </Text>
      ) : null}
    </View>
  );
}

function primaryLedgerDiffPath(entry: FamilyChangeLedgerEntry): string | undefined {
  return (
    entry.contributionDiff.artifactPath ??
    entry.inputDiff?.artifactPath ??
    entry.legacyDiffFallback?.artifactPath
  );
}

function decisionPresentationForFamilyRun(
  run: FamilyObservabilityRunSummary,
  decision: RunDecision,
): DecisionPresentation {
  return presentDecision({
    ...decision,
    slotId: run.slotId,
    context: {
      ...(decision.context ?? {}),
      runId: run.runId,
      familyId: run.familyId,
      ticketOrPr: run.ticketOrPr,
      ...(run.slotId ? { slotId: run.slotId } : {}),
      artifactManifest: run.artifacts,
    },
    runMeta: {
      runId: run.runId,
      familyId: run.familyId,
      flowType: run.flowType,
      ticketOrPr: run.ticketOrPr,
      branch: run.branch ?? undefined,
      runner: run.metrics?.runner ?? undefined,
      model: run.metrics?.model ?? undefined,
      summary: run.summary ?? undefined,
    },
  });
}

function RetrospectiveCard({
  run,
  decision,
  recipeEvidence,
  recipeArtifactCount,
  recipeAvailable,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenVisual,
  onOpenDocument,
  onOpenDiffArtifact,
  onOpenDecision,
  onOpenRun,
  onOpenArtifacts,
  onOpenArtifact,
  onOpenRecipe,
  onOpenRecipeCompare,
  onOpenDiff,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
}: {
  run: FamilyObservabilityRunSummary;
  decision: RunDecision;
  recipeEvidence: FamilyRecipeEvidenceSummary | null;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDecision: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenRecipe: () => void;
  onOpenRecipeCompare: (artifactPath?: string) => void;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
  onOpenSlot: () => void;
  onOpenPR: () => void;
}) {
  const payload =
    decision.payload?.kind === 'retrospective' ? (decision.payload as RetrospectivePayload) : null;
  const presentation = decisionPresentationForFamilyRun(run, decision);
  const primaryArtifactPath = presentation.artifactManifest[0]?.path ?? null;
  const openEvidence = primaryArtifactPath
    ? () => onOpenArtifact(primaryArtifactPath)
    : onOpenArtifacts;
  const statusTone = decision.resolvedAt ? colors.statusOk : colors.statusWarn;
  const recipeValue =
    recipeArtifactCount !== null ? String(recipeArtifactCount) : recipeAvailable ? 'yes' : '-';
  const diffValue = run.diffStat.available ? 'files' : run.slotId ? 'workspace' : '-';
  const retroVisualPairSummary = groupVisualArtifactPairs(
    presentation.artifactManifest,
    (artifact) => artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const retroPrimaryVisualPair = retroVisualPairSummary.pairs[0] ?? null;
  const recipePairCount = recipeEvidence?.pairCount ?? 0;
  const recipePrimaryVisualPair =
    retroVisualPairSummary.pairs.length === 0 ? (recipeEvidence?.primaryPair ?? null) : null;
  const comparePairCount =
    retroVisualPairSummary.pairs.length > 0 ? retroVisualPairSummary.pairs.length : recipePairCount;
  const openRetroCompare = retroPrimaryVisualPair
    ? () => onOpenArtifact(retroPrimaryVisualPair.after.path)
    : recipePairCount > 0
      ? () => onOpenRecipeCompare()
      : onOpenArtifacts;
  return (
    <Pressable
      style={[
        styles.retroCard,
        { backgroundColor: statusTone + '14', borderColor: statusTone + '55' },
      ]}
      onPress={onOpenDecision}
    >
      <View style={styles.retroHeaderRow}>
        <Text style={[styles.retroRun, { color: statusTone }]}>{run.ticketOrPr}</Text>
        <View style={[styles.retroStatusBadge, { backgroundColor: statusTone + '22' }]}>
          <Text style={[styles.retroStatusText, { color: statusTone }]}>
            {decision.resolvedAt ? 'Recorded' : 'Pending'}
          </Text>
        </View>
      </View>
      <Text style={styles.retroTitle}>{decision.title}</Text>
      <Text style={baseStyles.textSecondary} numberOfLines={3}>
        {presentation.summary || payload?.whatThisIs || decision.description}
      </Text>
      <View style={styles.retroSignalRow}>
        {presentation.highlights.slice(0, 4).map((highlight) => {
          const target = workspaceSignalTargetForDecisionLabel(highlight.label);
          const content = (
            <>
              <Text style={styles.retroSignalLabel}>{highlight.label}</Text>
              <Text style={styles.retroSignalValue} numberOfLines={1}>
                {highlight.value}
                {target ? ' ›' : ''}
              </Text>
            </>
          );
          return target ? (
            <Pressable
              key={`${highlight.label}-${highlight.value}`}
              style={[styles.retroSignalChip, styles.retroSignalChipPressable]}
              onPress={
                target === 'diff'
                  ? onOpenDiff
                  : target === 'compare'
                    ? openRetroCompare
                    : openEvidence
              }
            >
              {content}
            </Pressable>
          ) : (
            <View key={`${highlight.label}-${highlight.value}`} style={styles.retroSignalChip}>
              {content}
            </View>
          );
        })}
      </View>
      <View style={styles.retroMetaRow}>
        <Text style={styles.retroMeta}>Outcome: {payload?.outcome ?? 'unknown'}</Text>
        {payload?.ciWatch ? (
          <Text style={styles.retroMeta}>
            CI: {payload.ciWatch.result ?? 'unknown'} · {payload.ciWatch.passed ?? 0}/
            {payload.ciWatch.total ?? 0}
          </Text>
        ) : null}
      </View>
      {presentation.textSections.length > 0 ? (
        <Text style={styles.retroMeta} numberOfLines={1}>
          Reports: {presentation.textSections.map((section) => section.title).join(' · ')}
        </Text>
      ) : null}
      {primaryArtifactPath ? (
        <Text style={styles.retroEvidencePath} numberOfLines={1}>
          Evidence: {primaryArtifactPath}
          {presentation.artifactManifest.length > 1
            ? ` +${presentation.artifactManifest.length - 1}`
            : ''}
        </Text>
      ) : null}
      {presentation.artifactManifest.length > 0 ? (
        <RetroEvidencePreview
          run={run}
          artifacts={presentation.artifactManifest}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          onOpenVisual={onOpenVisual}
          onOpenDocument={onOpenDocument}
          onOpenDiffArtifact={onOpenDiffArtifact}
          onOpenArtifact={onOpenArtifact}
          onOpenArtifacts={onOpenArtifacts}
        />
      ) : null}
      {recipePrimaryVisualPair ? (
        <View style={styles.retroEvidencePreview}>
          <BeforeAfterPreview
            pair={recipePrimaryVisualPair}
            authHeaders={artifactAuthHeaders}
            onOpenArtifact={onOpenRecipeCompare}
            eyebrow="Recipe evidence"
            title="Recipe before → after"
            hint="Retro fallback"
            imageHeight={74}
          />
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.retroActionRow}
      >
        <RetroAction
          label="Retro gate"
          value={decision.resolvedAt ? 'recorded' : 'pending'}
          primary
          onPress={onOpenDecision}
        />
        <RetroAction label="Run detail" value="open" onPress={onOpenRun} />
        <RetroAction
          label="Evidence files"
          value={String(presentation.artifactManifest.length)}
          onPress={openEvidence}
        />
        <RetroAction
          label="Before→After"
          value={String(comparePairCount)}
          onPress={openRetroCompare}
          disabled={comparePairCount === 0}
        />
        <RetroAction
          label="Recipe files"
          value={recipeValue}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <RetroAction
          label="Diff view"
          value={diffValue}
          onPress={onOpenDiff}
          disabled={diffValue === '-'}
        />
        {run.prNumber ? (
          <RetroAction label="PR" value={`#${run.prNumber}`} onPress={onOpenPR} />
        ) : null}
        {run.slotId ? (
          <>
            <RetroAction label="Slot" value={run.slotId} onPress={onOpenSlot} />
            <RetroAction label="Terminal" value="live" onPress={onOpenTerminal} />
          </>
        ) : null}
      </ScrollView>
    </Pressable>
  );
}

function RetroEvidencePreview({
  run,
  artifacts,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenVisual,
  onOpenDocument,
  onOpenDiffArtifact,
  onOpenArtifact,
  onOpenArtifacts,
}: {
  run: FamilyObservabilityRunSummary;
  artifacts: ArtifactManifestEntry[];
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenArtifacts: () => void;
}) {
  const visualArtifacts = artifacts.filter((artifact) =>
    ['image', 'video'].includes(classifyArtifact(artifact)),
  );
  const visualPairSummary = groupVisualArtifactPairs(artifacts, (artifact) =>
    artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const previewArtifacts = (visualArtifacts.length ? visualArtifacts : artifacts).slice(0, 3);
  const hiddenCount = Math.max(0, artifacts.length - previewArtifacts.length);

  return (
    <View style={styles.retroEvidencePreview}>
      <View style={styles.retroEvidencePreviewHeader}>
        <Text style={styles.retroEvidencePreviewTitle}>Retro evidence</Text>
        <Pressable onPress={onOpenArtifacts}>
          <Text style={styles.retroEvidencePreviewOpen}>Open files</Text>
        </Pressable>
      </View>
      {primaryVisualPair ? (
        <BeforeAfterPreview
          pair={primaryVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={onOpenArtifact}
          title="Retro before → after"
          hint="Tap to inspect"
          imageHeight={74}
        />
      ) : null}
      <View style={styles.focusEvidenceStrip}>
        {previewArtifacts.map((artifact) => {
          const familyArtifact = familyArtifactFromManifest(run, artifact);
          const url = artifactUrl(gatewayUrl, run.runId, artifact.path);
          const mediaType = classifyArtifact(artifact);
          const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
          const onPress =
            mediaType === 'image' || mediaType === 'video'
              ? () => onOpenVisual(url)
              : isDiffArtifact
                ? () => onOpenDiffArtifact(familyArtifact)
                : mediaType === 'document'
                  ? () => onOpenDocument(familyArtifact)
                  : () => onOpenArtifact(artifact.path);
          return (
            <Pressable
              key={`${run.runId}:${artifact.path}`}
              style={styles.focusEvidenceItem}
              onPress={onPress}
            >
              {mediaType === 'image' ? (
                <Image
                  source={{ uri: url, headers: artifactAuthHeaders }}
                  style={styles.focusEvidenceImage}
                />
              ) : (
                <View style={styles.focusEvidenceDoc}>
                  <Text style={styles.focusEvidenceDocType}>
                    {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
                  </Text>
                </View>
              )}
              <Text style={styles.focusEvidencePath} numberOfLines={1}>
                {artifact.path.split('/').pop() ?? artifact.path}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {hiddenCount > 0 ? (
        <Pressable style={styles.focusEvidenceMoreButton} onPress={onOpenArtifacts}>
          <Text style={styles.focusEvidenceMoreText}>+{hiddenCount} more evidence artifacts</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function familyArtifactFromManifest(
  run: FamilyObservabilityRunSummary,
  artifact: ArtifactManifestEntry,
): FamilyObservabilityArtifact {
  return {
    runId: run.runId,
    familyId: run.familyId,
    path: artifact.path,
    purpose: artifact.purpose ?? 'artifact',
    sizeBytes: artifact.sizeBytes,
    source: 'artifact-manifest',
  };
}

function RetroAction({
  label,
  value,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  value: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.retroActionButton,
        primary && styles.retroActionButtonPrimary,
        disabled && styles.familyCockpitDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.retroActionText, primary && styles.retroActionTextPrimary]}>
        {label}
      </Text>
      <Text style={styles.retroActionValue} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

function FamilyDecisionSignalsPanel({
  run,
  onOpenDecision,
  onOpenArtifacts,
  onOpenCompare,
  onOpenDiff,
}: {
  run: FamilyObservabilityRunSummary;
  onOpenDecision: (decisionId: string) => void;
  onOpenArtifacts: () => void;
  onOpenCompare: () => void;
  onOpenDiff: () => void;
}) {
  const decisions = run.decisions ?? [];
  if (decisions.length === 0) return null;
  const cards = [...decisions]
    .sort((left, right) => Number(Boolean(left.resolvedAt)) - Number(Boolean(right.resolvedAt)))
    .slice(0, 3)
    .map((decision) => ({
      decision,
      presentation: decisionPresentationForFamilyRun(run, decision),
    }));

  return (
    <View style={styles.familyDecisionPanel}>
      <View style={styles.focusRetroHeader}>
        <Text style={styles.familyDecisionTitle}>Review / retro signals</Text>
        <Text style={styles.focusRetroMeta}>
          {decisions.length} decision{decisions.length === 1 ? '' : 's'} ·{' '}
          {decisions.filter((decision) => !decision.resolvedAt).length} pending
        </Text>
      </View>
      {cards.map(({ decision, presentation }) => {
        const resolved = Boolean(decision.resolvedAt);
        const tone = TONE_COLORS[resolved ? 'ok' : presentation.tone];
        return (
          <Pressable
            key={decision.id}
            style={[styles.familyDecisionCard, { borderLeftColor: tone }]}
            onPress={() => onOpenDecision(decision.id)}
          >
            <View style={styles.focusRetroHeader}>
              <View style={[styles.familyDecisionBadge, { backgroundColor: tone + '22' }]}>
                <Text style={[styles.familyDecisionBadgeText, { color: tone }]}>
                  {resolved ? 'Resolved' : presentation.kindLabel}
                </Text>
              </View>
              <Text style={styles.focusRetroMeta}>
                {presentation.kind === 'retrospective' ? 'Retro' : 'Review'}
              </Text>
            </View>
            <Text style={styles.familyDecisionCardTitle} numberOfLines={2}>
              {presentation.title}
            </Text>
            <Text style={styles.familyDecisionSummary} numberOfLines={2}>
              {presentation.summary || presentation.description}
            </Text>
            {presentation.highlights.length > 0 ? (
              <View style={styles.familyDecisionChipRow}>
                {presentation.highlights.slice(0, 3).map((highlight) => {
                  const highlightTone = TONE_COLORS[highlight.tone ?? 'info'];
                  const target = workspaceSignalTargetForDecisionLabel(highlight.label);
                  const content = (
                    <Text style={[styles.familyDecisionChipText, { color: highlightTone }]}>
                      {highlight.label}: {highlight.value}
                      {target ? ' ›' : ''}
                    </Text>
                  );
                  return target ? (
                    <Pressable
                      key={`${decision.id}:${highlight.label}:${highlight.value}`}
                      style={[styles.familyDecisionChip, { borderColor: highlightTone + '66' }]}
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
                      key={`${decision.id}:${highlight.label}:${highlight.value}`}
                      style={[styles.familyDecisionChip, { borderColor: highlightTone + '66' }]}
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

function FamilyRunWorkspaceCard({
  run,
  activeRunId,
  onFocusRun,
  onOpenRun,
  onOpenArtifacts,
  onOpenArtifact,
  gatewayUrl,
  artifactAuthHeaders,
  recipeArtifactCount,
  recipeAvailable,
  selectedFullRun,
  activeTaskProgress,
  fallbackTaskProgress,
  taskProgressError,
  recipeRuns,
  onOpenVisual,
  onOpenDocument,
  onOpenDiffArtifact,
  onOpenRecipe,
  onOpenRecipeArtifact,
  onOpenDiff,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
  onOpenDecision,
}: {
  run: FamilyObservabilityRunSummary;
  activeRunId?: string;
  onFocusRun: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenArtifact: (artifactPath: string) => void;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  selectedFullRun: Run | null;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  taskProgressError?: string | null;
  recipeRuns: RecipeRunArtifactGroup[];
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
  onOpenRecipe: () => void;
  onOpenRecipeArtifact: (
    recipeRunId: string,
    artifactPath: string,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => void;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
  onOpenSlot: () => void;
  onOpenPR: () => void;
  onOpenDecision: (decisionId: string) => void;
}) {
  const statusColor = STATUS_COLORS[run.status] ?? colors.textMuted;
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retrospective = selectRetrospectiveWorkspaceDecision(run);
  const retrospectivePayload =
    retrospective?.payload?.kind === 'retrospective'
      ? (retrospective.payload as RetrospectivePayload)
      : null;
  const retrospectivePresentation = retrospective
    ? decisionPresentationForFamilyRun(run, retrospective)
    : null;
  const retroArtifacts = retrospectivePresentation?.artifactManifest ?? [];
  const retroVisualPairSummary = groupVisualArtifactPairs(retroArtifacts, (artifact) =>
    artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const retroPrimaryVisualPair = retroVisualPairSummary.pairs[0] ?? null;
  const retroTone = !retrospective
    ? colors.textMuted
    : retrospective.resolvedAt
      ? colors.statusOk
      : colors.statusWarn;
  const retroPrimaryArtifactPath = retroArtifacts[0]?.path ?? null;
  const openRetroEvidence = retroPrimaryArtifactPath
    ? () => onOpenArtifact(retroPrimaryArtifactPath)
    : onOpenArtifacts;
  const selected = activeRunId === run.runId;
  const focusDiffValue = run.diffStat.available
    ? `+${run.diffStat.additions} -${run.diffStat.deletions}`
    : run.slotId
      ? 'workspace'
      : '-';
  const retroDiffValue = run.diffStat.available ? 'files' : run.slotId ? 'workspace' : '-';
  const runVisualPairSummary = groupVisualArtifactPairs(run.artifacts, (artifact) =>
    artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const runPrimaryVisualPair = runVisualPairSummary.pairs[0] ?? null;
  const recipeVisualPairSummary = groupVisualArtifactPairs(
    selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
    (artifact) => artifactUrlForEntry(gatewayUrl, run.runId, artifact),
  );
  const recipePrimaryVisualPair = recipeVisualPairSummary.pairs[0] ?? null;
  const recipePairCount = recipeVisualPairSummary.pairs.length;
  const comparePairCount =
    runVisualPairSummary.pairs.length > 0 ? runVisualPairSummary.pairs.length : recipePairCount;
  const openRecipeCompare = () => {
    if (!recipePrimaryVisualPair) {
      onOpenRecipe();
      return;
    }
    onOpenRecipeArtifact(
      recipeRunIdForVisualPair(recipeRuns, recipePrimaryVisualPair),
      recipePrimaryVisualPair.after.path,
      artifactFilterParamForWorkspaceNav('compare'),
    );
  };
  const openRunCompare = runPrimaryVisualPair
    ? () => onOpenArtifact(runPrimaryVisualPair.after.path)
    : recipePrimaryVisualPair
      ? openRecipeCompare
      : onOpenArtifacts;

  return (
    <View style={[styles.focusRunCard, selected && styles.focusRunCardActive]}>
      <View style={styles.focusRunHeader}>
        <View style={[styles.runStatusBadge, { backgroundColor: statusColor + '22' }]}>
          <Text style={[styles.runStatusText, { color: statusColor }]}>{run.status}</Text>
        </View>
        <Pressable style={styles.focusRunSelectButton} onPress={onFocusRun}>
          <Text style={styles.focusRunSelectText}>{selected ? 'Selected' : 'Focus'}</Text>
        </Pressable>
      </View>
      <Text style={styles.focusRunTitle} numberOfLines={2}>
        {run.ticketOrPr}
      </Text>
      <Text style={styles.focusRunMeta} numberOfLines={1}>
        {run.flowType} · {run.lane}
        {run.slotId ? ` · ${run.slotId}` : ''}
      </Text>
      {run.summary ? (
        <Text style={baseStyles.textSecondary} numberOfLines={3}>
          {run.summary}
        </Text>
      ) : null}

      <View style={styles.runMetaGrid}>
        <Metric
          label="Evidence files"
          value={String(run.artifacts.length)}
          compact
          onPress={onOpenArtifacts}
        />
        <Metric
          label="Diff view"
          value={focusDiffValue}
          compact
          onPress={onOpenDiff}
          disabled={!run.diffStat.available && !run.slotId}
        />
        <Metric
          label="Ready gate"
          value={readyDecision ? (readyDecision.resolvedAt ? 'resolved' : 'pending') : '-'}
          compact
          onPress={readyDecision ? () => onOpenDecision(readyDecision.id) : undefined}
          disabled={!readyDecision}
        />
        <Metric
          label="Review gate"
          value={
            reviewGateDecision ? (reviewGateDecision.resolvedAt ? 'resolved' : 'pending') : '-'
          }
          compact
          onPress={reviewGateDecision ? () => onOpenDecision(reviewGateDecision.id) : undefined}
          disabled={!reviewGateDecision}
        />
        <Metric
          label="Retro gate"
          value={retrospective ? (retrospective.resolvedAt ? 'recorded' : 'pending') : '-'}
          compact
          onPress={retrospective ? () => onOpenDecision(retrospective.id) : undefined}
          disabled={!retrospective}
        />
        <Metric
          label="Before→After"
          value={String(comparePairCount)}
          compact
          onPress={openRunCompare}
          disabled={comparePairCount === 0}
        />
        <Metric
          label="Recipe files"
          value={
            recipeArtifactCount === null ? '…' : recipeAvailable ? String(recipeArtifactCount) : '-'
          }
          compact
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <Metric
          label="Progress"
          value={
            activeTaskProgress
              ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
              : fallbackTaskProgress?.percent != null
                ? `${Math.round(fallbackTaskProgress.percent)}%`
                : fallbackTaskProgress
                  ? 'live'
                  : '-'
          }
          compact
          onPress={onOpenTerminal}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
        />
      </View>

      {activeTaskProgress ? (
        <TaskProgressPanel
          run={selectedFullRun}
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

      {run.artifacts.length > 0 ? (
        <FocusedRunEvidencePreview
          run={run}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          onOpenArtifacts={onOpenArtifacts}
          onOpenArtifact={onOpenArtifact}
          onOpenVisual={onOpenVisual}
          onOpenDocument={onOpenDocument}
          onOpenDiffArtifact={onOpenDiffArtifact}
        />
      ) : null}

      <FocusedRunRecipeQualityPanel
        run={run}
        gatewayUrl={gatewayUrl}
        artifactAuthHeaders={artifactAuthHeaders}
        recipeRuns={recipeRuns}
        onOpenRecipe={onOpenRecipe}
        onOpenRecipeArtifact={onOpenRecipeArtifact}
        onOpenArtifacts={onOpenArtifacts}
      />

      {retrospective ? (
        <View style={styles.focusRetroBox}>
          <View style={styles.focusRetroHeader}>
            <Text style={[styles.focusRetroLabel, { color: retroTone }]}>
              {retrospective.resolvedAt ? 'Retrospective recorded' : 'Retrospective pending'}
            </Text>
            <Text style={styles.focusRetroMeta}>
              {retrospectivePayload?.outcome ?? retrospective.resolvedAction ?? 'review'}
            </Text>
          </View>
          <Text style={styles.focusRetroText} numberOfLines={3}>
            {retrospectivePayload?.deltaLearnings ??
              retrospectivePayload?.workerLearnings ??
              retrospectivePayload?.selfReviewSummary ??
              retrospective.description}
          </Text>
          {retrospectivePayload?.commentsTriageSummary ? (
            <Text style={styles.focusRetroMeta} numberOfLines={1}>
              Comments: {retrospectivePayload.commentsTriageSummary.total} total ·{' '}
              {retrospectivePayload.commentsTriageSummary.real} real ·{' '}
              {retrospectivePayload.commentsTriageSummary.fixed} fixed
            </Text>
          ) : null}
          {retroPrimaryArtifactPath ? (
            <Text style={styles.retroEvidencePath} numberOfLines={1}>
              Evidence: {retroPrimaryArtifactPath}
              {retroArtifacts.length > 1 ? ` +${retroArtifacts.length - 1}` : ''}
            </Text>
          ) : null}
          {retroArtifacts.length > 0 ? (
            <RetroEvidencePreview
              run={run}
              artifacts={retroArtifacts}
              gatewayUrl={gatewayUrl}
              artifactAuthHeaders={artifactAuthHeaders}
              onOpenVisual={onOpenVisual}
              onOpenDocument={onOpenDocument}
              onOpenDiffArtifact={onOpenDiffArtifact}
              onOpenArtifact={onOpenArtifact}
              onOpenArtifacts={onOpenArtifacts}
            />
          ) : null}
          {!retroPrimaryVisualPair && recipePrimaryVisualPair ? (
            <View style={styles.retroEvidencePreview}>
              <BeforeAfterPreview
                pair={recipePrimaryVisualPair}
                authHeaders={artifactAuthHeaders}
                onOpenArtifact={(artifactPath) => {
                  onOpenRecipeArtifact(
                    recipeRunIdForVisualPair(recipeRuns, recipePrimaryVisualPair),
                    artifactPath,
                    artifactFilterParamForWorkspaceNav('compare'),
                  );
                }}
                eyebrow="Recipe evidence"
                title="Recipe before → after"
                hint="Retro fallback"
                imageHeight={74}
              />
            </View>
          ) : null}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.retroActionRow}
          >
            <RetroAction
              label="Retro gate"
              value={retrospective.resolvedAt ? 'recorded' : 'pending'}
              primary
              onPress={() => onOpenDecision(retrospective.id)}
            />
            <RetroAction
              label="Evidence files"
              value={String(retroArtifacts.length)}
              onPress={openRetroEvidence}
              disabled={retroArtifacts.length === 0}
            />
            <RetroAction
              label="Before→After"
              value={String(
                retroVisualPairSummary.pairs.length > 0
                  ? retroVisualPairSummary.pairs.length
                  : recipePairCount,
              )}
              onPress={() => {
                if (retroPrimaryVisualPair) onOpenArtifact(retroPrimaryVisualPair.after.path);
                else openRecipeCompare();
              }}
              disabled={retroVisualPairSummary.pairs.length === 0 && recipePairCount === 0}
            />
            <RetroAction
              label="Recipe files"
              value={
                recipeArtifactCount === null
                  ? '…'
                  : recipeAvailable
                    ? String(recipeArtifactCount)
                    : '-'
              }
              onPress={onOpenRecipe}
              disabled={recipeAvailable === false}
            />
            <RetroAction
              label="Diff view"
              value={retroDiffValue}
              onPress={onOpenDiff}
              disabled={retroDiffValue === '-'}
            />
            {run.prNumber ? (
              <RetroAction label="PR" value={`#${run.prNumber}`} onPress={onOpenPR} />
            ) : null}
            {run.slotId ? (
              <>
                <RetroAction label="Slot" value={run.slotId} onPress={onOpenSlot} />
                <RetroAction label="Terminal" value="live" onPress={onOpenTerminal} />
              </>
            ) : null}
          </ScrollView>
        </View>
      ) : null}

      <FamilyDecisionSignalsPanel
        run={run}
        onOpenDecision={onOpenDecision}
        onOpenArtifacts={onOpenArtifacts}
        onOpenCompare={openRunCompare}
        onOpenDiff={onOpenDiff}
      />

      <View style={styles.runActions}>
        <Pressable style={styles.inlineButton} onPress={onOpenRun}>
          <Text style={styles.inlineButtonText}>Run detail</Text>
        </Pressable>
        <Pressable style={styles.inlineButton} onPress={onOpenArtifacts}>
          <Text style={styles.inlineButtonText}>Evidence files</Text>
        </Pressable>
        {comparePairCount > 0 ? (
          <Pressable style={styles.inlineButton} onPress={openRunCompare}>
            <Text style={styles.inlineButtonText}>Before→After</Text>
          </Pressable>
        ) : null}
        {recipeAvailable ? (
          <Pressable style={styles.inlineButton} onPress={onOpenRecipe}>
            <Text style={styles.inlineButtonText}>Recipe files</Text>
          </Pressable>
        ) : null}
        {run.diffStat.available || run.slotId ? (
          <Pressable style={styles.inlineButton} onPress={onOpenDiff}>
            <Text style={styles.inlineButtonText}>Diff view</Text>
          </Pressable>
        ) : null}
        {run.prNumber ? (
          <Pressable style={styles.inlineButton} onPress={onOpenPR}>
            <Text style={styles.inlineButtonText}>PR</Text>
          </Pressable>
        ) : null}
        {readyDecision ? (
          <Pressable
            style={[styles.inlineButton, !readyDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(readyDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !readyDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Ready
            </Text>
          </Pressable>
        ) : null}
        {reviewGateDecision ? (
          <Pressable
            style={[styles.inlineButton, !reviewGateDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(reviewGateDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !reviewGateDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Review
            </Text>
          </Pressable>
        ) : null}
        {retrospective ? (
          <Pressable
            style={[styles.inlineButton, !retrospective.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(retrospective.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !retrospective.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Retro
            </Text>
          </Pressable>
        ) : null}
        {run.slotId ? (
          <>
            <Pressable style={styles.inlineButton} onPress={onOpenSlot}>
              <Text style={styles.inlineButtonText}>Slot</Text>
            </Pressable>
            <Pressable style={styles.inlineButton} onPress={onOpenTerminal}>
              <Text style={styles.inlineButtonText}>Terminal</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

function RunCard({
  run,
  active,
  recipeEvidence,
  recipeArtifactCount,
  recipeAvailable,
  gatewayUrl,
  artifactAuthHeaders,
  onFocusRun,
  onOpenRun,
  onOpenArtifacts,
  onOpenCompare,
  onOpenRecipeCompare,
  onOpenRecipe,
  onOpenDiff,
  onOpenDecision,
  onOpenTerminal,
  onOpenSlot,
  onOpenPR,
}: {
  run: FamilyObservabilityRunSummary;
  active: boolean;
  recipeEvidence: FamilyRecipeEvidenceSummary | null;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onFocusRun: () => void;
  onOpenRun: () => void;
  onOpenArtifacts: () => void;
  onOpenCompare: (artifactPath: string) => void;
  onOpenRecipeCompare: (artifactPath?: string) => void;
  onOpenRecipe: () => void;
  onOpenDiff: () => void;
  onOpenDecision: (decisionId: string) => void;
  onOpenTerminal: () => void;
  onOpenSlot: () => void;
  onOpenPR: () => void;
}) {
  const statusColor = STATUS_COLORS[run.status] ?? colors.textMuted;
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const recipeValue =
    recipeArtifactCount !== null ? String(recipeArtifactCount) : recipeAvailable ? 'yes' : '-';
  const diffValue = run.diffStat.available
    ? `+${run.diffStat.additions}`
    : run.slotId
      ? 'workspace'
      : '-';
  const visualPairSummary = groupVisualArtifactPairs(run.artifacts, (artifact) =>
    artifactUrl(gatewayUrl, run.runId, artifact.path),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const recipePairCount = recipeEvidence?.pairCount ?? 0;
  const recipePrimaryVisualPair = recipeEvidence?.primaryPair ?? null;
  const comparePairCount =
    visualPairSummary.pairs.length > 0 ? visualPairSummary.pairs.length : recipePairCount;
  const previewPair = primaryVisualPair ?? recipePrimaryVisualPair;
  const previewPairIsRecipe = !primaryVisualPair && Boolean(recipePrimaryVisualPair);
  return (
    <Pressable style={[styles.runCard, active && styles.runCardActive]} onPress={onFocusRun}>
      <View style={styles.headerRow}>
        <View style={styles.runTitleBlock}>
          <Text style={styles.runTitle} numberOfLines={1}>
            {run.ticketOrPr}
          </Text>
          <Text style={baseStyles.textMuted} numberOfLines={1}>
            {run.flowType} · {run.lane}
            {run.variant ? ` · ${run.variant}` : ''}
          </Text>
        </View>
        <View style={[styles.runStatusBadge, { backgroundColor: statusColor + '22' }]}>
          <Text style={[styles.runStatusText, { color: statusColor }]}>{run.status}</Text>
        </View>
      </View>
      {run.summary ? (
        <Text style={baseStyles.textSecondary} numberOfLines={2}>
          {run.summary}
        </Text>
      ) : null}
      <View style={styles.runMetaGrid}>
        <Metric
          label="Evidence files"
          value={String(run.artifacts.length)}
          compact
          onPress={onOpenArtifacts}
        />
        <Metric
          label="Recipe files"
          value={recipeValue}
          compact
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <Metric
          label="Diff view"
          value={diffValue}
          compact
          onPress={onOpenDiff}
          disabled={!run.diffStat.available && !run.slotId}
        />
        <Metric
          label="Before→After"
          value={String(comparePairCount)}
          compact
          onPress={() => {
            if (primaryVisualPair) onOpenCompare(primaryVisualPair.after.path);
            else onOpenRecipeCompare();
          }}
          disabled={comparePairCount === 0}
        />
        <Metric
          label="Slot"
          value={run.slotId ?? '-'}
          compact
          onPress={onOpenSlot}
          disabled={!run.slotId}
        />
      </View>
      {previewPair ? (
        <View style={styles.runCardComparePreview}>
          <BeforeAfterPreview
            pair={previewPair}
            authHeaders={artifactAuthHeaders}
            onOpenArtifact={(artifactPath) => {
              if (previewPairIsRecipe) onOpenRecipeCompare(artifactPath);
              else onOpenCompare(artifactPath);
            }}
            eyebrow={previewPairIsRecipe ? 'Recipe evidence' : 'Run evidence'}
            title={previewPairIsRecipe ? 'Recipe before → after' : 'Run before → after'}
            hint="Tap side"
            imageHeight={58}
          />
        </View>
      ) : null}
      <View style={styles.runActions}>
        <Pressable
          style={[styles.inlineButton, active && styles.inlineButtonActive]}
          disabled={active}
          onPress={onFocusRun}
        >
          <Text style={[styles.inlineButtonText, active && styles.inlineButtonTextActive]}>
            {active ? 'Focused' : 'Focus'}
          </Text>
        </Pressable>
        <Pressable style={styles.inlineButton} onPress={onOpenRun}>
          <Text style={styles.inlineButtonText}>Run detail</Text>
        </Pressable>
        <Pressable style={styles.inlineButton} onPress={onOpenArtifacts}>
          <Text style={styles.inlineButtonText}>Evidence files</Text>
        </Pressable>
        {comparePairCount > 0 ? (
          <Pressable
            style={styles.inlineButton}
            onPress={() => {
              if (primaryVisualPair) onOpenCompare(primaryVisualPair.after.path);
              else onOpenRecipeCompare();
            }}
          >
            <Text style={styles.inlineButtonText}>Before→After</Text>
          </Pressable>
        ) : null}
        {recipeAvailable ? (
          <Pressable style={styles.inlineButton} onPress={onOpenRecipe}>
            <Text style={styles.inlineButtonText}>Recipe files</Text>
          </Pressable>
        ) : null}
        {run.diffStat.available || run.slotId ? (
          <Pressable style={styles.inlineButton} onPress={onOpenDiff}>
            <Text style={styles.inlineButtonText}>Diff view</Text>
          </Pressable>
        ) : null}
        {run.prNumber ? (
          <Pressable style={styles.inlineButton} onPress={onOpenPR}>
            <Text style={styles.inlineButtonText}>PR</Text>
          </Pressable>
        ) : null}
        {readyDecision ? (
          <Pressable
            style={[styles.inlineButton, !readyDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(readyDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !readyDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Ready
            </Text>
          </Pressable>
        ) : null}
        {reviewGateDecision ? (
          <Pressable
            style={[styles.inlineButton, !reviewGateDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(reviewGateDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !reviewGateDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Review
            </Text>
          </Pressable>
        ) : null}
        {retroDecision ? (
          <Pressable
            style={[styles.inlineButton, !retroDecision.resolvedAt && styles.reviewButton]}
            onPress={() => onOpenDecision(retroDecision.id)}
          >
            <Text
              style={[
                styles.inlineButtonText,
                !retroDecision.resolvedAt && styles.reviewButtonText,
              ]}
            >
              Retro
            </Text>
          </Pressable>
        ) : null}
        {run.slotId ? (
          <>
            <Pressable style={styles.inlineButton} onPress={onOpenSlot}>
              <Text style={styles.inlineButtonText}>Slot</Text>
            </Pressable>
            <Pressable style={styles.inlineButton} onPress={onOpenTerminal}>
              <Text style={styles.inlineButtonText}>Terminal</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </Pressable>
  );
}

function hasRecipeArtifacts(run: {
  artifacts: Array<{ path: string; purpose?: string | null }>;
}): boolean {
  return hasRecipeArtifactEntries(run.artifacts);
}

function hasRecipeArtifactEntries(
  artifacts: Array<{ path: string; purpose?: string | null }>,
): boolean {
  return artifacts.some((artifact) => {
    const path = artifact.path.toLowerCase();
    const purpose = artifact.purpose?.toLowerCase() ?? '';
    return path.includes('recipe') || purpose.includes('recipe');
  });
}

function FocusedRunRecipeQualityPanel({
  run,
  gatewayUrl,
  artifactAuthHeaders,
  recipeRuns,
  onOpenRecipe,
  onOpenRecipeArtifact,
  onOpenArtifacts,
}: {
  run: FamilyObservabilityRunSummary;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  recipeRuns: RecipeRunArtifactGroup[];
  onOpenRecipe: () => void;
  onOpenRecipeArtifact: (
    recipeRunId: string,
    artifactPath: string,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => void;
  onOpenArtifacts: () => void;
}) {
  const artifact = run.recipeQualityArtifact;
  const quality = run.recipeQuality;
  const previewRecipeRun = recipeRuns.find((group) => group.promoted) ?? recipeRuns[0] ?? null;
  const previewArtifacts = previewRecipeRun ? artifactsForRecipeRun(previewRecipeRun) : [];
  const visualPairSummary = groupVisualArtifactPairs(previewArtifacts, (entry) =>
    artifactUrlForEntry(gatewayUrl, run.runId, entry),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  if (!artifact && quality.semantic === 'unknown' && !primaryVisualPair) return null;

  const tone = recipeQualityColor(artifact?.verdict ?? quality.semantic);
  const reasons = artifact?.compact.reasons ?? [quality.reasoning].filter(Boolean);
  const guidance = artifact?.compact.better_version_guidance ?? [];
  const findings = [
    ...(artifact?.structural_findings ?? []),
    ...(artifact?.contextual_findings ?? []),
  ];
  return (
    <View style={[styles.recipeQualityBox, { borderColor: tone + '66' }]}>
      <View style={styles.focusRetroHeader}>
        <View>
          <Text style={[styles.recipeQualityLabel, { color: tone }]}>Recipe quality</Text>
          <Text style={styles.focusRetroMeta}>
            {artifact?.compact.verdict ?? quality.semantic.toUpperCase()}
            {quality.score != null ? ` · ${quality.score}` : ''} · {quality.source}
          </Text>
        </View>
        <View style={styles.retroActionRow}>
          <Pressable style={styles.retroActionButton} onPress={onOpenRecipe}>
            <Text style={styles.retroActionText}>Recipe files</Text>
          </Pressable>
          <Pressable style={styles.retroActionButton} onPress={onOpenArtifacts}>
            <Text style={styles.retroActionText}>Evidence files</Text>
          </Pressable>
        </View>
      </View>
      {reasons.length > 0 ? (
        <View style={styles.recipeQualityList}>
          {reasons.slice(0, 3).map((reason) => (
            <Text key={reason} style={styles.recipeQualityText} numberOfLines={2}>
              • {reason}
            </Text>
          ))}
        </View>
      ) : null}
      {primaryVisualPair ? (
        <BeforeAfterPreview
          pair={primaryVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={(artifactPath) => {
            const target = [primaryVisualPair.before, primaryVisualPair.after].find(
              (entry) => entry.path === artifactPath,
            );
            onOpenRecipeArtifact(
              target?.recipeRunId ?? previewRecipeRun?.id ?? '',
              artifactPath,
              artifactFilterParamForWorkspaceNav('compare'),
            );
          }}
          title="Recipe before → after"
          hint="Tap to inspect"
          imageHeight={72}
        />
      ) : null}
      {guidance.length > 0 ? (
        <View style={styles.recipeQualityGuidance}>
          <Text style={styles.recipeQualityGuidanceTitle}>Better next recipe</Text>
          {guidance.slice(0, 2).map((item) => (
            <Text key={item} style={styles.recipeQualityText} numberOfLines={2}>
              • {item}
            </Text>
          ))}
        </View>
      ) : null}
      {findings.length > 0 ? (
        <Text style={styles.recipeQualityFindings} numberOfLines={1}>
          Findings:{' '}
          {findings
            .slice(0, 3)
            .map((finding) => finding.code)
            .join(' · ')}
        </Text>
      ) : null}
      {artifact?.meta.fallback_used ? (
        <Text style={styles.recipeQualityFindings} numberOfLines={1}>
          Fallback source: {artifact.meta.fallback_source ?? artifact.meta.producer}
        </Text>
      ) : null}
    </View>
  );
}

function recipeQualityColor(value: string): string {
  if (value === 'pass' || value === 'good' || value === 'PASS') return colors.statusOk;
  if (value === 'fail' || value === 'bad' || value === 'FAIL') return colors.statusFail;
  if (value === 'warn' || value === 'ok' || value === 'WARN') return colors.statusWarn;
  return colors.textMuted;
}

function FocusedRunEvidencePreview({
  run,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenArtifacts,
  onOpenArtifact,
  onOpenVisual,
  onOpenDocument,
  onOpenDiffArtifact,
}: {
  run: FamilyObservabilityRunSummary;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onOpenArtifacts: () => void;
  onOpenArtifact: (artifactPath: string) => void;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
}) {
  const visualArtifacts = run.artifacts
    .filter((artifact) => ['image', 'video'].includes(classifyArtifact(artifact)))
    .slice(0, 4);
  const previewArtifacts = visualArtifacts.length > 0 ? visualArtifacts : run.artifacts.slice(0, 4);
  const documentArtifacts = run.artifacts
    .filter((artifact) => classifyArtifact(artifact) === 'document')
    .slice(0, 3);
  const diffArtifact = run.artifacts.find(
    (artifact) => diffArtifactCandidate([artifact])?.path === artifact.path,
  );
  const visualPairSummary = groupVisualArtifactPairs(run.artifacts, (artifact) =>
    familyArtifactUrl(gatewayUrl, artifact),
  );
  const primaryVisualPair = visualPairSummary.pairs[0] ?? null;
  const hiddenCount = Math.max(0, run.artifacts.length - previewArtifacts.length);

  return (
    <View style={styles.focusEvidenceBox}>
      <View style={styles.focusEvidenceHeader}>
        <View style={styles.focusEvidenceTitleBlock}>
          <Text style={styles.focusEvidenceTitle}>Run evidence</Text>
          <Text style={styles.focusEvidenceMeta} numberOfLines={1}>
            {run.artifacts.length} artifact{run.artifacts.length === 1 ? '' : 's'}
            {visualArtifacts.length ? ` · ${visualArtifacts.length} visual` : ''}
            {visualPairSummary.pairs.length
              ? ` · ${visualPairSummary.pairs.length} before→after pair${
                  visualPairSummary.pairs.length === 1 ? '' : 's'
                }`
              : ''}
            {diffArtifact ? ' · diff available' : ''}
          </Text>
        </View>
        <Pressable style={styles.focusEvidenceOpenButton} onPress={onOpenArtifacts}>
          <Text style={styles.focusEvidenceOpenText}>Evidence files</Text>
        </Pressable>
      </View>
      {primaryVisualPair ? (
        <BeforeAfterPreview
          pair={primaryVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={onOpenArtifact}
          title="Run before → after"
          hint="Tap to inspect"
          imageHeight={74}
        />
      ) : null}
      <View style={styles.focusEvidenceStrip}>
        {previewArtifacts.map((artifact) => {
          const url = familyArtifactUrl(gatewayUrl, artifact);
          const mediaType = classifyArtifact(artifact);
          const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
          const onPress =
            mediaType === 'image' || mediaType === 'video'
              ? () => onOpenVisual(url)
              : isDiffArtifact
                ? () => onOpenDiffArtifact(artifact)
                : mediaType === 'document'
                  ? () => onOpenDocument(artifact)
                  : () => onOpenArtifact(artifact.path);
          return (
            <Pressable
              key={`${artifact.runId}:${artifact.path}`}
              style={styles.focusEvidenceItem}
              onPress={onPress}
            >
              {mediaType === 'image' ? (
                <Image
                  source={{ uri: url, headers: artifactAuthHeaders }}
                  style={styles.focusEvidenceImage}
                />
              ) : (
                <View style={styles.focusEvidenceDoc}>
                  <Text style={styles.focusEvidenceDocType}>
                    {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
                  </Text>
                </View>
              )}
              <Text style={styles.focusEvidencePath} numberOfLines={1}>
                {artifact.path.split('/').pop() ?? artifact.path}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {documentArtifacts.length > 0 ? (
        <View style={styles.focusEvidenceDocRow}>
          {documentArtifacts.map((artifact) => {
            const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
            return (
              <Pressable
                key={`doc:${artifact.runId}:${artifact.path}`}
                style={styles.focusEvidenceDocChip}
                onPress={() =>
                  isDiffArtifact ? onOpenDiffArtifact(artifact) : onOpenDocument(artifact)
                }
              >
                <Text style={styles.focusEvidenceDocChipText} numberOfLines={1}>
                  {isDiffArtifact ? 'Diff' : (artifact.path.split('/').pop() ?? artifact.path)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {hiddenCount > 0 ? (
        <Pressable style={styles.focusEvidenceMoreButton} onPress={onOpenArtifacts}>
          <Text style={styles.focusEvidenceMoreText}>+{hiddenCount} more artifacts</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function EvidenceGroupCard({
  group,
  gatewayUrl,
  artifactAuthHeaders,
  onOpenDocument,
  onOpenDiffArtifact,
  onOpenVisual,
  onOpenRun,
  onOpenArtifacts,
  onOpenRecipe,
  onOpenDiff,
  onOpenTerminal,
  onOpenSlot,
}: {
  group: FamilyEvidenceGroup;
  gatewayUrl: string;
  artifactAuthHeaders: Record<string, string>;
  onOpenDocument: (artifact: FamilyObservabilityArtifact) => void;
  onOpenDiffArtifact: (artifact: FamilyObservabilityArtifact) => void;
  onOpenVisual: (uri: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenArtifacts: (runId: string, artifactPath?: string) => void;
  onOpenRecipe: (runId: string) => void;
  onOpenDiff: (run: NonNullable<FamilyEvidenceGroup['run']>) => void;
  onOpenTerminal: (slotId: string, runId: string) => void;
  onOpenSlot: (slotId: string, runId: string) => void;
}) {
  const visibleArtifacts = group.artifacts.slice(0, MAX_ARTIFACTS_PER_FAMILY_EVIDENCE_GROUP);
  const hiddenArtifacts = group.artifacts.length - visibleArtifacts.length;
  const sourceRun = group.run;
  const groupWorkspaceRunId = sourceRun?.runId ?? group.artifacts[0]?.runId ?? null;
  const visualPairs = groupVisualArtifactPairs(group.artifacts, (artifact) =>
    familyArtifactUrl(gatewayUrl, artifact),
  ).pairs;
  const primaryVisualPair = visualPairs[0] ?? null;
  const openGroupPairArtifact = (artifactPath: string) => {
    const artifact = group.artifacts.find((item) => item.path === artifactPath);
    const targetRunId = artifact?.runId ?? groupWorkspaceRunId;
    if (targetRunId) {
      onOpenArtifacts(targetRunId, artifactPath);
    }
  };
  return (
    <View style={[styles.evidenceGroupCard, group.capturedBeforeRun && styles.carriedGroupCard]}>
      <View style={styles.evidenceGroupHeader}>
        <View style={styles.evidenceGroupTitleWrap}>
          <Text style={styles.evidenceGroupTitle}>{group.title}</Text>
          <Text style={styles.evidenceGroupMeta} numberOfLines={2}>
            {group.subtitle}
          </Text>
        </View>
        <View style={styles.evidenceGroupHeaderActions}>
          <Text style={styles.evidenceGroupCount}>{group.artifacts.length}</Text>
          {groupWorkspaceRunId ? (
            <Pressable
              style={styles.evidenceGroupWorkspaceButton}
              onPress={() => onOpenArtifacts(groupWorkspaceRunId)}
            >
              <Text style={styles.evidenceGroupWorkspaceText}>Workspace</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {primaryVisualPair ? (
        <BeforeAfterPreview
          pair={primaryVisualPair}
          authHeaders={artifactAuthHeaders}
          onOpenArtifact={openGroupPairArtifact}
          eyebrow="Family evidence"
          title="Evidence before → after"
          hint={`${visualPairs.length} pair${visualPairs.length === 1 ? '' : 's'}`}
          imageHeight={74}
        />
      ) : null}
      <View style={styles.artifactGrid}>
        {visibleArtifacts.map((artifact) => {
          const url = familyArtifactUrl(gatewayUrl, artifact);
          const mediaType = classifyArtifact(artifact);
          const kind = familyArtifactKind(artifact);
          const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
          return (
            <ArtifactCell key={`${artifact.runId}:${artifact.path}`}>
              <View style={styles.artifactKindRow}>
                <Text style={[styles.artifactKindText, artifactKindStyle(kind)]}>
                  {familyEvidenceKindLabel(kind)}
                </Text>
                {group.run ? (
                  <Text style={styles.artifactRunText}>{familyRunBadgeLabel(group.run)}</Text>
                ) : null}
              </View>
              <ArtifactCard
                url={url}
                path={artifact.path}
                purpose={artifact.purpose}
                sizeBytes={artifact.sizeBytes}
                authHeaders={artifactAuthHeaders}
                onPressImage={mediaType === 'image' ? () => onOpenVisual(url) : undefined}
                onPressVideo={mediaType === 'video' ? () => onOpenVisual(url) : undefined}
                onPressDocument={
                  mediaType === 'document'
                    ? isDiffArtifact
                      ? () => onOpenDiffArtifact(artifact)
                      : () => onOpenDocument(artifact)
                    : undefined
                }
                documentLabel={isDiffArtifact ? 'DIFF' : undefined}
                documentHint={isDiffArtifact ? 'Tap to review diff' : undefined}
              />
              <Pressable
                style={styles.artifactWorkspaceButton}
                onPress={() => onOpenArtifacts(artifact.runId, artifact.path)}
              >
                <Text style={styles.artifactWorkspaceText}>
                  {isDiffArtifact ? 'Open diff' : 'Open in artifacts'}
                </Text>
              </Pressable>
            </ArtifactCell>
          );
        })}
      </View>
      {hiddenArtifacts > 0 ? (
        groupWorkspaceRunId ? (
          <Pressable
            style={styles.evidenceGroupMoreButton}
            onPress={() => onOpenArtifacts(groupWorkspaceRunId)}
          >
            <Text style={styles.evidenceGroupMore}>
              +{hiddenArtifacts} more in this batch · open all
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.evidenceGroupMore}>+{hiddenArtifacts} more in this batch</Text>
        )
      ) : null}
      {sourceRun ? (
        <View style={styles.evidenceGroupActions}>
          <Pressable style={styles.inlineButton} onPress={() => onOpenRun(sourceRun.runId)}>
            <Text style={styles.inlineButtonText}>Run detail</Text>
          </Pressable>
          <Pressable style={styles.inlineButton} onPress={() => onOpenArtifacts(sourceRun.runId)}>
            <Text style={styles.inlineButtonText}>Evidence files</Text>
          </Pressable>
          {hasRecipeArtifactEntries(group.artifacts) ? (
            <Pressable style={styles.inlineButton} onPress={() => onOpenRecipe(sourceRun.runId)}>
              <Text style={styles.inlineButtonText}>Recipe files</Text>
            </Pressable>
          ) : null}
          {sourceRun.diffStat.available || sourceRun.slotId ? (
            <Pressable style={styles.inlineButton} onPress={() => onOpenDiff(sourceRun)}>
              <Text style={styles.inlineButtonText}>Diff view</Text>
            </Pressable>
          ) : null}
          {sourceRun.slotId ? (
            <>
              <Pressable
                style={styles.inlineButton}
                onPress={() => onOpenSlot(sourceRun.slotId!, sourceRun.runId)}
              >
                <Text style={styles.inlineButtonText}>Slot</Text>
              </Pressable>
              <Pressable
                style={styles.inlineButton}
                onPress={() => onOpenTerminal(sourceRun.slotId!, sourceRun.runId)}
              >
                <Text style={styles.inlineButtonText}>Terminal</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function artifactKindStyle(kind: ReturnType<typeof familyArtifactKind>) {
  if (kind === 'before') return styles.artifactKindBefore;
  if (kind === 'after') return styles.artifactKindAfter;
  return styles.artifactKindSetup;
}

function ArtifactCell({ children }: { children: React.ReactNode }) {
  return <View style={styles.artifactCell}>{children}</View>;
}

function Metric({
  label,
  value,
  compact = false,
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
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        style={[
          styles.metricItem,
          compact && styles.metricItemCompact,
          disabled && styles.familyCockpitDisabled,
        ]}
        onPress={onPress}
        disabled={disabled}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={[styles.metricItem, compact && styles.metricItemCompact]}>{content}</View>;
}

function workflowStateColor(state: FamilyObservabilitySnapshot['workflowState']): string {
  if (state === 'complete') return colors.statusOk;
  if (state === 'failed') return colors.statusFail;
  return colors.statusWarn;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
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
    gap: spacing.md,
    marginBottom: spacing.xl,
    padding: spacing.xl,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  statusBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  statusText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  generatedText: { color: colors.textMuted, fontSize: fonts.sizeXs },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXl,
    fontWeight: '900',
  },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  metricItem: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    flexGrow: 1,
    minWidth: 120,
    padding: spacing.md,
  },
  metricItemCompact: {
    minWidth: 82,
    padding: spacing.sm,
  },
  metricLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  metricValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    marginTop: spacing.xs,
  },
  familyCockpit: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '33',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.xl,
    padding: spacing.sm,
  },
  familyCockpitHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  familyCockpitTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  familyCockpitTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  familyCockpitMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  familyCockpitRail: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  familyCockpitTile: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 104,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  familyCockpitTileLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  familyCockpitTileValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  familyCockpitTileHint: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 2,
    maxWidth: 110,
  },
  familyCockpitAction: {
    backgroundColor: colors.accent + '14',
    borderColor: colors.accent + '44',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  familyCockpitActionPrimary: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
  },
  familyCockpitActionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  familyCockpitActionTextPrimary: {
    color: colors.textPrimary,
  },
  familyCockpitDisabled: {
    opacity: 0.45,
  },
  familyFocusedArtifactCard: {
    backgroundColor: colors.accent + '12',
    borderColor: colors.accent + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.xl,
    padding: spacing.sm,
  },
  familyFocusedArtifactEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  familyFocusedArtifactPath: {
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  familyFocusedArtifactMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  familyBeforeAfterPriorityPanel: {
    backgroundColor: colors.accent + '10',
    borderColor: colors.accent + '44',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.xl,
    padding: spacing.sm,
  },
  familyBeforeAfterPriorityActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  familyBeforeAfterPriorityCopy: {
    color: colors.textMuted,
    flex: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  familyBeforeAfterPriorityButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  familyBeforeAfterPriorityButtonText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  familyBeforeAfterPriorityRail: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  section: { marginBottom: spacing.xl },
  focusRunCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    marginBottom: spacing.xl,
    padding: spacing.lg,
  },
  focusRunCardActive: {
    borderColor: colors.accent,
  },
  focusRunHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  focusRunSelectButton: {
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  focusRunSelectText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  focusRunTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
  },
  focusRunMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  focusEvidenceBox: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '33',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  focusEvidenceHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  focusEvidenceTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  focusEvidenceTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  focusEvidenceMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  focusEvidenceOpenButton: {
    backgroundColor: colors.accent + '20',
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  focusEvidenceOpenText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  focusEvidenceStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  focusEvidenceItem: {
    flex: 1,
    minWidth: 0,
  },
  focusEvidenceImage: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.sm,
    height: 72,
    width: '100%',
  },
  focusEvidenceDoc: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.sm,
    borderWidth: 1,
    height: 72,
    justifyContent: 'center',
  },
  focusEvidenceDocType: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  focusEvidencePath: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  focusEvidenceDocRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  focusEvidenceDocChip: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 180,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  focusEvidenceDocChipText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  focusEvidenceMoreButton: {
    alignSelf: 'flex-start',
  },
  focusEvidenceMoreText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  focusRetroBox: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.md,
  },
  focusRetroHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  focusRetroLabel: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  focusRetroText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 20,
  },
  recipeQualityBox: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  recipeQualityLabel: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  recipeQualityList: {
    gap: spacing.xs,
  },
  recipeQualityGuidance: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.sm,
  },
  recipeQualityGuidanceTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  recipeQualityText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  recipeQualityFindings: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  familyDecisionPanel: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  familyDecisionTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  familyDecisionCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderLeftWidth: 3,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  familyDecisionBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  familyDecisionBadgeText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  familyDecisionCardTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  familyDecisionSummary: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
  familyDecisionChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  familyDecisionChip: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  familyDecisionChipText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  focusRetroMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
    textTransform: 'uppercase',
  },
  sectionMeta: { color: colors.textMuted, fontSize: fonts.sizeXs },
  compactOpenButton: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  compactOpenText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  ledgerMetricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  ledgerEntries: {
    gap: spacing.sm,
  },
  ledgerEntryCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  ledgerEntryHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  ledgerEntryTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  ledgerEntryTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  ledgerEntryMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  ledgerEntryPr: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  ledgerEntryFacts: {
    gap: spacing.xs,
  },
  ledgerFact: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
  },
  ledgerMissing: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  ledgerMoreText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  comparePairCard: {
    marginRight: spacing.md,
    width: 320,
  },
  comparePairActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  comparePairAction: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  comparePairActionText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textAlign: 'center',
  },
  compareMoreText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  filterChip: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgInput,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  filterChipActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
  },
  filterChipText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  filterChipTextActive: {
    color: colors.accent,
  },
  evidenceNote: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 17,
    marginBottom: spacing.md,
  },
  errorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
    marginBottom: spacing.lg,
  },
  retroCard: {
    backgroundColor: colors.statusWarn + '14',
    borderColor: colors.statusWarn + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.lg,
  },
  retroHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  retroRun: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  retroStatusBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  retroStatusText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  retroTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
  retroMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  retroMeta: { color: colors.textMuted, fontSize: fonts.sizeXs },
  retroEvidencePath: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  retroEvidencePreview: {
    backgroundColor: colors.bgInput,
    borderColor: colors.statusWarn + '33',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  retroEvidencePreviewHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  retroEvidencePreviewTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  retroEvidencePreviewOpen: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  retroSignalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  retroSignalChip: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.sm,
    minWidth: 82,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  retroSignalChipPressable: {
    borderColor: colors.statusWarn + '55',
    borderWidth: 1,
  },
  retroSignalLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  retroSignalValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: 2,
  },
  retroActionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingRight: spacing.md,
  },
  retroActionButton: {
    borderColor: colors.statusWarn + '55',
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 104,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  retroActionButtonPrimary: {
    backgroundColor: colors.statusWarn + '22',
  },
  retroActionText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  retroActionTextPrimary: {
    color: colors.textPrimary,
  },
  retroActionValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  runCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCard,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.lg,
  },
  runCardActive: {
    borderColor: colors.accent,
  },
  runTitleBlock: { flex: 1, minWidth: 0 },
  runTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
  runStatusBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  runStatusText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  runMetaGrid: { flexDirection: 'row', gap: spacing.sm },
  runCardComparePreview: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '24',
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.xs,
  },
  runActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  inlineButton: {
    backgroundColor: colors.accent + '20',
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  inlineButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  inlineButtonActive: {
    backgroundColor: colors.statusOk + '20',
    borderColor: colors.statusOk + '66',
  },
  inlineButtonTextActive: {
    color: colors.statusOk,
  },
  reviewButton: {
    backgroundColor: colors.statusWarn + '20',
    borderColor: colors.statusWarn + '66',
  },
  reviewButtonText: {
    color: colors.statusWarn,
  },
  artifactGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  artifactCell: {
    marginBottom: spacing.md,
  },
  artifactWorkspaceButton: {
    alignItems: 'center',
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '44',
    borderRadius: radii.sm,
    borderWidth: 1,
    marginTop: spacing.xs,
    paddingVertical: spacing.xs,
  },
  artifactWorkspaceText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  evidenceGroupCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    marginBottom: spacing.lg,
    padding: spacing.md,
  },
  carriedGroupCard: {
    borderColor: colors.statusWarn + '55',
  },
  evidenceGroupHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  evidenceGroupTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  evidenceGroupTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  evidenceGroupMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  evidenceGroupHeaderActions: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  evidenceGroupCount: {
    backgroundColor: colors.bgInput,
    borderRadius: 999,
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  evidenceGroupWorkspaceButton: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '44',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  evidenceGroupWorkspaceText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  artifactKindRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  artifactKindText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  artifactKindBefore: {
    color: colors.statusWarn,
  },
  artifactKindAfter: {
    color: colors.statusOk,
  },
  artifactKindSetup: {
    color: colors.textMuted,
  },
  artifactRunText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  evidenceGroupMoreButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  evidenceGroupMore: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  evidenceGroupActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  learningCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.lg,
  },
  learningTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
});
