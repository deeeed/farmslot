import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
import { DocumentViewer } from '../../components/DocumentViewer';
import { MediaViewer } from '../../components/MediaViewer';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import {
  type ArtifactStickyChromeLayout,
  artifactStickyChromeThreshold,
  artifactStickyChromeVisible,
} from '../../lib/artifact-sticky-chrome';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  classifyArtifact,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  deriveBaselineVisualArtifactPairs,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
  resolveRecipeRunSelection,
} from '../../lib/artifact-url';
import {
  type ArtifactWorkspaceFilter,
  buildArtifactWorkspaceCounts,
  filterArtifactWorkspace,
  isArtifactWorkspaceFilter,
} from '../../lib/artifact-workspace';
import { diffArtifactCandidate } from '../../lib/diff';
import { gatewayFetch } from '../../lib/gateway-http-auth';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { isGatewayBackgroundPauseError } from '../../lib/recoverable-errors';
import { runRefreshEventMatches } from '../../lib/run-refresh';
import { selectSlotRecipeArtifactsForPreviewScope } from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
} from '../../lib/task-progress';
import { baseStyles, spacing } from '../../lib/theme';
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
  targetWorkspaceRouteContextParams,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useRunStore } from '../../store/runs';

import {
  ArtifactHeader,
  ArtifactStickyFilter,
  groupArtifacts,
  recipeRunIdForVisualPair,
  routeParamString,
} from './components/artifact-viewer-panels';
import { artifactViewerStyles as styles } from './styles/artifact-viewer.styles';

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
  const runRefreshRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recipeRunRefreshRequestRef = useRef(0);

  const { recipeRuns, gatewaySelectedRecipeRunId } = recipeRunSelection;

  useEffect(() => {
    return () => {
      documentAbortRef.current?.abort();
      if (runRefreshRetryRef.current) clearTimeout(runRefreshRetryRef.current);
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
        if (isGatewayBackgroundPauseError(err)) {
          // App route transitions can briefly pause the gateway; retry once
          // instead of replacing already-loaded evidence with transient noise.
          console.warn(`Run artifacts refresh paused after ${reason}: ${(err as Error).message}`);
          if (!runRefreshRetryRef.current) {
            runRefreshRetryRef.current = setTimeout(() => {
              runRefreshRetryRef.current = null;
              void refreshRun(`${reason} resume`);
            }, 1200);
          }
          return;
        }
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
        if (isGatewayBackgroundPauseError(err)) {
          // Route screenshot transitions can background the gateway briefly; the
          // current artifact list is still the primary review surface.
          console.warn(`Recipe runs unavailable after ${reason}: ${(err as Error).message}`);
          return;
        }
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
      gatewayFetch(url, artifactAuthHeaders, { signal: controller.signal })
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
