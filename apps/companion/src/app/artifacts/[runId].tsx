import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Events,
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type RunRefreshMirrorResult,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import { ArtifactCard } from '../../components/ArtifactCard';
import { BeforeAfterPreview } from '../../components/BeforeAfterPreview';
import { DocumentViewer } from '../../components/DocumentViewer';
import { EvidenceReviewWorkspace } from '../../components/EvidenceReviewWorkspace';
import { MediaViewer } from '../../components/MediaViewer';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { TaskProgressFallbackPanel, TaskProgressPanel } from '../../components/TaskProgressPanel';
import {
  type ArtifactStickyChromeLayout,
  artifactStickyChromeThreshold,
  artifactStickyChromeVisible,
} from '../../lib/artifact-sticky-chrome';
import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  deriveBaselineVisualArtifactPairs,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
  resolveRecipeRunSelection,
  type VisualArtifactPair,
} from '../../lib/artifact-url';
import {
  type ArtifactWorkspaceCounts,
  type ArtifactWorkspaceFilter,
  artifactWorkspaceFilterPresentation,
  artifactWorkspaceHeaderPresentation,
  buildArtifactWorkspaceCounts,
  filterArtifactWorkspace,
  isArtifactWorkspaceFilter,
} from '../../lib/artifact-workspace';
import { diffArtifactCandidate } from '../../lib/diff';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { runRefreshEventMatches } from '../../lib/run-refresh';
import { selectSlotRecipeArtifactsForPreviewScope } from '../../lib/slot-workspace';
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
import { summarizeRunWorkspaceNavMeta } from '../../lib/workspace-nav-meta';
import {
  artifactFilterParamForWorkspaceNav,
  artifactWorkspaceNavCurrent,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceRouteContextParams,
  type WorkspaceRouteContext,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useRunStore } from '../../store/runs';

const ARTIFACT_FILTERS: Array<{ id: ArtifactWorkspaceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
  { id: 'review', label: 'Review files' },
  { id: 'visual', label: 'Visual files' },
  { id: 'docs', label: 'Doc files' },
  { id: 'diffs', label: 'Diff files' },
  { id: 'recipes', label: 'Recipe files' },
  { id: 'supporting', label: 'Other' },
];
const ARTIFACT_STICKY_NAV_FALLBACK_THRESHOLD = 180;
const ARTIFACT_STICKY_NAV_ACTIVATION_LEAD = 96;
const ARTIFACT_STICKY_NAV_MAX_THRESHOLD = 32;

