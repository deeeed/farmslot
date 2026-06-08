import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type FamilyObservabilityArtifact,
  type FamilyObservabilityGetResult,
  type FamilyObservabilityRunSummary,
  type FamilyObservabilitySnapshot,
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import type { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import {
  artifactsForRecipeRun,
  artifactUrlForEntry,
  classifyArtifact,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
} from '../../lib/artifact-url';
import { diffArtifactCandidate } from '../../lib/diff';
import {
  buildFamilyEvidenceGroups,
  familyArtifactKind,
  type FamilyEvidenceFilter,
  filterFamilyEvidenceGroups,
} from '../../lib/family-evidence';
import { shouldRefreshFamilySnapshotForRunEvent } from '../../lib/family-refresh';
import { collectFamilyRetrospectives } from '../../lib/family-retrospectives';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { runRefreshEventRunId } from '../../lib/run-refresh';
import { selectSlotRecipeArtifactsForPreviewScope } from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
} from '../../lib/task-progress';
import { spacing } from '../../lib/theme';
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
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceForArtifactRoute,
  targetWorkspaceRouteContextParams,
  workspaceForFamilySection,
  workspaceNavCurrentForRoute,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import {
  type WorkspaceStickyNavLayout,
  workspaceStickyNavThreshold,
} from '../../lib/workspace-sticky-nav';
import { useConnectionStore } from '../../store/connection';
import { routeParamString } from '../workspace-shared/route-params';

import {
  familyArtifactUrl,
  familyRunDecisionNavMeta,
  hasRecipeArtifacts,
  recipeRunIdForVisualPair,
  summarizeFamilyRecipeEvidence,
  workflowStateColor,
} from './components/family-workspace-panels';
import {
  type FamilyRecipeEvidenceSummary,
  type FamilySectionKey,
  normalizeFamilySectionParam,
} from './family-workspace-model';

export function useFamilyWorkspaceController() {
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
  const [documentViewer, setDocumentViewer] = useState<{
    title: string;
    body: string;
  } | null>(null);
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
        const result = await client.request<RunGetResult>('run.get', {
          runId: targetRunId,
        });
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
          .request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
            runId: familyRunId,
          })
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
          setDocumentViewer({
            title: artifact.path.split('/').pop() ?? artifact.path,
            body,
          }),
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
    return {
      status: 'loading' as const,
      snapshot: null,
      error,
      client,
      insets,
      goBackOrRuns,
    };
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
  const workspaceNavCurrent: ComponentProps<typeof RunWorkspaceNav>['current'] =
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

  return {
    status: 'ready' as const,
    snapshot,
    error: error ?? null,
    client,
    insets,
    goBackOrRuns,
    workflowColor,
    familyRetrospectives,
    pendingRetrospectiveCount,
    retrospectiveRouteContext,
    openPRForRun,
    selectedActiveTaskProgress,
    selectedFallbackTaskProgress,
    primaryDecision,
    readyDecision,
    reviewGateDecision,
    retroDecision,
    selectedRecipeAvailable,
    selectedDiffValue,
    requestedArtifactIsDiff,
    recipeEvidenceForRun,
    recipeCountForRun,
    recipeAvailableForRun,
    decisionRouteContextForRun,
    workspaceRecipeRunForRun,
    focusedArtifactForRun,
    focusedArtifactParamsForRun,
    recipeWorkspaceParamsForRun,
    openFamilyRunDiff,
    openSelectedRunDiff,
    priorityVisualPairs,
    priorityVisualPair,
    priorityVisualPairIsRecipe,
    priorityCompareRunId,
    priorityCompareRecipeRunId,
    selectedReadyMeta,
    selectedReviewMeta,
    selectedRetroMeta,
    workspaceNavProps,
    gatewayUrl,
    artifactAuthHeaders,
    viewerUri,
    setViewerUri,
    documentViewer,
    setDocumentViewer,
    evidenceFilter,
    setEvidenceFilter,
    navLayout,
    stickyNavVisible,
    scrollRef,
    scrollHandler,
    stickyNavStyle,
    rememberNavLayout,
    router,
    familyId,
    project,
    requestedSection,
    requestedRecipeRunId,
    requestedArtifactPath,
    workspaceRouteContext,
    selectedRun,
    selectedFullRun,
    selectedRecipeRuns,
    selectedRecipeVisualPairs,
    selectedRecipeArtifactCount,
    familyRecipeEvidence,
    visualPairs,
    evidenceGroups,
    filteredEvidenceGroups,
    evidenceCounts,
    taskProgress,
    taskProgressError,
    requestSectionScroll,
    targetRouteContext,
    diffRouteContext,
    artifactRouteContext,
    openDocument,
    openDiffArtifact,
    openFamilyRecipeArtifact,
    openFamilyArtifactWorkspace,
    rememberSection,
    scrollToSection,
    runForArtifact,
    visualViewerItems,
    viewerIndex,
    readyDecisionId: readyDecision?.id ?? null,
    reviewDecisionId: reviewGateDecision?.id ?? null,
    retroDecisionId: retroDecision?.id ?? null,
  };
}