export default function ArtifactViewerScreen() {
  const { runId, recipeRun, artifact, filter, workspace, decisionKind } = useLocalSearchParams<{
    runId: string;
    recipeRun?: string;
    artifact?: string | string[];
    filter?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const storeRun = useRunStore((s) => s.runs.find((r) => r.id === runId));
  const [run, setRun] = useState<Run | null>(storeRun ?? null);
  const [recipeRunSelection, setRecipeRunSelection] = useState<{
    recipeRuns: RecipeRunArtifactGroup[];
    gatewaySelectedRecipeRunId: string | null;
  }>({ recipeRuns: [], gatewaySelectedRecipeRunId: null });
  const [selectedRecipeRunId, setSelectedRecipeRunId] = useState<string | null>(null);
  const [recipeRunGroupsLoaded, setRecipeRunGroupsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [documentViewer, setDocumentViewer] = useState<{ title: string; body: string } | null>(
    null,
  );
  const [artifactFilter, setArtifactFilter] = useState<ArtifactWorkspaceFilter>('all');
  const [artifactQuery, setArtifactQuery] = useState('');
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const [workspaceNavLayout, setWorkspaceNavLayout] = useState<ArtifactStickyChromeLayout | null>(
    null,
  );
  const [stickyNavVisible, setStickyNavVisible] = useState(false);
  const [artifactMirrorEpoch, setArtifactMirrorEpoch] = useState(0);
  const [artifactMirrorRefreshing, setArtifactMirrorRefreshing] = useState(false);
  const [artifactMirrorFeedback, setArtifactMirrorFeedback] = useState<string | null>(null);
  const stickyNavVisibleRef = useRef(false);
  const documentAbortRef = useRef<AbortController | null>(null);
  const runRefreshRequestRef = useRef(0);
  const recipeRunRefreshRequestRef = useRef(0);

  const { recipeRuns, gatewaySelectedRecipeRunId } = recipeRunSelection;

  useEffect(() => {
    return () => {
      documentAbortRef.current?.abort();
    };
  }, []);

  const requestedRecipeRunId = typeof recipeRun === 'string' ? recipeRun : null;
  const requestedArtifactQuery = routeParamString(artifact).trim();
  const requestedFilterParam = routeParamString(filter).trim();
  const requestedFilter = isArtifactWorkspaceFilter(requestedFilterParam)
    ? requestedFilterParam
    : null;
  const refreshRun = useCallback(
    async (reason: string) => {
      if (!client || !runId) return;
      const requestId = runRefreshRequestRef.current + 1;
      runRefreshRequestRef.current = requestId;
      try {
        const result = await client.request<RunGetResult>('run.get', { runId });
        if (runRefreshRequestRef.current !== requestId) return;
        setRun(result.run);
        setError(null);
      } catch (err) {
        if (runRefreshRequestRef.current !== requestId) return;
        setError(`Failed to refresh run artifacts after ${reason}: ${(err as Error).message}`);
      }
    },
    [client, runId],
  );

  useEffect(() => {
    void refreshRun('initial load');
  }, [refreshRun]);

  useEffect(() => {
    if (storeRun?.id === runId) setRun(storeRun);
  }, [runId, storeRun]);

  const refreshRecipeRuns = useCallback(
    async (reason: string, reset: boolean) => {
      const requestId = recipeRunRefreshRequestRef.current + 1;
      recipeRunRefreshRequestRef.current = requestId;
      if (!client || !runId) {
        setRecipeRunSelection({ recipeRuns: [], gatewaySelectedRecipeRunId: null });
        setRecipeRunGroupsLoaded(false);
        return;
      }
      if (reset) setRecipeRunGroupsLoaded(false);
      try {
        const result = await client.request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
          runId,
        });
        if (recipeRunRefreshRequestRef.current !== requestId) return;
        setRecipeRunSelection({
          recipeRuns: result.recipeRuns,
          gatewaySelectedRecipeRunId: result.selectedRecipeRunId,
        });
        setRecipeRunGroupsLoaded(true);
      } catch (err) {
        if (recipeRunRefreshRequestRef.current !== requestId) return;
        setRecipeRunGroupsLoaded(true);
        setError(`Failed to refresh recipe runs after ${reason}: ${(err as Error).message}`);
      }
    },
    [client, runId],
  );

  useEffect(() => {
    if (!client || !runId) return;
    const maybeRefreshRun = (payload: unknown, reason: string) => {
      if (!runRefreshEventMatches(runId, payload as { run?: Run; runId?: string })) return;
      const eventRun = (payload as { run?: Run }).run;
      if (eventRun?.id === runId) {
        runRefreshRequestRef.current += 1;
        setRun(eventRun);
        setError(null);
      } else {
        void refreshRun(reason);
      }
      void refreshRecipeRuns(reason, false);
    };
    const unsubscribers = [
      client.subscribe(Events.RUN_UPDATED, (payload) => maybeRefreshRun(payload, 'run.updated')),
      client.subscribe(Events.RUN_COMPLETED, (payload) =>
        maybeRefreshRun(payload, 'run.completed'),
      ),
      client.subscribe(Events.RUN_STEP_COMPLETED, (payload) =>
        maybeRefreshRun(payload, 'run.step.completed'),
      ),
      client.subscribe(Events.RUN_DECISION_NEW, (payload) =>
        maybeRefreshRun(payload, 'run.decision.new'),
      ),
      client.subscribe(Events.RUN_DECISION_UPDATED, (payload) =>
        maybeRefreshRun(payload, 'run.decision.updated'),
      ),
      client.subscribe(Events.RUN_DECISION_RESOLVED, (payload) =>
        maybeRefreshRun(payload, 'run.decision.resolved'),
      ),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [client, refreshRecipeRuns, refreshRun, runId]);

  useEffect(() => {
    if (!client || !runId) return;
    const timer = setInterval(() => {
      void refreshRun('poll');
    }, 30_000);
    return () => clearInterval(timer);
  }, [client, refreshRun, runId]);

  useEffect(() => {
    void refreshRecipeRuns('initial load', true);
  }, [refreshRecipeRuns]);

  useEffect(() => {
    setSelectedRecipeRunId(
      requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? null
        : resolveRecipeRunSelection(recipeRuns, requestedRecipeRunId, gatewaySelectedRecipeRunId),
    );
  }, [gatewaySelectedRecipeRunId, recipeRuns, requestedRecipeRunId]);

  useEffect(() => {
    if (!requestedArtifactQuery) return;
    if (!requestedFilter) setArtifactFilter('all');
    setArtifactQuery(requestedArtifactQuery);
  }, [requestedArtifactQuery, requestedFilter]);

  const awaitingRequestedRecipeRun = Boolean(
    !recipeRunGroupsLoaded &&
    requestedRecipeRunId &&
    requestedRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  );

  const selectedRecipeRun = useMemo(
    () => recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null,
    [recipeRuns, selectedRecipeRunId],
  );
  const totalRecipeArtifactCount = useMemo(
    () => recipeRuns.reduce((sum, group) => sum + artifactsForRecipeRun(group).length, 0),
    [recipeRuns],
  );
  const recipeAvailable = recipeRunGroupsLoaded ? totalRecipeArtifactCount > 0 : undefined;
  const workspaceRecipeRunId =
    requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : selectedRecipeRunId;
  const runArtifactCount = useMemo(() => (run ? extractRunArtifactManifest(run).length : 0), [run]);
  const manifest = useMemo(() => {
    if (awaitingRequestedRecipeRun) return [];
    if (selectedRecipeRun) return artifactsForRecipeRun(selectedRecipeRun);
    return run ? extractRunArtifactManifest(run) : [];
  }, [awaitingRequestedRecipeRun, run, selectedRecipeRun]);
  const artifactUrlFor = useCallback(
    (entry: ArtifactManifestEntry) =>
      artifactUrlForEntry(gatewayUrl, runId ?? '', entry, artifactMirrorEpoch),
    [artifactMirrorEpoch, gatewayUrl, runId],
  );
  const { pairs: strictVisualPairs } = useMemo(
    () =>
      runId
        ? groupArtifacts(manifest, gatewayUrl, runId, artifactMirrorEpoch)
        : { pairs: [], singles: manifest },
    [artifactMirrorEpoch, gatewayUrl, manifest, runId],
  );
  const derivedBaselinePairs = useMemo(
    () =>
      runId
        ? deriveBaselineVisualArtifactPairs(
            manifest,
            (entry) => artifactUrlForEntry(gatewayUrl, runId, entry, artifactMirrorEpoch),
            strictVisualPairs,
          )
        : [],
    [artifactMirrorEpoch, gatewayUrl, manifest, runId, strictVisualPairs],
  );
  const manifestVisualPairs = useMemo(
    () => [...strictVisualPairs, ...derivedBaselinePairs],
    [derivedBaselinePairs, strictVisualPairs],
  );
  const recipeFallbackPairs = useMemo(() => {
    if (selectedRecipeRun || manifestVisualPairs.length > 0 || !runId) return [];
    return groupVisualArtifactPairs(
      selectSlotRecipeArtifactsForPreviewScope(recipeRuns, selectedRecipeRunId),
      (entry) => artifactUrlForEntry(gatewayUrl, runId, entry, artifactMirrorEpoch),
    ).pairs;
  }, [
    artifactMirrorEpoch,
    gatewayUrl,
    manifestVisualPairs.length,
    recipeRuns,
    runId,
    selectedRecipeRun,
    selectedRecipeRunId,
  ]);
  const priorityVisualPairs =
    manifestVisualPairs.length > 0 ? manifestVisualPairs : recipeFallbackPairs;
  const priorityCompareArtifactPath = priorityVisualPairs[0]?.after.path ?? null;
  const priorityCompareRecipeRunId =
    manifestVisualPairs.length > 0
      ? workspaceRecipeRunId
      : recipeRunIdForVisualPair(recipeRuns, priorityVisualPairs[0] ?? null, selectedRecipeRunId);
  const priorityVisualPairCount = priorityVisualPairs.length;
  const artifactCounts = useMemo(() => buildArtifactWorkspaceCounts(manifest), [manifest]);
  const filteredSingles = useMemo(
    () => filterArtifactWorkspace(manifest, artifactFilter, artifactQuery),
    [artifactFilter, artifactQuery, manifest],
  );
  const availableFilters = useMemo(
    () =>
      selectedRecipeRun
        ? ARTIFACT_FILTERS.filter((item) => item.id !== 'recipes')
        : ARTIFACT_FILTERS,
    [selectedRecipeRun],
  );
  const focusedArtifactPath = useMemo(() => {
    const normalized = artifactQuery.trim();
    if (!normalized) return null;
    return manifest.some((item) => item.path === normalized) ? normalized : null;
  }, [artifactQuery, manifest]);
  const artifactDiffPath = useMemo(() => diffArtifactCandidate(manifest)?.path ?? null, [manifest]);
  const diffAvailable = Boolean(artifactDiffPath || run?.slotId);
  const workspaceNavCurrent = artifactWorkspaceNavCurrent(
    workspaceRecipeRunId,
    artifactFilter,
    priorityVisualPairCount,
  );
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        workspaceNavCurrent,
      ),
    [decisionKind, workspace, workspaceNavCurrent],
  );
  const diffRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('diff', workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );
  const stickyNavThreshold = artifactStickyChromeThreshold(
    workspaceNavLayout,
    ARTIFACT_STICKY_NAV_FALLBACK_THRESHOLD,
    ARTIFACT_STICKY_NAV_ACTIVATION_LEAD,
    ARTIFACT_STICKY_NAV_MAX_THRESHOLD,
  );

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const visible = artifactStickyChromeVisible(
        event.nativeEvent.contentOffset.y,
        stickyNavThreshold,
      );
      if (stickyNavVisibleRef.current === visible) return;
      stickyNavVisibleRef.current = visible;
      setStickyNavVisible(visible);
    },
    [stickyNavThreshold],
  );

  const rememberWorkspaceNavOffset = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setWorkspaceNavLayout({ y, height });
  }, []);

  const fetchTaskProgress = useCallback(() => {
    if (!client || !run?.slotId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, {
        slotId: run.slotId,
        runId: run.id,
      })
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

  useEffect(() => {
    if (selectedRecipeRun && artifactFilter === 'recipes') setArtifactFilter('all');
  }, [artifactFilter, selectedRecipeRun]);

  useEffect(() => {
    if (requestedFilter) {
      setArtifactFilter(
        selectedRecipeRun && requestedFilter === 'recipes' ? 'all' : requestedFilter,
      );
      return;
    }
    if (!requestedArtifactQuery) setArtifactFilter('all');
  }, [requestedArtifactQuery, requestedFilter, selectedRecipeRun]);

  const refreshArtifactMirror = useCallback(async () => {
    if (!client || !runId || artifactMirrorRefreshing) return;
    setArtifactMirrorRefreshing(true);
    setArtifactMirrorFeedback(null);
    try {
      const result = await client.request<RunRefreshMirrorResult>(Methods.RUN_REFRESH_MIRROR, {
        runId,
      });
      if (!result.ok) {
        setArtifactMirrorFeedback(result.reason || 'Refresh failed');
        return;
      }
      setArtifactMirrorEpoch((value) => value + 1);
      setArtifactMirrorFeedback(result.copied > 0 ? `Synced ${result.copied}` : 'Up to date');
      await Promise.all([
        refreshRun('manual mirror refresh'),
        refreshRecipeRuns('manual mirror refresh', false),
      ]);
    } catch (err) {
      setArtifactMirrorFeedback(`Refresh failed: ${(err as Error).message}`);
    } finally {
      setArtifactMirrorRefreshing(false);
    }
  }, [artifactMirrorRefreshing, client, refreshRecipeRuns, refreshRun, runId]);

  useEffect(() => {
    if (!artifactMirrorFeedback) return;
    const timer = setTimeout(() => setArtifactMirrorFeedback(null), 2500);
    return () => clearTimeout(timer);
  }, [artifactMirrorFeedback]);

  const visualViewerItems = useMemo(() => {
    const items = manifest
      .filter((artifact) => ['image', 'video'].includes(classifyArtifact(artifact)))
      .map((artifact) => ({
        uri: artifactUrlForEntry(gatewayUrl, runId ?? '', artifact, artifactMirrorEpoch),
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
  }, [artifactAuthHeaders, artifactMirrorEpoch, gatewayUrl, manifest, recipeFallbackPairs, runId]);
  const viewerIndex = viewerUri
    ? Math.max(
        0,
        visualViewerItems.findIndex((item) => item.uri === viewerUri),
      )
    : 0;

  const openDocument = useCallback(
    (url: string, path: string) => {
      documentAbortRef.current?.abort();
      const controller = new AbortController();
      documentAbortRef.current = controller;
      fetch(url, { signal: controller.signal, headers: artifactAuthHeaders })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((body) => setDocumentViewer({ title: path.split('/').pop() ?? path, body }))
        .catch((err: Error) => {
          // Abort is the expected cleanup path when the operator closes/navigates mid-fetch.
          if (err.name === 'AbortError') return;
          setError(`Failed to load ${path}: ${err.message}`);
        });
    },
    [artifactAuthHeaders],
  );
  const openReviewDocument = useCallback(
    (entry: ArtifactManifestEntry) => {
      if (!runId) return;
      openDocument(artifactUrlForEntry(gatewayUrl, runId, entry, artifactMirrorEpoch), entry.path);
    },
    [artifactMirrorEpoch, gatewayUrl, openDocument, runId],
  );

  const handleSelectRecipeRun = useCallback(
    (recipeRunId: string | null) => {
      setArtifactFilter('all');
      setArtifactQuery('');
      router.setParams({
        artifact: undefined,
        filter: undefined,
        recipeRun: recipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
      });
    },
    [router],
  );

  const handleFilterChange = useCallback(
    (nextFilter: ArtifactWorkspaceFilter) => {
      setArtifactFilter(nextFilter);
      router.setParams({ filter: nextFilter === 'all' ? undefined : nextFilter });
    },
    [router],
  );

  const openCompareArtifact = useCallback(
    (entry: ArtifactManifestEntry, recipeRunIdValue?: string | null) => {
      const targetRecipeRun =
        recipeRunIdValue ?? workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM;
      setArtifactFilter('visual');
      setArtifactQuery(entry.path);
      router.setParams({
        artifact: entry.path,
        filter: artifactFilterParamForWorkspaceNav('compare'),
        recipeRun: targetRecipeRun,
      });
    },
    [router, workspaceRecipeRunId],
  );

  const openDiffPath = useCallback(
    (path?: string) => {
      if (!runId) return;
      if (!path && !artifactDiffPath && run?.slotId) {
        router.push({
          pathname: '/diff/slot/[slotId]',
          params: { slotId: run.slotId, ...diffRouteContext },
        });
        return;
      }
      router.push({
        pathname: '/diff/[runId]',
        params: {
          runId,
          ...diffRouteContext,
          ...(path ? { path } : {}),
          ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
        },
      });
    },
    [artifactDiffPath, diffRouteContext, router, run?.slotId, runId, workspaceRecipeRunId],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: ArtifactManifestEntry; index: number }) => {
      if (!runId) return null;
      const url = artifactUrlFor(item);
      const mediaType = classifyArtifact(item);
      const isDiffArtifact = diffArtifactCandidate([item])?.path === item.path;
      return (
        <View style={[styles.artifactCell, index % 2 === 0 && styles.artifactCellLeft]}>
          <ArtifactCard
            url={url}
            path={item.path}
            purpose={item.purpose}
            type={item.type}
            label={item.label}
            mimeType={item.mimeType}
            sizeBytes={item.sizeBytes}
            authHeaders={artifactAuthHeaders}
            onPressImage={mediaType === 'image' ? () => setViewerUri(url) : undefined}
            onPressVideo={mediaType === 'video' ? () => setViewerUri(url) : undefined}
            onPressDocument={
              mediaType === 'document'
                ? isDiffArtifact
                  ? () => openDiffPath(item.path)
                  : () => openDocument(url, item.path)
                : undefined
            }
            documentLabel={isDiffArtifact ? 'DIFF' : undefined}
            documentHint={isDiffArtifact ? 'Tap to review diff' : undefined}
          />
        </View>
      );
    },
    [artifactAuthHeaders, artifactUrlFor, openDiffPath, openDocument, runId],
  );

  if (!run) {
    return (
      <View style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom }]}>
        <Text style={baseStyles.textSecondary}>Loading...</Text>
      </View>
    );
  }

  const primaryDecision = selectPrimaryWorkspaceDecision(run);
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(run);
  const activeTaskProgress = isWorkerProgressActive(run)
    ? (effectiveTaskProgressForRun(run, taskProgress) ?? null)
    : null;
  const fallbackTaskProgress =
    !activeTaskProgress && isWorkerProgressActive(run) ? fallbackTaskProgressSummary(run) : null;

  return (
    <View style={baseStyles.container}>
      {stickyNavVisible ? (
        <View style={styles.stickyWorkspaceChrome}>
          <RunWorkspaceNav
            dense
            current={workspaceNavCurrent}
            routeWorkspace={workspaceRouteContext.workspace}
            routeDecisionKind={workspaceRouteContext.decisionKind}
            decisionId={primaryDecision?.id ?? null}
            decisionKind={workspaceDecisionKind(primaryDecision)}
            readyDecisionId={readyDecision?.id ?? null}
            reviewDecisionId={reviewGateDecision?.id ?? null}
            retroDecisionId={retroDecision?.id ?? null}
            readyMeta={workspaceNavMeta.readyMeta}
            reviewMeta={workspaceNavMeta.reviewMeta}
            retroMeta={workspaceNavMeta.retroMeta}
            familyId={run.familyId}
            project={run.project}
            prNumber={run.prNumber}
            prRepo={prRepoFromWorkspaceSource(run, run.prNumber ?? null)}
            slotId={run.slotId}
            runId={run.id}
            recipeRunId={workspaceRecipeRunId}
            recipeAvailable={recipeAvailable}
            recipeArtifactCount={recipeRunGroupsLoaded ? totalRecipeArtifactCount : null}
            diffAvailable={diffAvailable}
            artifactCount={runArtifactCount}
            artifactPath={focusedArtifactPath ?? artifactDiffPath}
            visualPairCount={priorityVisualPairCount}
            compareArtifactPath={priorityCompareArtifactPath}
            compareRecipeRunId={priorityCompareRecipeRunId}
          />
          <ArtifactStickyFilter
            compact
            filter={artifactFilter}
            query={artifactQuery}
            counts={artifactCounts}
            visible={filteredSingles.length}
            visualPairCount={priorityVisualPairCount}
            filters={availableFilters}
            onFilterChange={(nextFilter) => {
              handleFilterChange(nextFilter);
              setArtifactQuery('');
              router.setParams({ artifact: undefined });
            }}
          />
        </View>
      ) : null}
      <FlashList
        data={filteredSingles}
        keyExtractor={(item) => item.path}
        renderItem={renderItem}
        numColumns={2}
        onScroll={handleListScroll}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: styles.listContent.paddingBottom + insets.bottom },
        ]}
        ListHeaderComponent={
          <>
            <ArtifactHeader
              run={run}
              gatewayUrl={gatewayUrl}
              artifactCount={manifest.length}
              runArtifactCount={runArtifactCount}
              manifest={manifest}
              pairs={manifestVisualPairs}
              recipeFallbackPairs={recipeFallbackPairs}
              authHeaders={artifactAuthHeaders}
              recipeRuns={recipeRuns}
              selectedRecipeRunId={selectedRecipeRunId}
              workspaceRecipeRunId={workspaceRecipeRunId}
              workspaceNavCurrent={workspaceNavCurrent}
              workspaceRouteContext={workspaceRouteContext}
              recipeAvailable={recipeAvailable}
              diffAvailable={diffAvailable}
              focusedArtifactQuery={artifactQuery}
              activeFilter={artifactFilter}
              artifactCounts={artifactCounts}
              filteredArtifactCount={filteredSingles.length}
              visualPairCount={priorityVisualPairCount}
              availableFilters={availableFilters}
              activeTaskProgress={activeTaskProgress}
              fallbackTaskProgress={fallbackTaskProgress}
              taskProgressError={taskProgressError}
              artifactMirrorEpoch={artifactMirrorEpoch}
              artifactMirrorRefreshing={artifactMirrorRefreshing}
              artifactMirrorFeedback={artifactMirrorFeedback}
              onRefreshArtifactMirror={refreshArtifactMirror}
              onFilterChange={(nextFilter) => {
                handleFilterChange(nextFilter);
                setArtifactQuery('');
                router.setParams({ artifact: undefined });
              }}
              onSelectRecipeRun={handleSelectRecipeRun}
              onFocusFilter={(nextFilter) => {
                handleFilterChange(nextFilter);
                setArtifactQuery('');
                router.setParams({
                  artifact: undefined,
                  filter: nextFilter === 'all' ? undefined : nextFilter,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                });
              }}
              onOpenVisual={setViewerUri}
              onOpenDocument={openReviewDocument}
              onOpenDiff={openDiffPath}
              onOpenArtifactWorkspace={(entry) => {
                setArtifactFilter('all');
                setArtifactQuery(entry.path);
                router.setParams({
                  artifact: entry.path,
                  filter: undefined,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                });
              }}
              onOpenCompareArtifact={openCompareArtifact}
              onWorkspaceNavLayout={rememberWorkspaceNavOffset}
              onClearFocusedArtifact={() => {
                setArtifactQuery('');
                router.setParams({
                  artifact: undefined,
                  filter: undefined,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                });
              }}
            />
          </>
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>No evidence files match the current filter.</Text>
        }
      />
      {error && (
        <Text style={[styles.errorText, { paddingBottom: spacing.lg + insets.bottom }]}>
          {error}
        </Text>
      )}
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
  );
}

function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function recipeRunIdForVisualPair(
  recipeRuns: RecipeRunArtifactGroup[],
  pair: VisualArtifactPair | null,
  selectedRecipeRunId: string | null,
): string {
  if (!pair) return selectedRecipeRunId ?? recipeRuns[0]?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
  const directRecipeRunId = pair.after.recipeRunId ?? pair.before.recipeRunId;
  if (directRecipeRunId) return directRecipeRunId;
  const sourceGroup = recipeRuns.find((group) => {
    const artifacts = artifactsForRecipeRun(group);
    return artifacts.some(
      (artifact) => artifact.path === pair.before.path || artifact.path === pair.after.path,
    );
  });
  return (
    sourceGroup?.id ??
    selectedRecipeRunId ??
    recipeRuns[0]?.id ??
    CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
  );
}

function ArtifactStickyFilter({
  compact = false,
  filter,
  query,
  counts,
  visible,
  visualPairCount,
  filters,
  onFilterChange,
}: {
  compact?: boolean;
  filter: ArtifactWorkspaceFilter;
  query: string;
  counts: ArtifactWorkspaceCounts;
  visible: number;
  visualPairCount: number;
  filters: Array<{ id: ArtifactWorkspaceFilter; label: string }>;
  onFilterChange: (filter: ArtifactWorkspaceFilter) => void;
}) {
  const header = artifactWorkspaceHeaderPresentation({
    activeFilter: filter,
    visible,
    total: counts.all,
    visualPairCount,
  });

  if (compact) {
    return (
      <View style={[styles.stickyFilter, styles.stickyFilterCompact]}>
        <View style={styles.stickyFilterCompactRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.stickyFilterCompactChips}
          >
            {filters.map((item) => {
              const active = filter === item.id;
              const presentation = artifactWorkspaceFilterPresentation({
                filter: item.id,
                fallbackLabel: item.label,
                counts,
                visualPairCount,
              });
              return (
                <Pressable
                  key={item.id}
                  style={[
                    styles.filterChip,
                    styles.filterChipCompact,
                    active && styles.filterChipActive,
                  ]}
                  onPress={() => onFilterChange(item.id)}
                >
                  <Text
                    style={[
                      styles.filterText,
                      styles.filterTextCompact,
                      active && styles.filterTextActive,
                    ]}
                  >
                    {presentation.label} {presentation.count}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Text style={styles.stickyFilterCompactCount}>{header.countLabel}</Text>
        </View>
        {query.trim() ? (
          <Text style={styles.stickyFilterCompactQuery} numberOfLines={1}>
            Focus: {query.trim()}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.stickyFilter}>
      <View style={styles.filterTopRow}>
        <Text style={styles.filterTitle}>{header.title}</Text>
        <Text style={styles.filterCount}>{header.countLabel}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {filters.map((item) => {
          const active = filter === item.id;
          const presentation = artifactWorkspaceFilterPresentation({
            filter: item.id,
            fallbackLabel: item.label,
            counts,
            visualPairCount,
          });
          return (
            <Pressable
              key={item.id}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => onFilterChange(item.id)}
            >
              <Text style={[styles.filterText, active && styles.filterTextActive]}>
                {presentation.label} {presentation.count}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {query.trim() ? (
        <Pressable style={styles.focusedFilterPill} onPress={() => onFilterChange(filter)}>
          <Text style={styles.focusedFilterText} numberOfLines={1}>
            Focus: {query.trim()}
          </Text>
          <Text style={styles.focusedFilterClear}>Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ArtifactHeader({
  run,
  gatewayUrl,
  artifactCount,
  runArtifactCount,
  manifest,
  pairs,
  recipeFallbackPairs,
  authHeaders,
  recipeRuns,
  selectedRecipeRunId,
  workspaceRecipeRunId,
  workspaceNavCurrent,
  workspaceRouteContext,
  recipeAvailable,
  diffAvailable,
  focusedArtifactQuery,
  activeFilter,
  artifactCounts,
  filteredArtifactCount,
  visualPairCount,
  availableFilters,
  activeTaskProgress,
  fallbackTaskProgress,
  taskProgressError,
  artifactMirrorEpoch,
  artifactMirrorRefreshing,
  artifactMirrorFeedback,
  onRefreshArtifactMirror,
  onFilterChange,
  onSelectRecipeRun,
  onFocusFilter,
  onOpenVisual,
  onOpenDocument,
  onOpenDiff,
  onOpenArtifactWorkspace,
  onOpenCompareArtifact,
  onWorkspaceNavLayout,
  onClearFocusedArtifact,
}: {
  run: Run;
  gatewayUrl: string;
  artifactCount: number;
  runArtifactCount: number;
  manifest: ArtifactManifestEntry[];
  pairs: VisualArtifactPair[];
  recipeFallbackPairs: VisualArtifactPair[];
  authHeaders: ArtifactHttpHeaders;
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string | null;
  workspaceRecipeRunId: string | null;
  workspaceNavCurrent: ReturnType<typeof artifactWorkspaceNavCurrent>;
  workspaceRouteContext: WorkspaceRouteContext;
  recipeAvailable?: boolean;
  diffAvailable: boolean;
  focusedArtifactQuery: string;
  activeFilter: ArtifactWorkspaceFilter;
  artifactCounts: ArtifactWorkspaceCounts;
  filteredArtifactCount: number;
  visualPairCount: number;
  availableFilters: Array<{ id: ArtifactWorkspaceFilter; label: string }>;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  taskProgressError: string | null;
  artifactMirrorEpoch: number;
  artifactMirrorRefreshing: boolean;
  artifactMirrorFeedback: string | null;
  onRefreshArtifactMirror: () => void;
  onFilterChange: (filter: ArtifactWorkspaceFilter) => void;
  onSelectRecipeRun: (id: string | null) => void;
  onFocusFilter: (filter: ArtifactWorkspaceFilter) => void;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenDiff: (path?: string) => void;
  onOpenArtifactWorkspace: (artifact: ArtifactManifestEntry) => void;
  onOpenCompareArtifact: (artifact: ArtifactManifestEntry, recipeRunId?: string | null) => void;
  onWorkspaceNavLayout: (event: LayoutChangeEvent) => void;
  onClearFocusedArtifact: () => void;
}) {
  const router = useRouter();
  const selectedRecipeRun = recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null;
  const recipeArtifactCount = recipeRuns.reduce(
    (count, group) => count + artifactsForRecipeRun(group).length,
    0,
  );
  const priorityPair = pairs[0] ?? recipeFallbackPairs[0] ?? null;
  const priorityPairCount = pairs.length > 0 ? pairs.length : recipeFallbackPairs.length;
  const priorityPairIsRecipeFallback = pairs.length === 0 && recipeFallbackPairs.length > 0;
  const priorityRecipeRunId =
    priorityPairIsRecipeFallback && priorityPair
      ? recipeRunIdForVisualPair(recipeRuns, priorityPair, selectedRecipeRunId)
      : workspaceRecipeRunId;
  const diffArtifactPath = diffArtifactCandidate(manifest)?.path ?? null;
  const normalizedFocusedArtifactQuery = focusedArtifactQuery.trim();
  const focusedArtifactPath = manifest.some(
    (artifact) => artifact.path === normalizedFocusedArtifactQuery,
  )
    ? normalizedFocusedArtifactQuery
    : null;
  const focusedArtifact =
    manifest.find((artifact) => artifact.path === focusedArtifactPath) ?? null;
  const primaryDecision = selectPrimaryWorkspaceDecision(run);
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(run);
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const reviewWorkspaceArtifacts = useMemo(
    () => filterArtifactWorkspace(manifest, activeFilter, focusedArtifactQuery),
    [activeFilter, focusedArtifactQuery, manifest],
  );
  const reviewWorkspacePairs = useMemo(() => {
    if (focusedArtifactQuery.trim()) return [];
    return activeFilter === 'all' || activeFilter === 'visual' ? pairs : [];
  }, [activeFilter, focusedArtifactQuery, pairs]);
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View style={[styles.flowBadge, { backgroundColor: colors.accent + '30' }]}>
          <Text style={[styles.flowText, { color: colors.accent }]}>{run.flowType}</Text>
        </View>
        <View style={styles.headerActions}>
          <Text style={styles.countText}>{artifactCount} artifacts</Text>
          <Pressable
            style={[styles.refreshButton, artifactMirrorRefreshing && styles.refreshButtonDisabled]}
            disabled={artifactMirrorRefreshing}
            onPress={onRefreshArtifactMirror}
          >
            <Text style={styles.refreshButtonText}>
              {artifactMirrorRefreshing ? 'Refreshing…' : artifactMirrorFeedback || 'Refresh'}
            </Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.ticketText}>{run.ticketOrPr}</Text>

      <View onLayout={onWorkspaceNavLayout} style={styles.primaryWorkspaceNavBlock}>
        <RunWorkspaceNav
          dense
          current={workspaceNavCurrent}
          routeWorkspace={workspaceRouteContext.workspace}
          routeDecisionKind={workspaceRouteContext.decisionKind}
          decisionId={primaryDecision?.id ?? null}
          decisionKind={workspaceDecisionKind(primaryDecision)}
          readyDecisionId={readyDecision?.id ?? null}
          reviewDecisionId={reviewGateDecision?.id ?? null}
          retroDecisionId={retroDecision?.id ?? null}
          readyMeta={workspaceNavMeta.readyMeta}
          reviewMeta={workspaceNavMeta.reviewMeta}
          retroMeta={workspaceNavMeta.retroMeta}
          familyId={run.familyId}
          project={run.project}
          prNumber={run.prNumber}
          prRepo={prRepoFromWorkspaceSource(run, run.prNumber ?? null)}
          slotId={run.slotId}
          runId={run.id}
          recipeRunId={workspaceRecipeRunId}
          recipeAvailable={recipeAvailable}
          recipeArtifactCount={recipeArtifactCount}
          diffAvailable={diffAvailable}
          artifactCount={runArtifactCount}
          artifactPath={focusedArtifactPath}
          visualPairCount={priorityPairCount}
          compareArtifactPath={priorityPair?.after.path ?? null}
          compareRecipeRunId={priorityRecipeRunId}
        />
      </View>

      <ArtifactStickyFilter
        filter={activeFilter}
        query={focusedArtifactQuery}
        counts={artifactCounts}
        visible={filteredArtifactCount}
        visualPairCount={visualPairCount}
        filters={availableFilters}
        onFilterChange={onFilterChange}
      />

      {priorityPair ? (
        <BeforeAfterPriorityPanel
          pair={priorityPair}
          pairCount={priorityPairCount}
          authHeaders={authHeaders}
          eyebrow={priorityPairIsRecipeFallback ? 'Recipe evidence' : 'Review first'}
          title={priorityPairIsRecipeFallback ? 'Recipe before → after' : 'Before → After evidence'}
          copy={
            priorityPairIsRecipeFallback
              ? 'Recipe evidence has the clearest visible delta for this run.'
              : 'Validate what changed before approving the run.'
          }
          onOpenArtifact={(artifactPath) => {
            const target = [priorityPair.before, priorityPair.after].find(
              (entry) => entry.path === artifactPath,
            );
            if (!target) return;
            if (['image', 'video'].includes(classifyArtifact(target))) {
              onOpenVisual(target.url);
              return;
            }
            onOpenCompareArtifact(target, priorityRecipeRunId);
          }}
          onShowVisuals={() => {
            if (priorityPairIsRecipeFallback) {
              onOpenCompareArtifact(priorityPair.after, priorityRecipeRunId);
            } else {
              onFocusFilter('visual');
            }
          }}
          artifactCount={artifactCount}
          recipeArtifactCount={recipeArtifactCount}
          recipeAvailable={recipeAvailable}
          diffValue={diffArtifactPath ? 'artifact' : diffAvailable ? 'workspace' : 'none'}
          slotId={run.slotId}
          familyId={run.familyId}
          prNumber={run.prNumber}
          onOpenEvidence={() => onFocusFilter('all')}
          onOpenRecipe={() => onFocusFilter('recipes')}
          onOpenDiff={() => onOpenDiff(diffArtifactPath ?? undefined)}
          onOpenRun={() => {
            router.push({
              pathname: '/run/[id]',
              params: {
                id: run.id,
                ...targetRouteContext('run'),
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
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
                ...familySectionRouteContextParams('evidence', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'evidence',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
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
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
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
        />
      ) : null}

      {focusedArtifact ? (
        <FocusedArtifactPanel
          run={run}
          artifact={focusedArtifact}
          diffArtifactPath={diffArtifactPath}
          diffAvailable={diffAvailable}
          comparePairCount={priorityPairCount}
          gatewayUrl={gatewayUrl}
          workspaceRecipeRunId={workspaceRecipeRunId}
          workspaceRouteContext={workspaceRouteContext}
          artifactMirrorEpoch={artifactMirrorEpoch}
          onOpenVisual={onOpenVisual}
          onOpenDocument={onOpenDocument}
          onOpenCompare={() => {
            if (priorityPair) onOpenCompareArtifact(priorityPair.after, priorityRecipeRunId);
          }}
          onOpenDiff={onOpenDiff}
          onClear={onClearFocusedArtifact}
        />
      ) : null}

      {reviewWorkspaceArtifacts.length > 0 && (
        <View style={{ marginTop: spacing.lg }}>
          <EvidenceReviewWorkspace
            runId={run.id}
            gatewayUrl={gatewayUrl}
            artifacts={reviewWorkspaceArtifacts}
            pairs={reviewWorkspacePairs}
            authHeaders={authHeaders}
            onOpenVisual={onOpenVisual}
            onOpenDocument={onOpenDocument}
            onOpenDiff={onOpenDiff}
            onOpenArtifactWorkspace={onOpenArtifactWorkspace}
            onOpenCompareArtifactWorkspace={onOpenCompareArtifact}
          />
        </View>
      )}

      <ArtifactContextCard
        run={run}
        artifactCount={artifactCount}
        diffArtifactPath={diffArtifactPath}
        diffAvailable={diffAvailable}
        visualPairCount={priorityPairCount}
        scopeLabel={artifactScopeLabel(workspaceRecipeRunId, selectedRecipeRun)}
        focusedArtifactQuery={focusedArtifactQuery}
        focusedArtifactPath={focusedArtifactPath}
        workspaceRecipeRunId={workspaceRecipeRunId}
        workspaceRouteContext={workspaceRouteContext}
        onOpenCompare={() => {
          if (priorityPair) onOpenCompareArtifact(priorityPair.after, priorityRecipeRunId);
        }}
        onOpenDiff={onOpenDiff}
      />

      <ArtifactWorkspaceCockpit
        run={run}
        artifactCount={artifactCount}
        artifactCounts={artifactCounts}
        activeFilter={activeFilter}
        recipeRuns={recipeRuns}
        selectedRecipeRun={selectedRecipeRun}
        workspaceRecipeRunId={workspaceRecipeRunId}
        workspaceRouteContext={workspaceRouteContext}
        focusedArtifactPath={focusedArtifactPath}
        diffArtifactPath={diffArtifactPath}
        diffAvailable={diffAvailable}
        visualPairCount={pairs.length}
        fallbackVisualPairCount={recipeFallbackPairs.length}
        activeTaskProgress={activeTaskProgress}
        fallbackTaskProgress={fallbackTaskProgress}
        onOpenCompare={() => {
          if (priorityPair) onOpenCompareArtifact(priorityPair.after, priorityRecipeRunId);
        }}
        onFocusFilter={onFocusFilter}
        onSelectRecipeRun={onSelectRecipeRun}
        onOpenDiff={onOpenDiff}
      />

      {activeTaskProgress ? (
        <View style={styles.artifactProgressPanel}>
          <TaskProgressPanel
            run={run}
            progress={activeTaskProgress}
            error={taskProgressError}
            compact
          />
        </View>
      ) : fallbackTaskProgress ? (
        <View style={styles.artifactProgressPanel}>
          <TaskProgressFallbackPanel
            summary={fallbackTaskProgress}
            error={taskProgressError}
            compact
          />
        </View>
      ) : null}

      {recipeRuns.length > 0 && (
        <RecipeRunPicker
          groups={recipeRuns}
          selectedId={selectedRecipeRunId}
          onSelect={onSelectRecipeRun}
        />
      )}

      {/* Section title for individual artifacts */}
      {artifactCount > 0 && <Text style={styles.sectionTitle}>All Artifacts</Text>}
    </View>
  );
}

function BeforeAfterPriorityPanel({
  pair,
  pairCount,
  authHeaders,
  artifactCount,
  recipeArtifactCount,
  recipeAvailable,
  diffValue,
  slotId,
  familyId,
  prNumber,
  eyebrow = 'Review first',
  title = 'Before → After evidence',
  copy = 'Validate what changed before approving the run.',
  onOpenArtifact,
  onShowVisuals,
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
  authHeaders: ArtifactHttpHeaders;
  artifactCount: number;
  recipeArtifactCount: number;
  recipeAvailable?: boolean;
  diffValue: string;
  slotId?: string | null;
  familyId?: string | null;
  prNumber?: number | null;
  eyebrow?: string;
  title?: string;
  copy?: string;
  onOpenArtifact: (artifactPath: string) => void;
  onShowVisuals: () => void;
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
        eyebrow={eyebrow}
        title={title}
        hint={`${pairCount} pair${pairCount === 1 ? '' : 's'}`}
        imageHeight={92}
      />
      <View style={styles.beforeAfterPriorityActions}>
        <Text style={styles.beforeAfterPriorityCopy}>{copy}</Text>
        <Pressable style={styles.beforeAfterPriorityButton} onPress={onShowVisuals}>
          <Text style={styles.beforeAfterPriorityButtonText}>Show visual evidence</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.beforeAfterPriorityRail}
      >
        <ArtifactFilterTile
          label="Evidence"
          value={String(artifactCount)}
          active={false}
          onPress={onOpenEvidence}
        />
        <ArtifactFilterTile
          label="Recipe"
          value={recipeAvailable ? String(recipeArtifactCount) : '-'}
          active={false}
          onPress={onOpenRecipe}
          disabled={recipeAvailable === false}
        />
        <ArtifactFilterTile label="Diff" value={diffValue} active={false} onPress={onOpenDiff} />
        <ArtifactFilterTile label="Run" value="detail" active={false} onPress={onOpenRun} />
        <ArtifactFilterTile
          label="Family"
          value={familyId ? shortId(familyId) : '-'}
          active={false}
          onPress={onOpenFamily}
          disabled={!familyId}
        />
        <ArtifactFilterTile
          label="Terminal"
          value={slotId ? 'live' : '-'}
          active={false}
          onPress={onOpenTerminal}
          disabled={!slotId}
        />
        <ArtifactFilterTile
          label="PR"
          value={prNumber ? `#${prNumber}` : '-'}
          active={false}
          onPress={onOpenPR}
          disabled={!prNumber}
        />
      </ScrollView>
    </View>
  );
}

function FocusedArtifactPanel({
  run,
  artifact,
  diffArtifactPath,
  diffAvailable,
  comparePairCount,
  gatewayUrl,
  workspaceRecipeRunId,
  workspaceRouteContext,
  artifactMirrorEpoch,
  onOpenVisual,
  onOpenDocument,
  onOpenCompare,
  onOpenDiff,
  onClear,
}: {
  run: Run;
  artifact: ArtifactManifestEntry;
  diffArtifactPath: string | null;
  diffAvailable: boolean;
  comparePairCount: number;
  gatewayUrl: string;
  workspaceRecipeRunId: string | null;
  workspaceRouteContext: WorkspaceRouteContext;
  artifactMirrorEpoch: number;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenCompare: () => void;
  onOpenDiff: (path?: string) => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const mediaType = classifyArtifact(artifact);
  const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const focusedContextParams = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => ({
    ...targetRouteContext(targetWorkspace),
    ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
    artifact: artifact.path,
  });
  const openRecipeFiles = () => {
    const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId: run.id,
        ...targetRouteContext('recipe'),
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, artifact.path)
          ? { artifact: artifact.path }
          : {}),
      },
    });
  };
  const openArtifact = () => {
    if (mediaType === 'image' || mediaType === 'video') {
      onOpenVisual(artifactUrlForEntry(gatewayUrl, run.id, artifact, artifactMirrorEpoch));
      return;
    }
    if (isDiffArtifact) {
      onOpenDiff(artifact.path);
      return;
    }
    if (mediaType === 'document') {
      onOpenDocument(artifact);
    }
  };
  const canOpen =
    mediaType === 'image' || mediaType === 'video' || mediaType === 'document' || isDiffArtifact;

  return (
    <View style={styles.focusedArtifactPanel}>
      <View style={styles.focusedArtifactHeader}>
        <View style={styles.focusedArtifactTitleBlock}>
          <Text style={styles.focusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.focusedArtifactPath} numberOfLines={2}>
            {artifact.path}
          </Text>
          {artifact.purpose || artifact.label ? (
            <Text style={styles.focusedArtifactMeta} numberOfLines={1}>
              {[artifact.label, artifact.purpose].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>
        <View style={styles.focusedArtifactTypeBadge}>
          <Text style={styles.focusedArtifactTypeText}>
            {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
          </Text>
        </View>
      </View>
      <View style={styles.focusedArtifactActions}>
        <Pressable
          style={[styles.focusedArtifactAction, !canOpen && styles.focusedArtifactActionDisabled]}
          disabled={!canOpen}
          onPress={openArtifact}
        >
          <Text style={styles.focusedArtifactActionText}>
            {isDiffArtifact ? 'Open diff' : mediaType === 'document' ? 'Open document' : 'Preview'}
          </Text>
        </Pressable>
        {isDiffArtifact ? null : (
          <Pressable
            style={[
              styles.focusedArtifactAction,
              !diffAvailable && styles.focusedArtifactActionDisabled,
            ]}
            disabled={!diffAvailable}
            onPress={() => onOpenDiff(diffArtifactPath ?? undefined)}
          >
            <Text style={styles.focusedArtifactActionText}>Open diff</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.focusedArtifactAction}
          onPress={() =>
            router.push({
              pathname: '/run/[id]',
              params: {
                id: run.id,
                ...focusedContextParams('run'),
              },
            })
          }
        >
          <Text style={styles.focusedArtifactActionText}>Run detail</Text>
        </Pressable>
        <Pressable style={styles.focusedArtifactAction} onPress={openRecipeFiles}>
          <Text style={styles.focusedArtifactActionText}>Recipe files</Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            comparePairCount === 0 && styles.focusedArtifactActionDisabled,
          ]}
          disabled={comparePairCount === 0}
          onPress={onOpenCompare}
        >
          <Text style={styles.focusedArtifactActionText}>
            Before→After {comparePairCount > 0 ? `(${comparePairCount})` : ''}
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            !run.slotId && styles.focusedArtifactActionDisabled,
          ]}
          disabled={!run.slotId}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/slot/[id]',
              params: {
                id: run.slotId,
                runId: run.id,
                ...focusedContextParams('slot'),
              },
            });
          }}
        >
          <Text style={styles.focusedArtifactActionText}>Slot</Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            !run.familyId && styles.focusedArtifactActionDisabled,
          ]}
          disabled={!run.familyId}
          onPress={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('evidence', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'evidence',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                artifact: artifact.path,
              },
            });
          }}
        >
          <Text style={styles.focusedArtifactActionText}>Family</Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            !run.prNumber && styles.focusedArtifactActionDisabled,
          ]}
          disabled={!run.prNumber}
          onPress={() => {
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
        >
          <Text style={styles.focusedArtifactActionText}>PR</Text>
        </Pressable>
        <Pressable
          style={[
            styles.focusedArtifactAction,
            !run.slotId && styles.focusedArtifactActionDisabled,
          ]}
          disabled={!run.slotId}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: run.slotId,
                runId: run.id,
                details: '1',
                ...focusedContextParams('terminal'),
              },
            });
          }}
        >
          <Text style={styles.focusedArtifactActionText}>Terminal</Text>
        </Pressable>
        <Pressable style={styles.focusedArtifactClear} onPress={onClear}>
          <Text style={styles.focusedArtifactClearText}>Clear</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ArtifactContextCard({
  run,
  artifactCount,
  diffArtifactPath,
  diffAvailable,
  visualPairCount,
  scopeLabel,
  focusedArtifactQuery,
  focusedArtifactPath,
  workspaceRecipeRunId,
  workspaceRouteContext,
  onOpenCompare,
  onOpenDiff,
}: {
  run: Run;
  artifactCount: number;
  diffArtifactPath: string | null;
  diffAvailable: boolean;
  visualPairCount: number;
  scopeLabel: string;
  focusedArtifactQuery: string;
  focusedArtifactPath: string | null;
  workspaceRecipeRunId: string | null;
  workspaceRouteContext: WorkspaceRouteContext;
  onOpenCompare: () => void;
  onOpenDiff: (path?: string) => void;
}) {
  const router = useRouter();
  const statusColor = runStatusColor(run.status);
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const openDecision = (decisionId: string | null | undefined, targetDecisionKind?: string) => {
    if (!decisionId) return;
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...workspaceRouteContext,
        ...decisionWorkspaceRouteParams(targetDecisionKind),
        runId: run.id,
        ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  return (
    <View style={styles.contextCard}>
      <View style={styles.contextHeader}>
        <Text style={styles.contextEyebrow}>Artifact workspace</Text>
        <View style={[styles.contextStatusBadge, { backgroundColor: statusColor + '22' }]}>
          <Text style={[styles.contextStatusText, { color: statusColor }]}>{run.status}</Text>
        </View>
      </View>
      <View style={styles.contextGrid}>
        <ArtifactContextMetric
          label="Slot"
          value={run.slotId ?? '-'}
          disabled={!run.slotId}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/slot/[id]',
              params: {
                id: run.slotId,
                ...targetRouteContext('slot'),
                runId: run.id,
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactContextMetric
          label="Family"
          value={shortId(run.familyId)}
          disabled={!run.familyId}
          onPress={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('evidence', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'evidence',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactContextMetric label="Scope" value={scopeLabel} />
        <ArtifactContextMetric
          label="Ready gate"
          value={readyDecision ? (readyDecision.resolvedAt ? 'resolved' : 'pending') : '-'}
          disabled={!readyDecision}
          onPress={() => openDecision(readyDecision?.id, 'ready')}
        />
        <ArtifactContextMetric
          label="Review gate"
          value={reviewGateDecision ? workspaceDecisionKind(reviewGateDecision) || 'review' : '-'}
          disabled={!reviewGateDecision}
          onPress={() =>
            openDecision(reviewGateDecision?.id, workspaceDecisionKind(reviewGateDecision))
          }
        />
        <ArtifactContextMetric
          label="Retro gate"
          value={retroDecision ? (retroDecision.resolvedAt ? 'recorded' : 'pending') : '-'}
          disabled={!retroDecision}
          onPress={() => openDecision(retroDecision?.id, 'retrospective')}
        />
        <ArtifactContextMetric
          label="Family retros"
          value={run.familyId ? 'open' : '-'}
          disabled={!run.familyId}
          onPress={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('retros', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'retros',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactContextMetric
          label="Diff view"
          value={diffArtifactPath ?? (run.slotId && diffAvailable ? 'live workspace' : 'missing')}
          disabled={!diffAvailable}
          onPress={() => onOpenDiff(diffArtifactPath ?? undefined)}
        />
        <ArtifactContextMetric
          label="Before→After"
          value={String(visualPairCount)}
          disabled={visualPairCount === 0}
          onPress={onOpenCompare}
        />
        <ArtifactContextMetric
          label="Focus"
          value={focusedArtifactQuery ? focusedArtifactQuery : `${artifactCount} artifacts`}
        />
      </View>
    </View>
  );
}

function ArtifactContextMetric({
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
      <Text style={styles.contextMetricLabel}>{label}</Text>
      <Text style={styles.contextMetricValue} numberOfLines={1}>
        {value}
        {onPress && !disabled ? ' ›' : ''}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        style={[styles.contextMetric, disabled && styles.contextMetricDisabled]}
        onPress={onPress}
        disabled={disabled}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={styles.contextMetric}>{content}</View>;
}

function ArtifactWorkspaceCockpit({
  run,
  artifactCount,
  artifactCounts,
  activeFilter,
  recipeRuns,
  selectedRecipeRun,
  workspaceRecipeRunId,
  workspaceRouteContext,
  focusedArtifactPath,
  diffArtifactPath,
  diffAvailable,
  visualPairCount,
  fallbackVisualPairCount,
  activeTaskProgress,
  fallbackTaskProgress,
  onOpenCompare,
  onFocusFilter,
  onSelectRecipeRun,
  onOpenDiff,
}: {
  run: Run;
  artifactCount: number;
  artifactCounts: ArtifactWorkspaceCounts;
  activeFilter: ArtifactWorkspaceFilter;
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRun: RecipeRunArtifactGroup | null;
  workspaceRecipeRunId: string | null;
  workspaceRouteContext: WorkspaceRouteContext;
  focusedArtifactPath: string | null;
  diffArtifactPath: string | null;
  diffAvailable: boolean;
  visualPairCount: number;
  fallbackVisualPairCount: number;
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  onOpenCompare: () => void;
  onFocusFilter: (filter: ArtifactWorkspaceFilter) => void;
  onSelectRecipeRun: (id: string | null) => void;
  onOpenDiff: (path?: string) => void;
}) {
  const router = useRouter();
  const recipeScoped = Boolean(selectedRecipeRun);
  const recipeScopeTarget = selectedRecipeRun?.id ?? recipeRuns[0]?.id ?? null;
  const recipeScopeLabel = recipeWorkspaceScopeLabel(workspaceRecipeRunId);
  const terminalAvailable = Boolean(run.slotId);
  const comparePairCount = visualPairCount > 0 ? visualPairCount : fallbackVisualPairCount;
  const compareLabel = visualPairCount > 0 ? 'Before→After' : 'Recipe compare';
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const targetRouteContext = (
    targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
  ) => targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind);
  const openDecision = (decisionId: string | null | undefined, targetDecisionKind?: string) => {
    if (!decisionId) return;
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...workspaceRouteContext,
        ...decisionWorkspaceRouteParams(targetDecisionKind),
        runId: run.id,
        ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const openDiff = () => {
    if (diffArtifactPath) {
      onOpenDiff(diffArtifactPath);
      return;
    }
    onOpenDiff();
  };

  return (
    <View style={styles.artifactCockpitPanel}>
      <View style={styles.artifactCockpitHeader}>
        <View style={styles.artifactCockpitTitleBlock}>
          <Text style={styles.artifactCockpitTitle}>Artifact cockpit</Text>
          <Text style={styles.artifactCockpitMeta} numberOfLines={1}>
            {recipeScoped ? selectedRecipeRun?.label : 'Decision evidence'} · {artifactCount} files
          </Text>
        </View>
        <Pressable
          style={[styles.artifactCockpitPill, !terminalAvailable && styles.artifactCockpitDisabled]}
          disabled={!terminalAvailable}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: run.slotId,
                ...targetRouteContext('terminal'),
                runId: run.id,
                details: '1',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        >
          <Text style={styles.artifactCockpitPillText}>Terminal</Text>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.artifactCockpitRail}
      >
        <ArtifactFilterTile
          label="All"
          value={String(artifactCounts.all)}
          active={activeFilter === 'all'}
          onPress={() => onFocusFilter('all')}
        />
        <ArtifactFilterTile
          label={compareLabel}
          value={`${comparePairCount} pair${comparePairCount === 1 ? '' : 's'}`}
          active={activeFilter === 'visual'}
          onPress={onOpenCompare}
          disabled={comparePairCount === 0}
        />
        <ArtifactFilterTile
          label="Run"
          value={shortId(run.id)}
          active={false}
          onPress={() =>
            router.push({
              pathname: '/run/[id]',
              params: {
                id: run.id,
                ...targetRouteContext('run'),
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            })
          }
        />
        <ArtifactFilterTile
          label="Slot"
          value={run.slotId ?? '-'}
          active={false}
          disabled={!run.slotId}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/slot/[id]',
              params: {
                id: run.slotId,
                ...targetRouteContext('slot'),
                runId: run.id,
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactFilterTile
          label="PR"
          value={run.prNumber ? `#${run.prNumber}` : '-'}
          active={false}
          disabled={!run.prNumber}
          onPress={() => {
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
        <ArtifactFilterTile
          label="Ready gate"
          value={readyDecision ? (readyDecision.resolvedAt ? 'resolved' : 'pending') : '-'}
          active={false}
          disabled={!readyDecision}
          onPress={() => openDecision(readyDecision?.id, 'ready')}
        />
        <ArtifactFilterTile
          label="Review gate"
          value={
            reviewGateDecision ? (reviewGateDecision.resolvedAt ? 'resolved' : 'pending') : '-'
          }
          active={false}
          disabled={!reviewGateDecision}
          onPress={() =>
            openDecision(reviewGateDecision?.id, workspaceDecisionKind(reviewGateDecision))
          }
        />
        <ArtifactFilterTile
          label="Retro gate"
          value={retroDecision ? (retroDecision.resolvedAt ? 'recorded' : 'pending') : '-'}
          active={false}
          disabled={!retroDecision}
          onPress={() => openDecision(retroDecision?.id, 'retrospective')}
        />
        <ArtifactFilterTile
          label="Family retros"
          value={run.familyId ? 'open' : '-'}
          active={false}
          disabled={!run.familyId}
          onPress={() => {
            if (!run.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('retros', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'retros',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactFilterTile
          label="Progress"
          value={progressValue}
          active={false}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
          onPress={() => {
            if (!run.slotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: run.slotId,
                ...targetRouteContext('terminal'),
                runId: run.id,
                details: '1',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            });
          }}
        />
        <ArtifactFilterTile
          label="Visual files"
          value={String(artifactCounts.visual)}
          active={activeFilter === 'visual' && visualPairCount === 0}
          onPress={() => onFocusFilter('visual')}
          disabled={artifactCounts.visual === 0}
        />
        <ArtifactFilterTile
          label="Doc files"
          value={String(artifactCounts.docs)}
          active={activeFilter === 'docs'}
          onPress={() => onFocusFilter('docs')}
          disabled={artifactCounts.docs === 0}
        />
        <ArtifactFilterTile
          label="Diff files"
          value={String(artifactCounts.diffs)}
          active={activeFilter === 'diffs'}
          onPress={() => onFocusFilter('diffs')}
          disabled={artifactCounts.diffs === 0}
        />
        <ArtifactFilterTile
          label="Recipe files"
          value={String(artifactCounts.recipes)}
          hint={`${recipeScopeLabel} recipe scope`}
          active={activeFilter === 'recipes'}
          onPress={() => onFocusFilter('recipes')}
          disabled={recipeScoped || artifactCounts.recipes === 0}
        />
        <ArtifactFilterTile
          label="Review files"
          value={String(artifactCounts.review)}
          active={activeFilter === 'review'}
          onPress={() => onFocusFilter('review')}
          disabled={artifactCounts.review === 0}
        />
        <ArtifactFilterTile
          label="Open diff"
          value={diffArtifactPath ? 'artifact' : run.slotId ? 'workspace' : 'missing'}
          active={false}
          onPress={openDiff}
          disabled={!diffAvailable}
        />
        <ArtifactFilterTile
          label="Recipe scope"
          value={recipeScoped ? recipeScopeLabel : 'select'}
          hint={recipeScoped ? selectedRecipeRun?.label : undefined}
          active={recipeScoped}
          disabled={!recipeScopeTarget}
          onPress={() => onSelectRecipeRun(recipeScopeTarget)}
        />
        <ArtifactFilterTile
          label="Run files"
          value={String(artifactCount)}
          active={!recipeScoped}
          onPress={() => onSelectRecipeRun(null)}
        />
        <ArtifactFilterTile
          label="Family"
          value={shortId(run.familyId)}
          active={false}
          disabled={!run.familyId}
          onPress={() =>
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId!,
                project: run.project,
                ...familySectionRouteContextParams('evidence', workspaceRouteContext.decisionKind),
                runId: run.id,
                section: 'evidence',
                ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
              },
            })
          }
        />
      </ScrollView>
    </View>
  );
}

function ArtifactFilterTile({
  label,
  value,
  hint,
  active,
  disabled,
  onPress,
}: {
  label: string;
  value: string;
  hint?: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[
        styles.artifactCockpitTile,
        active && styles.artifactCockpitTileActive,
        disabled && styles.artifactCockpitDisabled,
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text
        style={[styles.artifactCockpitTileLabel, active && styles.artifactCockpitTileLabelActive]}
      >
        {label}
      </Text>
      <Text style={styles.artifactCockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.artifactCockpitTileHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

function artifactScopeLabel(
  workspaceRecipeRunId: string | null,
  selectedRecipeRun: RecipeRunArtifactGroup | null,
): string {
  if (selectedRecipeRun) return selectedRecipeRun.label;
  if (workspaceRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM) return 'decision evidence';
  if (workspaceRecipeRunId) return workspaceRecipeRunId;
  return 'run evidence';
}

function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length <= 10 ? value : `${value.slice(0, 8)}…`;
}

function groupArtifacts(
  manifest: ArtifactManifestEntry[],
  gatewayUrl: string,
  runId: string,
  artifactMirrorEpoch: number,
): {
  pairs: VisualArtifactPair[];
  singles: ArtifactManifestEntry[];
} {
  const pairs: VisualArtifactPair[] = [];
  const grouped = groupVisualArtifactPairs(manifest, (artifact) =>
    artifactUrlForEntry(gatewayUrl, runId, artifact, artifactMirrorEpoch),
  );
  pairs.push(...grouped.pairs);
  return { pairs, singles: grouped.singles };
}

function runStatusColor(status: Run['status']): string {
  if (status === 'done') return colors.statusOk;
  if (status === 'failed') return colors.statusFail;
  if (status === 'cancelled') return colors.statusWarn;
  if (status === 'paused') return colors.statusWarn;
  return colors.accent;
}

function RecipeRunPicker({
  groups,
  selectedId,
  onSelect,
}: {
  groups: RecipeRunArtifactGroup[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <View style={styles.recipePicker}>
      <View style={styles.recipePickerHeader}>
        <Text style={styles.recipePickerTitle}>Recipe runs</Text>
        <Text style={styles.recipePickerHint}>Tap a run to scope artifacts</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Pressable
          style={[styles.recipeChip, selectedId === null && styles.recipeChipActive]}
          onPress={() => onSelect(null)}
        >
          <Text style={[styles.recipeChipText, selectedId === null && styles.recipeChipTextActive]}>
            Decision evidence
          </Text>
        </Pressable>
        {groups.map((group) => (
          <Pressable
            key={group.id}
            style={[styles.recipeChip, selectedId === group.id && styles.recipeChipActive]}
            onPress={() => onSelect(group.id)}
          >
            <Text
              style={[
                styles.recipeChipText,
                selectedId === group.id && styles.recipeChipTextActive,
              ]}
              numberOfLines={1}
            >
              {group.label}
            </Text>
            <Text style={styles.recipeChipMeta}>
              {group.status} · {group.artifactManifest?.length ?? 0}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center' },
  listContent: { padding: spacing.xl, paddingBottom: spacing.xxxl * 2 },
  stickyWorkspaceChrome: {
    backgroundColor: colors.bgSurface,
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
    elevation: 10,
    left: 0,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    position: 'absolute',
    right: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 12,
    top: 0,
    zIndex: 20,
  },
  artifactCell: { marginBottom: spacing.md },
  artifactCellLeft: { marginRight: spacing.md },
  header: { marginBottom: spacing.lg },
  primaryWorkspaceNavBlock: {
    marginTop: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  flowBadge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 4,
  },
  flowText: { fontSize: fonts.sizeSm, fontWeight: '600' },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  countText: { color: colors.textMuted, fontSize: fonts.sizeSm },
  refreshButton: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  refreshButtonDisabled: { opacity: 0.6 },
  refreshButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  ticketText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  beforeAfterPriorityPanel: {
    gap: spacing.sm,
    marginTop: spacing.lg,
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
  contextCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: 16,
    borderWidth: 1,
    gap: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  contextHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  contextEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  contextStatusBadge: {
    backgroundColor: colors.statusOk + '22',
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  contextStatusText: {
    color: colors.statusOk,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  contextGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  contextMetric: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    flexBasis: '48%',
    flexGrow: 1,
    padding: spacing.md,
  },
  contextMetricDisabled: {
    opacity: 0.48,
  },
  contextMetricLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  contextMetricValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  artifactCockpitPanel: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '33',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.sm,
  },
  artifactCockpitHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  artifactCockpitTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  artifactCockpitTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  artifactCockpitMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  artifactCockpitPill: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  artifactCockpitPillText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  artifactCockpitRail: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  artifactCockpitTile: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 104,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  artifactCockpitTileActive: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '66',
  },
  artifactCockpitTileLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  artifactCockpitTileLabelActive: {
    color: colors.accent,
  },
  artifactCockpitTileValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  artifactCockpitTileHint: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 2,
    maxWidth: 110,
  },
  artifactProgressPanel: {
    marginTop: spacing.lg,
  },
  artifactCockpitDisabled: {
    opacity: 0.45,
  },
  focusedArtifactPanel: {
    backgroundColor: colors.accent + '12',
    borderColor: colors.accent + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  focusedArtifactHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  focusedArtifactTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  focusedArtifactEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  focusedArtifactPath: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    lineHeight: 18,
    marginTop: spacing.xs,
  },
  focusedArtifactMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  focusedArtifactTypeBadge: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '44',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  focusedArtifactTypeText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  focusedArtifactActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  focusedArtifactAction: {
    backgroundColor: colors.accent + '20',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  focusedArtifactActionDisabled: {
    opacity: 0.45,
  },
  focusedArtifactActionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  focusedArtifactClear: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  focusedArtifactClearText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  recipePicker: {
    backgroundColor: colors.bgCard,
    borderRadius: 16,
    gap: spacing.sm,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  recipePickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  recipePickerTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  recipePickerHint: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  recipeChip: {
    borderWidth: 1,
    borderColor: colors.bgInput,
    borderRadius: 14,
    marginRight: spacing.sm,
    minWidth: 136,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  recipeChipActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  recipeChipText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  recipeChipTextActive: {
    color: colors.accent,
  },
  recipeChipMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: 2,
    textTransform: 'uppercase',
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  stickyFilter: {
    backgroundColor: colors.bgBase,
    borderWidth: 1,
    borderBottomColor: colors.bgCard,
    borderColor: colors.bgCard,
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  stickyFilterCompact: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    marginBottom: spacing.sm,
    paddingBottom: spacing.sm,
    paddingHorizontal: 0,
    paddingTop: 0,
  },
  stickyFilterCompactRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  stickyFilterCompactChips: {
    paddingRight: spacing.sm,
  },
  stickyFilterCompactCount: {
    color: colors.textMuted,
    flexShrink: 0,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  stickyFilterCompactQuery: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  filterTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  filterTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
  filterCount: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  filterChip: {
    borderWidth: 1,
    borderColor: colors.textMuted + '55',
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
  },
  filterChipCompact: {
    marginRight: 0,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
  },
  filterChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent + '22',
  },
  filterText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  filterTextCompact: {
    fontSize: 11,
  },
  filterTextActive: {
    color: colors.accent,
  },
  focusedFilterPill: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  focusedFilterText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  focusedFilterClear: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    padding: spacing.xl,
    textAlign: 'center',
  },
  errorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
  },
});
